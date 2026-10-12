/**
 * An X server for tests: the handful of requests server/x11.ts sends, answered from a list of
 * windows a test owns. It listens on a unix socket named as a display's is (`X<n>`), so the code
 * under test connects to it exactly as it would to Xvfb.
 */

import { createServer, type Server, type Socket } from "node:net";

export interface FakeWindow {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  className?: string;
  title?: string;
  /** false: created but not shown */
  mapped?: boolean;
  /** true: a menu or a tooltip */
  overrideRedirect?: boolean;
}

const ROOT = 0x21f;
const NET_WM_NAME = 300;
const BAD_WINDOW = 3;

function reply(sequence: number, data: number, head: (body: Buffer) => void, extra: Buffer = Buffer.alloc(0)): Buffer {
  const padded = Buffer.alloc((extra.length + 3) & ~3);
  extra.copy(padded);
  const body = Buffer.alloc(32);
  body.writeUInt8(1, 0);
  body.writeUInt8(data, 1);
  body.writeUInt16LE(sequence, 2);
  body.writeUInt32LE(padded.length / 4, 4);
  head(body);
  return Buffer.concat([body, padded]);
}

function failure(sequence: number, code: number, opcode: number): Buffer {
  const body = Buffer.alloc(32);
  body.writeUInt8(code, 1);
  body.writeUInt16LE(sequence, 2);
  body.writeUInt8(opcode, 10);
  return body;
}

export class FakeX {
  windows: FakeWindow[] = [];
  /** every ConfigureWindow taken, in order */
  readonly moved: Array<{ id: number; x: number; y: number; width: number; height: number }> = [];
  /** the screen's size, asked at each connection: a test changes it as xrandr would */
  size: () => { width: number; height: number } = () => ({ width: 1280, height: 900 });
  /** answers are written in pieces this long, as a slow socket delivers them */
  chunk = 0;
  /** a window that is gone by the time its attributes are asked for */
  vanishing: number | null = null;
  private server: Server | null = null;

  listen(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.serve(socket));
      this.server.once("error", reject);
      this.server.listen(socketPath, resolve);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => { if (this.server) this.server.close(() => resolve()); else resolve(); });
  }

  private write(socket: Socket, data: Buffer): void {
    if (!this.chunk) { socket.write(data); return; }
    for (let at = 0; at < data.length; at += this.chunk) socket.write(data.subarray(at, at + this.chunk));
  }

  private setup(): Buffer {
    const { width, height } = this.size();
    const vendor = Buffer.from("fake!");
    const body = Buffer.alloc(32 + 8 + 8 + 40);
    body.writeUInt16LE(vendor.length, 16);
    body.writeUInt8(1, 20);
    body.writeUInt8(1, 21);
    vendor.copy(body, 32);
    const screen = 32 + 8 + 8;
    body.writeUInt32LE(ROOT, screen);
    body.writeUInt16LE(width, screen + 20);
    body.writeUInt16LE(height, screen + 22);
    const head = Buffer.alloc(8);
    head.writeUInt8(1, 0);
    head.writeUInt16LE(11, 2);
    head.writeUInt16LE(body.length / 4, 6);
    return Buffer.concat([head, body]);
  }

  private serve(socket: Socket): void {
    let pending = Buffer.alloc(0);
    let greeted = false;
    let sequence = 0;
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (!greeted) {
        if (pending.length < 12) return;
        pending = pending.subarray(12);
        greeted = true;
        this.write(socket, this.setup());
      }
      while (pending.length >= 4) {
        const length = pending.readUInt16LE(2) * 4;
        if (pending.length < length) return;
        const request = pending.subarray(0, length);
        pending = pending.subarray(length);
        sequence = (sequence + 1) & 0xffff;
        const answer = this.answer(request, sequence);
        if (answer) this.write(socket, answer);
      }
    });
  }

  private answer(request: Buffer, sequence: number): Buffer | null {
    const opcode = request.readUInt8(0);
    const target = request.length >= 8 ? request.readUInt32LE(4) : 0;
    const window = this.windows.find((entry) => entry.id === target);
    switch (opcode) {
      case 15: {
        const ids = Buffer.alloc(this.windows.length * 4);
        this.windows.forEach((entry, index) => ids.writeUInt32LE(entry.id, index * 4));
        return reply(sequence, 0, (body) => { body.writeUInt32LE(ROOT, 8); body.writeUInt16LE(this.windows.length, 16); }, ids);
      }
      case 16:
        return reply(sequence, 0, (body) => body.writeUInt32LE(request.subarray(8, 8 + request.readUInt16LE(4)).toString() === "_NET_WM_NAME" ? NET_WM_NAME : 0, 8));
      case 3:
        if (!window || target === this.vanishing) return failure(sequence, BAD_WINDOW, opcode);
        return reply(sequence, 0, (body) => {
          body.writeUInt16LE(1, 12);
          body.writeUInt8(window.mapped === false ? 0 : 2, 26);
          body.writeUInt8(window.overrideRedirect ? 1 : 0, 27);
        });
      case 14:
        if (!window) return failure(sequence, BAD_WINDOW, opcode);
        return reply(sequence, 24, (body) => {
          body.writeUInt32LE(ROOT, 8);
          body.writeInt16LE(window.x, 12);
          body.writeInt16LE(window.y, 14);
          body.writeUInt16LE(window.width, 16);
          body.writeUInt16LE(window.height, 18);
        });
      case 20: {
        if (!window) return failure(sequence, BAD_WINDOW, opcode);
        const property = request.readUInt32LE(8);
        const value = property === 67 ? Buffer.from(window.className ? `instance\0${window.className}\0` : "", "latin1")
          : property === NET_WM_NAME ? Buffer.from(window.title ?? "", "utf8") : Buffer.alloc(0);
        return reply(sequence, 8, (body) => body.writeUInt32LE(value.length, 16), value);
      }
      case 12:
        if (!window) return failure(sequence, BAD_WINDOW, opcode);
        Object.assign(window, { x: request.readInt32LE(12), y: request.readInt32LE(16), width: request.readUInt32LE(20), height: request.readUInt32LE(24) });
        this.moved.push({ id: window.id, x: window.x, y: window.y, width: window.width, height: window.height });
        return null;
      case 43:
        return reply(sequence, 0, () => undefined);
      default:
        return failure(sequence, 1, opcode);
    }
  }
}
