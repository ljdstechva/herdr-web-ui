/**
 * Browser view (routes in shared/browser-view.ts): the browsers open on this PC's virtual X
 * displays, streamed with x11vnc and laid out for the device that watches.
 *
 * - A "browser" is a display whose windows include a browser's. Only a display without a window
 *   manager and without an auth cookie is seen (server/x11.ts): that is Xvfb, where agents run
 *   theirs.
 * - A stream is one x11vnc for one connection, on a unix socket in a directory only this user
 *   can enter. It never outlives its connection: `-once` ends it with its viewer, `-timeout`
 *   ends one nobody reached, and `close()` kills it.
 * - The phone layout resizes the display itself (xrandr) and then the browser's window to fill
 *   it, so pages reflow and menus stay on screen. What was there before is written to
 *   `browser-view.json` first and put back when the last viewer has been gone for
 *   `restoreAfterMs`, on `stop()`, or by the next server if this one died in between.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MIN_PHONE_SIZE, type BrowserInfo, type BrowserLayoutRequest } from "../shared/browser-view.ts";
import { displaySocketPath, withDisplay, type X11Rect, type X11Window } from "./x11.ts";

/** WM_CLASS of the browsers an agent or a person may have open */
const BROWSER_CLASS = /chrom|firefox|navigator|brave|vivaldi|opera|msedge|microsoft-edge|epiphany|librewolf/i;
/** a browser's own helper windows (its clipboard, a 10x10 probe) are smaller than any real one */
const MIN_WINDOW_SIZE = 200;
/** the modes this server adds to a display are named so, and only those are ever removed */
const MODE_PREFIX = "herdr-";
const TITLE_SUFFIX = /\s[-—]\s(?:Google Chrome for Testing|Google Chrome|Chromium|Mozilla Firefox|Brave|Microsoft Edge)\s*$/;
const INSPECT_TIMEOUT_MS = 1500;
const COMMAND_TIMEOUT_MS = 4000;
const STREAM_START_MS = 5000;
const KILL_AFTER_MS = 2000;

export class BrowserViewError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "BrowserViewError";
  }
}

export interface BrowserViewsOptions {
  stateDir: string;
  /** the two programs' paths, null for "not installed"; unset, they are looked up on PATH */
  x11vnc?: string | null;
  xrandr?: string | null;
  /** where X displays keep their sockets */
  socketDirectory?: string;
  /** how long a phone layout outlives its last viewer: a phone that locks reconnects within it */
  restoreAfterMs?: number;
}

export interface BrowserStreamSink {
  /** bytes from the display; false asks for no more until `resume()` */
  data(chunk: Uint8Array): boolean;
  /** the display's stream ended on its own */
  end(): void;
}

export interface BrowserStream {
  write(data: Uint8Array): void;
  resume(): void;
  close(): void;
}

interface SavedLayout {
  /** the display's mode before the phone layout */
  mode: string;
  /** the browser window and where it was, null when it had none */
  window: (X11Rect & { id: number }) | null;
}

interface Seen {
  id: string;
  width: number;
  height: number;
  windows: X11Window[];
  front: X11Window | null;
}

export interface XrandrState {
  output: string;
  /** the mode in use */
  mode: string;
  modes: string[];
  max: { width: number; height: number };
}

/** The topmost browser window: a display lists its windows lowest first. */
export function frontBrowser(windows: readonly X11Window[]): X11Window | null {
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    const window = windows[index]!;
    if (BROWSER_CLASS.test(window.className) && window.width >= MIN_WINDOW_SIZE && window.height >= MIN_WINDOW_SIZE) return window;
  }
  return null;
}

/** The page's title without the browser's own name after it. */
export function displayTitle(title: string): string {
  return title.replace(TITLE_SUFFIX, "").trim() || title.trim();
}

/** What `xrandr --query` says of a display's first connected output; null when it names none. */
export function parseXrandr(text: string): XrandrState | null {
  const max = /maximum (\d+) x (\d+)/.exec(text);
  let output: string | null = null;
  let mode: string | null = null;
  const modes: string[] = [];
  for (const line of text.split("\n")) {
    if (output === null) {
      output = /^(\S+) connected/.exec(line)?.[1] ?? null;
      continue;
    }
    // the output's modes are the indented lines under it: "   1280x900       0.00* "
    const entry = /^\s+(\S+)\s+(.*)$/.exec(line);
    if (!entry) break;
    modes.push(entry[1]!);
    if (entry[2]!.includes("*")) mode = entry[1]!;
  }
  if (!max || output === null || mode === null) return null;
  return { output, mode, modes, max: { width: Number(max[1]), height: Number(max[2]) } };
}

/** The display size a phone layout gets: what was asked, whole pixels, within what the display can be. */
export function phoneSize(request: { width: number; height: number }, max: { width: number; height: number }): { width: number; height: number } {
  const fit = (value: number, limit: number): number => Math.max(Math.min(MIN_PHONE_SIZE, limit), Math.min(limit, Math.round(value)));
  return { width: fit(request.width, max.width), height: fit(request.height, max.height) };
}

function fills(window: X11Rect, width: number, height: number): boolean {
  return window.x === 0 && window.y === 0 && window.width === width && window.height === height;
}

export class BrowserViews {
  /** false where this cannot work at all: the routes then answer 404 and the app shows nothing */
  readonly available: boolean;
  private readonly x11vnc: string | null;
  private readonly xrandr: string | null;
  private readonly socketDirectory: string;
  private readonly restoreAfterMs: number;
  private readonly stateFile: string;
  private readonly saved = new Map<string, SavedLayout>();
  private readonly viewers = new Map<string, Set<BrowserStream>>();
  private readonly restoreTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** one layout change per display at a time */
  private readonly queues = new Map<string, Promise<unknown>>();
  private listing: Promise<BrowserInfo[]> | null = null;
  private runDirectory: string | null = null;
  private stopped = false;

  constructor(private readonly options: BrowserViewsOptions) {
    this.x11vnc = options.x11vnc === undefined ? Bun.which("x11vnc") : options.x11vnc;
    this.xrandr = options.xrandr === undefined ? Bun.which("xrandr") : options.xrandr;
    this.socketDirectory = options.socketDirectory ?? "/tmp/.X11-unix";
    this.restoreAfterMs = options.restoreAfterMs ?? 20_000;
    this.stateFile = join(options.stateDir, "browser-view.json");
    this.available = process.platform === "linux" && this.x11vnc !== null;
    if (!this.available) return;
    this.load();
    // a server that died while a phone watched left its display phone-sized
    for (const id of this.saved.keys()) this.scheduleRestore(id);
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as { displays?: Record<string, SavedLayout> };
      for (const [id, layout] of Object.entries(parsed.displays ?? {})) {
        if (/^\d{1,4}$/.test(id) && typeof layout?.mode === "string") this.saved.set(id, { mode: layout.mode, window: layout.window ?? null });
      }
    } catch {
      // no file yet, or one that cannot be read: nothing to put back
    }
  }

  private persist(): void {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ displays: Object.fromEntries(this.saved) })}\n`, { mode: 0o600 });
    renameSync(temporary, this.stateFile);
  }

  private displayIds(): string[] {
    try {
      return readdirSync(this.socketDirectory)
        .map((name) => /^X(\d{1,4})$/.exec(name)?.[1])
        .filter((id): id is string => id !== undefined)
        .sort((a, b) => Number(a) - Number(b));
    } catch {
      return [];
    }
  }

  private socketOf(id: string): string {
    return displaySocketPath(id, this.socketDirectory);
  }

  private inspect(id: string): Promise<Seen> {
    return withDisplay(this.socketOf(id), async (display) => {
      const windows = await display.topLevelWindows();
      const front = frontBrowser(windows);
      // a browser that reopened while a phone watches comes up at its own size: make it fill the display again
      if (front && this.saved.has(id) && !fills(front, display.width, display.height)) {
        const rect = { x: 0, y: 0, width: display.width, height: display.height };
        await display.moveResize(front.id, rect);
        Object.assign(front, rect);
      }
      return { id, width: display.width, height: display.height, windows, front };
    }, INSPECT_TIMEOUT_MS);
  }

  private info(seen: Seen & { front: X11Window }): BrowserInfo {
    return {
      id: seen.id,
      title: displayTitle(seen.front.title),
      layout: this.saved.has(seen.id) ? "phone" : "desktop",
      width: seen.width,
      height: seen.height,
      phone_layout: this.xrandr !== null,
    };
  }

  /** Every display that shows a browser window now. A display that cannot be asked is left out. */
  list(): Promise<BrowserInfo[]> {
    this.listing ??= (async () => {
      const seen = await Promise.all(this.displayIds().map((id) => this.inspect(id).catch(() => null)));
      const browsers: BrowserInfo[] = [];
      for (const display of seen) {
        if (!display) continue;
        if (display.front) browsers.push(this.info({ ...display, front: display.front }));
        // its browser closed while phone-sized and nobody watches: the display goes back
        else if (this.saved.has(display.id) && !this.viewers.get(display.id)?.size) this.scheduleRestore(display.id);
      }
      return browsers;
    })().finally(() => { this.listing = null; });
    return this.listing;
  }

  private serial<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(id) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => undefined);
    this.queues.set(id, settled);
    void settled.then(() => { if (this.queues.get(id) === settled) this.queues.delete(id); });
    return run;
  }

  private async run(id: string, args: string[]): Promise<string> {
    const child = Bun.spawn([this.xrandr!, "--display", `:${id}`, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    try {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(err.trim().split("\n")[0] || `xrandr exited with ${code}`);
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  private async dropModes(id: string, state: XrandrState, keep: string): Promise<void> {
    for (const mode of state.modes) {
      if (!mode.startsWith(MODE_PREFIX) || mode === keep) continue;
      await this.run(id, ["--delmode", state.output, mode]).catch(() => undefined);
      await this.run(id, ["--rmmode", mode]).catch(() => undefined);
    }
  }

  /** Lays the browser out for the device that asks. `desktop` only undoes a phone layout: it never moves a window on its own. */
  setLayout(id: string, request: BrowserLayoutRequest): Promise<BrowserInfo> {
    return this.serial(id, async () => {
      if (this.stopped) throw new BrowserViewError(503, "stopping", "The server is stopping");
      const seen = await this.inspect(id).catch(() => null);
      if (!seen?.front) throw new BrowserViewError(404, "browser_not_found", "No browser is open on this display");
      if (request.layout === "desktop") await this.restore(id);
      else await this.phone(id, seen.front, request);
      // a layout nobody ends up watching (the app closed before its stream opened) is put back too
      if (this.saved.has(id) && !this.viewers.get(id)?.size) this.scheduleRestore(id);
      const after = await this.inspect(id).catch(() => null);
      if (!after?.front) throw new BrowserViewError(404, "browser_not_found", "The browser closed");
      return this.info({ ...after, front: after.front });
    });
  }

  private async phone(id: string, front: X11Window, request: { width: number; height: number }): Promise<void> {
    if (!this.xrandr) throw new BrowserViewError(409, "layout_unavailable", "This server has no xrandr to resize the display with");
    const state = parseXrandr(await this.run(id, ["--query"]).catch(() => ""));
    if (!state) throw new BrowserViewError(409, "layout_unavailable", "This display cannot be resized");
    const size = phoneSize(request, state.max);
    const mode = `${MODE_PREFIX}${size.width}x${size.height}`;
    const first = !this.saved.has(id);
    if (first) {
      // written before anything moves, so whatever happens next can be undone
      this.saved.set(id, { mode: state.mode, window: { id: front.id, x: front.x, y: front.y, width: front.width, height: front.height } });
      this.persist();
    }
    if (state.mode !== mode) {
      if (!state.modes.includes(mode)) {
        const { width: w, height: h } = size;
        // refused when the server already knows the name (left by an earlier run): adding it below is what counts
        await this.run(id, ["--newmode", mode, "0", `${w}`, `${w}`, `${w}`, `${w}`, `${h}`, `${h}`, `${h}`, `${h}`]).catch(() => undefined);
        await this.run(id, ["--addmode", state.output, mode]).catch(() => undefined);
      }
      try {
        await this.run(id, ["--output", state.output, "--mode", mode]);
      } catch (error) {
        if (first) { this.saved.delete(id); this.persist(); }
        throw new BrowserViewError(409, "layout_unavailable", `This display cannot be resized: ${error instanceof Error ? error.message : String(error)}`);
      }
      await this.dropModes(id, state, mode);
    }
    await withDisplay(this.socketOf(id), (display) => display.moveResize(front.id, { x: 0, y: 0, ...size }), INSPECT_TIMEOUT_MS);
  }

  /** Puts the display and the browser's window back to what they were before the phone layout. */
  private async restore(id: string): Promise<void> {
    const saved = this.saved.get(id);
    if (!saved) return;
    if (!existsSync(this.socketOf(id))) {
      // the display itself is gone, and with it everything there was to put back
      this.saved.delete(id);
      this.persist();
      return;
    }
    const state = this.xrandr ? parseXrandr(await this.run(id, ["--query"])) : null;
    if (state && state.mode !== saved.mode) await this.run(id, ["--output", state.output, "--mode", saved.mode]);
    this.saved.delete(id);
    this.persist();
    if (saved.window) {
      const { id: windowId, ...rect } = saved.window;
      await withDisplay(this.socketOf(id), async (display) => {
        const windows = await display.topLevelWindows();
        // the same window, or the one a restarted browser opened in its place
        const target = windows.find((window) => window.id === windowId) ?? frontBrowser(windows);
        if (target) await display.moveResize(target.id, rect);
      }, INSPECT_TIMEOUT_MS).catch(() => undefined);
    }
    if (state) await this.dropModes(id, state, saved.mode);
  }

  private scheduleRestore(id: string): void {
    if (this.stopped || this.restoreTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.restoreTimers.delete(id);
      if (this.viewers.get(id)?.size) return;
      this.serial(id, () => this.restore(id)).catch((error) => console.error(`[browser-view] display :${id} was not put back: ${error instanceof Error ? error.message : String(error)}`));
    }, this.restoreAfterMs);
    timer.unref?.();
    this.restoreTimers.set(id, timer);
  }

  private cancelRestore(id: string): void {
    const timer = this.restoreTimers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.restoreTimers.delete(id);
  }

  private runDir(): string {
    this.runDirectory ??= mkdtempSync(join(tmpdir(), "herdr-web-ui-browser-"));
    return this.runDirectory;
  }

  /** Starts a display's stream. Rejects when no browser is open there or x11vnc does not come up. */
  async open(id: string, sink: BrowserStreamSink): Promise<BrowserStream> {
    if (!this.available || this.stopped) throw new BrowserViewError(404, "not_available", "The browser view is not available on this server");
    const seen = /^\d{1,4}$/.test(id) ? await this.inspect(id).catch(() => null) : null;
    if (!seen?.front) throw new BrowserViewError(404, "browser_not_found", "No browser is open on this display");

    const socketPath = join(this.runDir(), `${randomBytes(8).toString("hex")}.sock`);
    // -noxdamage: as this host's own x11vnc service runs it; Chromium's output is missed without it
    const child = Bun.spawn([this.x11vnc!, "-display", `:${id}`, "-unixsock", socketPath, "-rfbport", "0", "-nopw", "-once", "-timeout", "20",
      "-xrandr", "-noxdamage", "-norc", "-noremote", "-nosel", "-nobell", "-quiet"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let exited = false;
    void child.exited.then(() => { exited = true; });
    const kill = (): void => {
      if (exited) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, KILL_AFTER_MS);
      timer.unref?.();
      void child.exited.then(() => clearTimeout(timer));
    };

    const deadline = Date.now() + STREAM_START_MS;
    while (!existsSync(socketPath)) {
      if (exited || Date.now() > deadline) {
        kill();
        throw new BrowserViewError(502, "stream_failed", exited ? `x11vnc exited with code ${child.exitCode}` : "x11vnc did not start in time");
      }
      await Bun.sleep(50);
    }

    const socket = connect({ path: socketPath });
    let closed = false;
    const stream: BrowserStream = {
      write: (data) => { if (!closed) socket.write(data); },
      resume: () => { if (!closed) socket.resume(); },
      close: () => {
        if (closed) return;
        closed = true;
        socket.destroy();
        kill();
        rmSync(socketPath, { force: true });
        const viewers = this.viewers.get(id);
        viewers?.delete(stream);
        if (!viewers?.size) {
          this.viewers.delete(id);
          if (this.saved.has(id)) this.scheduleRestore(id);
        }
      },
    };
    let set = this.viewers.get(id);
    if (!set) this.viewers.set(id, set = new Set());
    set.add(stream);
    this.cancelRestore(id);
    socket.on("data", (chunk: Buffer) => { if (!closed && !sink.data(chunk)) socket.pause(); });
    const ended = (): void => {
      if (closed) return;
      stream.close();
      sink.end();
    };
    socket.on("error", ended);
    socket.on("close", ended);
    void child.exited.then(ended);
    return stream;
  }

  /** Ends every stream and puts every phone-sized display back. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    for (const viewers of [...this.viewers.values()]) for (const stream of [...viewers]) stream.close();
    this.stopped = true;
    for (const id of [...this.restoreTimers.keys()]) this.cancelRestore(id);
    await Promise.all([...this.saved.keys()].map((id) => this.serial(id, () => this.restore(id)).catch(() => undefined)));
    if (this.runDirectory) rmSync(this.runDirectory, { recursive: true, force: true });
  }
}
