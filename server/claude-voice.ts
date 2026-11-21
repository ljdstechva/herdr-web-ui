/**
 * Claude Code's own dictation, from the phone's microphone (WebSocket /api/voice/claude/stream).
 *
 * Claude Code (2.1.32x, Linux) records voice by running `arecord -f S16_LE -r 16000 -c 1 -t raw
 * -q -` and streams what it prints to the claude.ai voice service under its own login; the words
 * appear in its message box as they are recognised. A server has no microphone, so
 * scripts/claude-voice/arecord, linked as ~/.local/bin/arecord, stands in for the recorder: it
 * connects to this server's unix socket in `voiceDir()`, names the pane it runs in
 * (HERDR_PANE_ID) and prints the audio this server hands it. The transcription is Claude Code's,
 * made by Claude Code; this server only carries the sound and reads the box.
 *
 * A take: the phone opens the socket for a Claude pane and streams 16 kHz mono 16-bit frames. The
 * server checks that the box is empty and that nothing waits for an answer, taps Space (voice
 * mode "tap": Space with the box empty starts listening, `/voice tap` turns it on), passes the
 * frames on once Claude Code starts the recorder, and sends back the words Claude Code writes in
 * its box. At the finish the service hears a second of silence so the last words settle, Esc
 * stops the recording and empties the box (on 2.1.328 that Esc never reaches a running turn) and
 * the words go to the phone. Nothing is submitted: the composer gets the words to edit and send.
 * A take nobody speaks into for ten seconds finishes the same way by itself (SILENCE_FINISH_MS).
 *
 * The box is ten rows high. A dictation longer than that scrolls in it (`─── ↑ 7 more ───` in
 * place of the rule above), on a phone's narrow pane after half a minute: BoxTranscript keeps the
 * rows that left the screen, so the words are whole however long the dictation was.
 *
 * Asked to (ClaudeVoiceOptions.polish), the take then has the words rebuilt (claude-rebuild.ts):
 * the commas and full stops Claude Code's voice mode puts at every pause are joined back into
 * sentences. The raw words are sent first; the rebuilt ones follow as `polished`.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { rebuildKeywords, type RebuildJob, type Rebuilder } from "./claude-rebuild.ts";
import { claudeInputBoxRows, claudeInputBoxUnderRule, claudeInputEmpty } from "./prompt.ts";
import { CLAUDE_VOICE_SAMPLE_RATE, type ClaudeVoiceErrorCode, type ClaudeVoiceEvent, type ClaudeVoiceOptions, type ClaudeVoiceStatus } from "../shared/claude-voice.ts";

const BYTES_PER_SECOND = CLAUDE_VOICE_SAMPLE_RATE * 2;
/** a tenth of a second of audio */
const CHUNK_BYTES = BYTES_PER_SECOND / 10;
/** Claude Code stops by itself at two minutes; the take finishes a little before */
export const CLAUDE_VOICE_MAX_MS = 115_000;
/**
 * Claude Code ends a recording by itself after 15 s without speech, and in tap mode it then SENDS
 * what it heard (three words or more; measured on 2.1.330). A take therefore ends itself first,
 * the way a finish does: no new word for this long, then the settling, then the Esc, all well
 * inside those 15 s. The words go to the composer; nothing is sent.
 */
const SILENCE_FINISH_MS = 10_000;
/** from the Space to Claude Code starting the recorder (about 0.4 s on 2.1.328) */
const RECORDER_WAIT_MS = 4_000;
const POLL_MS = 400;
/** the box is read this often once the phone finished, so the last words are not waited for longer than they take */
const SETTLE_POLL_MS = 200;
/** silence the service hears after the last word, so it settles them */
const SETTLE_SILENCE_MS = 1_000;
/** the box unchanged this long, after the silence, holds the final words */
const SETTLE_STABLE_MS = 700;
const SETTLE_MAX_MS = 7_000;
/** after the Esc, the recording mark leaves the screen within this (0.15 s on 2.1.330) */
const CLEAR_WAIT_MS = 2_000;
const CLEAR_POLL_MS = 100;
/** audio kept while Claude Code starts its recorder; older audio is dropped first */
const BUFFER_MAX_BYTES = BYTES_PER_SECOND * 10;
const HELLO_MAX_BYTES = 1024;
/** Claude Code's marks at the caret while it listens: the level meter (▁…█) */
const LEVEL_MARK_RE = /[▁-█]$/u;
/** the box's top-right while recording (`● REC · tap to send`) or settling (`listening…`) */
const RECORDING_RE = /\bREC\b.*tap to send|listening…/;
/** the rule above a box whose text scrolled: the rows above the ones on screen */
const SCROLLED_RULE_RE = /^─+ ↑ (\d+) more ─+$/;
export const CLAUDE_VOICE_MARKER = "herdr-web-ui claude voice recorder";
const TIMING = { recorderWait: RECORDER_WAIT_MS, silence: SILENCE_FINISH_MS, poll: POLL_MS, settlePoll: SETTLE_POLL_MS, settleSilence: SETTLE_SILENCE_MS, settleStable: SETTLE_STABLE_MS, settleMax: SETTLE_MAX_MS, clearWait: CLEAR_WAIT_MS, clearPoll: CLEAR_POLL_MS, max: CLAUDE_VOICE_MAX_MS };

export function voiceDir(env: Record<string, string | undefined> = process.env): string {
  return env["HERDR_WEB_UI_VOICE_DIR"] || join(homedir(), ".local", "state", "herdr-web-ui", "voice");
}

export type { ClaudeVoiceErrorCode, ClaudeVoiceEvent, ClaudeVoiceStatus };

/** The words in Claude Code's message box: its rows joined, without the `❯`, the caret's level meter or the drawn cursor. Null with no box. */
export function claudeBoxWords(screen: string): string | null {
  const rows = claudeInputBoxRows(screen);
  if (rows === null || !rows[0]?.startsWith("❯")) return null;
  const words = rows.map((row, index) => (index === 0 ? row.slice(1) : row).replace(/ /g, " ").trim()).filter(Boolean).join(" ");
  return words.replace(LEVEL_MARK_RE, "").trim();
}

/** The rows of Claude Code's message box on one screen, and how many rows of its text scrolled out above them. */
export interface ClaudeBoxView {
  above: number;
  /** the rows as drawn, without the `❯`, the caret's level meter or the drawn cursor; a blank row stays, so a row keeps its place */
  rows: string[];
  /** the box's width in columns: another width means the text was wrapped anew */
  width: number;
}

/** Claude Code's message box, whole or scrolled (`─── ↑ 7 more ───` above its rows). Null with no box, or one that is no `❯` input. */
export function claudeBoxView(screen: string): ClaudeBoxView | null {
  const box = claudeInputBoxUnderRule(screen);
  if (box === null) return null;
  const scrolled = SCROLLED_RULE_RE.exec(box.rule);
  if (!scrolled && !box.rows[0]?.startsWith("❯")) return null;
  const rows = box.rows.map((row, index) => (!scrolled && index === 0 ? row.slice(1) : row).replace(/\u00a0/g, " ").trim());
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index] === "") continue;
    rows[index] = rows[index]!.replace(LEVEL_MARK_RE, "").trim();
    break;
  }
  return { above: scrolled ? Number(scrolled[1]) : 0, rows, width: [...box.rule].length };
}

const joinRows = (rows: readonly string[]): string => rows.filter(Boolean).join(" ");

/**
 * A dictation as Claude Code's box showed it over time. The box keeps ten rows and scrolls, so
 * each read shows the end of the text and says how many rows are above it: those are the rows an
 * earlier read saw in their place. Only words still being recognised change, and they are the
 * last ones, so a row that left the screen is final.
 */
export class BoxTranscript {
  private rows: string[] = [];
  private width = 0;

  /** One read of the box; answers the whole dictation so far. */
  read(view: ClaudeBoxView): string {
    if (view.above === 0) this.rows = [...view.rows];
    else if (view.width === this.width && this.rows.length >= view.above) this.rows = [...this.rows.slice(0, view.above), ...view.rows];
    else this.rows = [this.before(view), ...new Array<string>(view.above - 1).fill(""), ...view.rows];
    this.width = view.width;
    return joinRows(this.rows);
  }

  /**
   * The pane changed its width while the box was scrolled (every row wrapped anew), or rows left
   * the screen unread: the text before the rows on screen is what was known, up to where the
   * first row on screen begins in it. Kept as one row, so the rows after it keep their places.
   */
  private before(view: ClaudeBoxView): string {
    const known = joinRows(this.rows);
    const shown = joinRows(view.rows);
    for (let length = Math.min(shown.length, 48); length >= 12; length -= 6) {
      const at = known.lastIndexOf(shown.slice(0, length));
      if (at >= 0) return known.slice(0, at).trim();
    }
    return known;
  }
}

/** Claude Code's voice settings for this user (`/voice` writes them to ~/.claude/settings.json). */
export function claudeVoiceSettings(home = homedir()): ClaudeVoiceStatus["voice"] {
  try {
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
    const voice = typeof settings["voice"] === "object" && settings["voice"] !== null ? settings["voice"] as Record<string, unknown> : {};
    const enabled = voice["enabled"] === true || (voice["enabled"] === undefined && settings["voiceEnabled"] === true);
    const mode = voice["mode"] === "tap" || voice["mode"] === "hold" ? voice["mode"] : enabled ? "hold" : null;
    return { enabled, mode };
  } catch {
    return { enabled: false, mode: null };
  }
}

/** Whether ~/.local/bin/arecord, where install.sh links it, is the stand-in (HERDR_WEB_UI_VOICE_RECORDER names another copy, for tests). */
export function claudeRecorderInstalled(home = homedir(), env: Record<string, string | undefined> = process.env): boolean {
  try {
    return readFileSync(env["HERDR_WEB_UI_VOICE_RECORDER"] || join(home, ".local", "bin", "arecord"), "utf8").includes(CLAUDE_VOICE_MARKER);
  } catch {
    return false;
  }
}

export interface ClaudeVoiceDeps {
  /** the folder of the recorders' sockets, and this server's socket's name in it */
  dir: string;
  name: string;
  pane(paneId: string): Promise<{ agent: string | null; status: string }>;
  /** the live screen and its verified colors, as the chat send reads Claude's box */
  boxReads(paneId: string): Promise<[string, string | null]>;
  /** the visible screen, as text */
  screen(paneId: string): Promise<string>;
  keys(paneId: string, keys: string[]): Promise<void>;
  /** a question, approval or list waits on this screen */
  blocked(screen: string): boolean;
  settings(): ClaudeVoiceStatus["voice"];
  recorderInstalled(): boolean;
  /** starts the program that rebuilds a dictation's words (claude-rebuild.ts); unset, no take is rebuilt */
  rebuild?: Rebuilder;
  sleep?(ms: number): Promise<void>;
  /** shorter waits, for tests */
  timing?: Partial<typeof TIMING>;
}

export interface ClaudeVoiceTake {
  audio(chunk: Uint8Array): void;
  /** what the phone asks of this take; read until its words are final */
  options(options: ClaudeVoiceOptions): void;
  finish(): void;
  cancel(): void;
}

/** `clearing`: the words are with the phone, the Esc is pressed. `polishing`: the box is empty, the rebuild runs */
type TakeState = "checking" | "waiting" | "listening" | "finishing" | "clearing" | "polishing" | "ended";

class Take implements ClaudeVoiceTake {
  state: TakeState = "checking";
  private recorder: Socket | null = null;
  private recorderGone = false;
  private buffered: Uint8Array[] = [];
  private bufferedBytes = 0;
  private words = "";
  /** when the box last showed a new word, or the listening began */
  private heardAt = 0;
  private readonly transcript = new BoxTranscript();
  private polish = false;
  private keywords: string[] = [];
  private job: RebuildJob | null = null;
  private finishWanted = false;
  private cancelWanted = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  private readonly wait: typeof TIMING;

  constructor(readonly paneId: string, private readonly voice: ClaudeVoice, private readonly deps: ClaudeVoiceDeps, private readonly send: (event: ClaudeVoiceEvent) => void) {
    this.wait = { ...TIMING, ...deps.timing };
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }

  private later(ms: number, run: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); run(); }, ms);
    this.timers.add(timer);
  }

  private end(event: ClaudeVoiceEvent | null): void {
    if (this.state === "ended") return;
    this.state = "ended";
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.recorder?.end();
    // a rebuild that ran has ended by now; one that was only started is stopped
    this.job?.cancel();
    this.voice.forget(this);
    if (event) this.send(event);
  }

  options(options: ClaudeVoiceOptions): void {
    if (this.state === "clearing" || this.state === "polishing" || this.state === "ended") return;
    this.polish = options.polish === true && this.deps.rebuild !== undefined;
    this.keywords = rebuildKeywords(Array.isArray(options.keywords) ? options.keywords : []);
    if (this.state === "listening" || this.state === "finishing") this.warm();
  }

  /** Starts the rebuild's program while the phone still speaks: it takes two seconds to be ready. */
  private warm(): void {
    if (this.polish && this.job === null && this.deps.rebuild) this.job = this.deps.rebuild();
  }

  private fail(code: ClaudeVoiceErrorCode, message: string): void {
    this.end({ type: "error", code, message });
  }

  async start(): Promise<void> {
    try {
      // Claude Code's voice settings are not checked here: a project's settings or `--settings` can
      // turn it on for one session. A session it is off in types the Space, which noRecorder takes back
      if (!this.deps.recorderInstalled()) return this.fail("recorder_missing", "Claude voice is not set up on the server (scripts/claude-voice/install.sh)");
      const pane = await this.deps.pane(this.paneId);
      if (pane.agent !== "claude") return this.fail("not_claude", "This pane runs no Claude Code");
      const reads = await this.deps.boxReads(this.paneId);
      if (pane.status === "blocked" || this.deps.blocked(reads[0])) return this.fail("agent_blocked", "Claude is waiting for an answer: answer it first");
      if (!claudeInputEmpty(...reads)) return this.fail("input_draft", "Claude's message box has text: send or clear it first");
      if (this.cancelWanted || this.state !== "checking") return this.end(null);
      this.state = "waiting";
      await this.deps.keys(this.paneId, ["space"]);
      this.later(this.wait.recorderWait, () => void this.noRecorder());
    } catch (error) {
      this.fail("failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** The recorder Claude Code started for this pane: true when this take takes it. */
  attach(socket: Socket): boolean {
    if (this.state !== "waiting") return false;
    this.recorder = socket;
    socket.on("close", () => this.onRecorderGone());
    socket.on("error", () => undefined);
    socket.write("ok\n");
    for (const chunk of this.buffered) socket.write(chunk);
    this.buffered = [];
    this.bufferedBytes = 0;
    this.state = "listening";
    this.heardAt = Date.now();
    if (this.cancelWanted) { void this.cancel(); return true; }
    this.warm();
    this.send({ type: "listening" });
    this.later(this.wait.max, () => this.finish());
    void this.poll();
    if (this.finishWanted) this.finish();
    return true;
  }

  audio(chunk: Uint8Array): void {
    if (this.state === "listening") { this.recorder?.write(chunk); return; }
    if (this.state !== "checking" && this.state !== "waiting") return;
    this.buffered.push(chunk);
    this.bufferedBytes += chunk.byteLength;
    while (this.bufferedBytes > BUFFER_MAX_BYTES && this.buffered.length > 1) this.bufferedBytes -= this.buffered.shift()!.byteLength;
  }

  /** The dictation so far, from one more read of the box; null when this read showed no box. */
  private async read(): Promise<string | null> {
    try {
      const view = claudeBoxView(await this.deps.screen(this.paneId));
      return view === null ? null : this.transcript.read(view);
    } catch {
      return null;
    }
  }

  private async poll(): Promise<void> {
    while (this.state === "listening") {
      const words = await this.read();
      if (this.state !== "listening") return;
      if (words !== null && words !== this.words) {
        this.words = words;
        this.heardAt = Date.now();
        this.send({ type: "partial", text: words });
      }
      // a silence Claude Code would end the recording over, and send its words: the take ends first
      if (Date.now() - this.heardAt >= this.wait.silence) { this.finish(); return; }
      await this.sleep(this.wait.poll);
    }
  }

  finish(): void {
    if (this.state === "checking" || this.state === "waiting") { this.finishWanted = true; return; }
    if (this.state !== "listening") return;
    void this.settle();
  }

  private async settle(): Promise<void> {
    this.state = "finishing";
    const silence = new Uint8Array(CHUNK_BYTES);
    const pump = setInterval(() => { if (!this.recorderGone) this.recorder?.write(silence); }, 100);
    const began = Date.now();
    let changed = Date.now();
    try {
      for (;;) {
        await this.sleep(this.wait.settlePoll);
        if (this.state !== "finishing") return;
        const words = await this.read();
        if (words !== null && words !== this.words) {
          this.words = words;
          changed = Date.now();
          this.send({ type: "partial", text: words });
        }
        const now = Date.now();
        if (this.recorderGone || now - began >= this.wait.settleMax || (now - began >= this.wait.settleSilence && now - changed >= this.wait.settleStable)) break;
      }
    } finally {
      clearInterval(pump);
    }
    if (this.state !== "finishing") return;
    const words = this.words;
    const polish = this.polish && this.deps.rebuild !== undefined && words.trim() !== "";
    this.state = "clearing";
    let pressed = false;
    if (!this.recorderGone) {
      try {
        await this.deps.keys(this.paneId, ["esc"]);
        pressed = true;
      } catch (error) {
        // the words are known all the same: they go to the phone, the recording is Claude Code's to end
        console.warn(`claude voice: the Esc after a dictation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.state !== "clearing") return;
    // the words first: the phone does not wait for Claude Code to redraw its box
    this.send({ type: "final", text: words, ...(polish ? { polish: true } : {}) });
    if (pressed) await this.cleared();
    if (this.state !== "clearing") return;
    if (!polish || this.cancelWanted) return this.end(null);
    this.state = "polishing";
    // the pane is free again: the rebuild needs nothing of it
    this.voice.forget(this);
    this.warm();
    const rebuilt = await (this.job?.run(words, this.keywords).catch(() => null) ?? null);
    if (this.state !== "polishing") return;
    this.end({ type: "polished", text: rebuilt ?? words });
  }

  /** Waits, after the Esc, until the screen no longer shows the recording: the box is the user's again. */
  private async cleared(): Promise<void> {
    for (const deadline = Date.now() + this.wait.clearWait; Date.now() < deadline;) {
      await this.sleep(this.wait.clearPoll);
      if (this.state !== "clearing") return;
      try {
        if (!RECORDING_RE.test(await this.deps.screen(this.paneId))) return;
      } catch { /* read again */ }
    }
  }

  private onRecorderGone(): void {
    this.recorderGone = true;
    // Claude Code stopped listening on its own: an Esc or a tap in the terminal, or its own limit.
    // The words may stand in its box or have been sent; nothing more is pressed
    if (this.state === "listening") this.fail("stopped", "Claude Code stopped listening");
  }

  private async noRecorder(): Promise<void> {
    if (this.state !== "waiting") return;
    // a recorder that comes later is told no
    this.voice.forget(this);
    let screen = "";
    try { screen = await this.deps.screen(this.paneId); } catch { /* nothing to undo without a screen */ }
    try {
      // listening from another recorder: stop it. Otherwise the Space went in as a typed space
      if (RECORDING_RE.test(screen)) await this.deps.keys(this.paneId, ["esc"]);
      else if (claudeBoxWords(screen) === "") await this.deps.keys(this.paneId, ["backspace"]);
    } catch { /* reported below either way */ }
    this.fail("not_listening", "Claude Code did not start listening: send /voice tap in this session, then try again");
  }

  async cancel(): Promise<void> {
    if (this.state === "ended") return;
    // not listening yet: the check stops before its Space, or the recorder is stopped as it comes
    if (this.state === "checking" || this.state === "waiting") { this.cancelWanted = true; return; }
    // the words went out and the Esc is pressed: a second one would open Claude Code's rewind. The
    // take ends by itself once the box is clear, without a rebuild
    if (this.state === "clearing") { this.cancelWanted = true; return; }
    const listening = (this.state === "listening" || this.state === "finishing") && !this.recorderGone && this.recorder !== null;
    this.end(null);
    if (listening) await this.deps.keys(this.paneId, ["esc"]).catch(() => undefined);
  }
}

export class ClaudeVoice {
  private server: NetServer | null = null;
  private readonly takes = new Map<string, Take>();
  private socketPath: string;

  constructor(private readonly deps: ClaudeVoiceDeps) {
    this.socketPath = join(deps.dir, `${deps.name}.sock`);
  }

  status(): ClaudeVoiceStatus {
    const recorder = this.deps.recorderInstalled();
    const voice = this.deps.settings();
    const reason = this.server === null ? "unavailable" : !recorder ? "recorder_missing" : null;
    return { available: reason === null, recorder, voice, rebuild: this.deps.rebuild !== undefined, reason };
  }

  /** Opens the socket the recorders ask; the folder is the user's alone. */
  listen(): Promise<void> {
    mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    rmSync(this.socketPath, { force: true });
    const server = createNetServer((socket) => this.hello(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => { server.off("error", reject); resolve(); });
    });
  }

  close(): void {
    for (const take of [...this.takes.values()]) void take.cancel();
    this.server?.close();
    this.server = null;
    rmSync(this.socketPath, { force: true });
  }

  /** A recorder's first line names its pane; the take waiting for that pane gets it, else `no`. */
  private hello(socket: Socket): void {
    let line = "";
    socket.setTimeout(2_000, () => socket.destroy());
    const onData = (data: Buffer): void => {
      line += data.toString("utf8");
      const at = line.indexOf("\n");
      if (at < 0) { if (line.length > HELLO_MAX_BYTES) socket.destroy(); return; }
      socket.off("data", onData);
      socket.setTimeout(0);
      let pane = "";
      try { pane = String((JSON.parse(line.slice(0, at)) as { pane?: unknown }).pane ?? ""); } catch { /* answered no */ }
      const take = this.takes.get(pane);
      if (!take?.attach(socket)) socket.end("no\n");
    };
    socket.on("data", onData);
    socket.on("error", () => undefined);
  }

  /** A dictation into a Claude pane; `send` gets its events, ending with `final` or `error`. */
  open(paneId: string, send: (event: ClaudeVoiceEvent) => void): ClaudeVoiceTake {
    const take = new Take(paneId, this, this.deps, send);
    if (this.server === null) { take.state = "ended"; send({ type: "error", code: "unavailable", message: "Claude voice is not running on this server" }); return take; }
    if (this.takes.has(paneId)) { take.state = "ended"; send({ type: "error", code: "busy", message: "Another dictation is running in this pane" }); return take; }
    this.takes.set(paneId, take);
    void take.start();
    return take;
  }

  /** Whether a dictation still holds this pane: until its words are sent and Claude Code's box is the user's again. */
  busy(paneId: string): boolean {
    return this.takes.has(paneId);
  }

  /** @internal a take that ended */
  forget(take: Take): void {
    if (this.takes.get(take.paneId) === take) this.takes.delete(take.paneId);
  }
}
