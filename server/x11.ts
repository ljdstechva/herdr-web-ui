/**
 * The few X11 requests the browser view needs (server/browser-view.ts): which windows a display
 * shows, and moving one. Spoken directly over the display's unix socket, one request at a time:
 * moving a window is a single ConfigureWindow, and the hosts this runs on have no xdotool.
 *
 * Only a display that takes a local connection without a cookie is reached, which is how Xvfb
 * runs when nothing passed it `-auth`.
 */

import { connect, type Socket } from "node:net";

export interface X11Rect { x: number; y: number; width: number; height: number }

export interface X11Window extends X11Rect {
  id: number;
  /** the second string of WM_CLASS ("Chromium-browser"), or "" */
  className: string;
  title: string;
}

export class X11Error extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "X11Error";
  }
}

/** core opcodes and predefined atoms (X11 protocol, appendix B) */
const OP = { getWindowAttributes: 3, configureWindow: 12, getGeometry: 14, queryTree: 15, internAtom: 16, getProperty: 20, getInputFocus: 43 } as const;
const ATOM_WM_NAME = 39;
const ATOM_WM_CLASS = 67;
const MAP_VIEWABLE = 2;
const CLASS_INPUT_OUTPUT = 1;
/** x, y, width and height of ConfigureWindow's value mask */
const CONFIGURE_GEOMETRY = 0x0f;
/** the longest property read, in 4-byte units: a title is cut here */
const PROPERTY_UNITS = 256;

export function displaySocketPath(display: string, directory = "/tmp/.X11-unix"): string {
  return `${directory}/X${display}`;
}

/** The connection setup of a little-endian client that presents no authorization. */
export function setupRequest(): Buffer {
  const request = Buffer.alloc(12);
  request.writeUInt8(0x6c, 0);
  request.writeUInt16LE(11, 2);
  return request;
}

/** `data` is the request's second byte; the body is padded to 4 bytes as the protocol requires. */
export function encodeRequest(opcode: number, data: number, body: Buffer): Buffer {
  const padded = (body.length + 3) & ~3;
  const request = Buffer.alloc(4 + padded);
  request.writeUInt8(opcode, 0);
  request.writeUInt8(data, 1);
  request.writeUInt16LE(request.length / 4, 2);
  body.copy(request, 4);
  return request;
}

export function configureWindowRequest(window: number, rect: X11Rect): Buffer {
  const body = Buffer.alloc(24);
  body.writeUInt32LE(window, 0);
  body.writeUInt16LE(CONFIGURE_GEOMETRY, 4);
  body.writeInt32LE(rect.x, 8);
  body.writeInt32LE(rect.y, 12);
  body.writeUInt32LE(rect.width, 16);
  body.writeUInt32LE(rect.height, 20);
  return encodeRequest(OP.configureWindow, 0, body);
}

/** The root window and size of the first screen, from a whole setup reply (its 8-byte head included). */
export function parseSetup(data: Buffer): { root: number; width: number; height: number } {
  const vendorLength = data.readUInt16LE(24);
  const formats = data.readUInt8(29);
  const screen = 40 + ((vendorLength + 3) & ~3) + formats * 8;
  if (data.readUInt8(28) < 1 || data.length < screen + 24) throw new X11Error(0, "the X server announced no screen");
  return { root: data.readUInt32LE(screen), width: data.readUInt16LE(screen + 20), height: data.readUInt16LE(screen + 22) };
}

/** WM_CLASS is "instance\0class\0": the class names the program, the instance may carry its profile. */
export function classOf(value: Buffer): string {
  return value.toString("latin1").split("\0")[1] ?? "";
}

/** Bytes as they arrive, handed out in the sizes the protocol frames them in. */
class Reader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private waiting: { size: number; resolve(data: Buffer): void; reject(error: Error): void } | null = null;
  private failure: Error | null = null;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.settle();
  }

  fail(error: Error): void {
    this.failure ??= error;
    this.settle();
  }

  take(size: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiting = { size, resolve, reject };
      this.settle();
    });
  }

  private settle(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    if (this.buffered >= waiting.size) {
      const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
      this.chunks = all.length > waiting.size ? [all.subarray(waiting.size)] : [];
      this.buffered = all.length - waiting.size;
      this.waiting = null;
      waiting.resolve(all.subarray(0, waiting.size));
    } else if (this.failure) {
      this.waiting = null;
      waiting.reject(this.failure);
    }
  }
}

export class X11Connection {
  root = 0;
  width = 0;
  height = 0;
  private sequence = 0;
  private readonly reader = new Reader();

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.reader.push(chunk));
    socket.on("error", (error) => this.reader.fail(error));
    socket.on("close", () => this.reader.fail(new X11Error(0, "the X server closed the connection")));
  }

  static async open(socketPath: string, timeoutMs: number): Promise<X11Connection> {
    const socket = connect({ path: socketPath });
    const connection = new X11Connection(socket);
    // one deadline for everything asked of this connection: an X server that stops answering
    // (a display being torn down) fails the read instead of holding its caller
    socket.setTimeout(timeoutMs, () => socket.destroy(new X11Error(0, "the X server did not answer in time")));
    try {
      socket.write(setupRequest());
      const head = await connection.reader.take(8);
      const rest = await connection.reader.take(head.readUInt16LE(6) * 4);
      if (head.readUInt8(0) !== 1) {
        const reason = rest.subarray(0, head.readUInt8(1)).toString("latin1").trim();
        throw new X11Error(0, reason || "the X server refused the connection");
      }
      Object.assign(connection, parseSetup(Buffer.concat([head, rest])));
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  close(): void {
    this.socket.destroy();
  }

  private send(request: Buffer): number {
    this.socket.write(request);
    this.sequence = (this.sequence + 1) & 0xffff;
    return this.sequence;
  }

  /** The reply to the request numbered `sequence`; an error for it, or for one sent before it, throws. Events are passed over. */
  private async reply(sequence: number): Promise<Buffer> {
    for (;;) {
      const head = await this.reader.take(32);
      const kind = head.readUInt8(0);
      if (kind === 0) throw new X11Error(head.readUInt8(1), `X request ${head.readUInt8(10)} failed with error ${head.readUInt8(1)}`);
      if (kind !== 1) continue;
      const extra = head.readUInt32LE(4) * 4;
      const body = extra ? Buffer.concat([head, await this.reader.take(extra)]) : head;
      if (head.readUInt16LE(2) === sequence) return body;
    }
  }

  private ask(opcode: number, data: number, body: Buffer): Promise<Buffer> {
    return this.reply(this.send(encodeRequest(opcode, data, body)));
  }

  private static id(value: number): Buffer {
    const body = Buffer.alloc(4);
    body.writeUInt32LE(value, 0);
    return body;
  }

  private async atom(name: string): Promise<number> {
    const body = Buffer.alloc(4 + name.length);
    body.writeUInt16LE(name.length, 0);
    body.write(name, 4, "latin1");
    // only-if-exists: a name no client ever used answers None instead of creating the atom
    return (await this.ask(OP.internAtom, 1, body)).readUInt32LE(8);
  }

  private async property(window: number, property: number): Promise<Buffer> {
    const body = Buffer.alloc(20);
    body.writeUInt32LE(window, 0);
    body.writeUInt32LE(property, 4);
    body.writeUInt32LE(PROPERTY_UNITS, 16);
    const reply = await this.ask(OP.getProperty, 0, body);
    const length = reply.readUInt32LE(16) * (reply.readUInt8(1) / 8);
    return reply.subarray(32, 32 + length);
  }

  /**
   * The mapped windows directly under the root, lowest first. Without a window manager those are
   * the applications' own windows; under one they are its frames, which carry no class.
   */
  async topLevelWindows(): Promise<X11Window[]> {
    const tree = await this.ask(OP.queryTree, 0, X11Connection.id(this.root));
    const count = tree.readUInt16LE(16);
    const netName = await this.atom("_NET_WM_NAME");
    const windows: X11Window[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = tree.readUInt32LE(32 + index * 4);
      try {
        const attributes = await this.ask(OP.getWindowAttributes, 0, X11Connection.id(id));
        // a menu or a tooltip (override-redirect) is drawn over a window, it is not one to offer
        if (attributes.readUInt16LE(12) !== CLASS_INPUT_OUTPUT || attributes.readUInt8(26) !== MAP_VIEWABLE || attributes.readUInt8(27) !== 0) continue;
        const geometry = await this.ask(OP.getGeometry, 0, X11Connection.id(id));
        const className = classOf(await this.property(id, ATOM_WM_CLASS));
        const utf8 = netName ? await this.property(id, netName) : Buffer.alloc(0);
        const title = utf8.length ? utf8.toString("utf8") : (await this.property(id, ATOM_WM_NAME)).toString("latin1");
        windows.push({ id, x: geometry.readInt16LE(12), y: geometry.readInt16LE(14), width: geometry.readUInt16LE(16), height: geometry.readUInt16LE(18), className, title });
      } catch (error) {
        // a window closed between the tree and its own answers
        if (error instanceof X11Error && error.code !== 0) continue;
        throw error;
      }
    }
    return windows;
  }

  /** Moves and sizes a window, and waits for the server to have taken the request. */
  async moveResize(window: number, rect: X11Rect): Promise<void> {
    this.send(configureWindowRequest(window, rect));
    await this.ask(OP.getInputFocus, 0, Buffer.alloc(0));
  }
}

/** Runs `use` on a fresh connection to the display and closes it, whatever happens. */
export async function withDisplay<T>(socketPath: string, use: (connection: X11Connection) => Promise<T>, timeoutMs = 3000): Promise<T> {
  const connection = await X11Connection.open(socketPath, timeoutMs);
  try {
    return await use(connection);
  } finally {
    connection.close();
  }
}
