/**
 * "Move unused files to Drive": the PC's own `cabinet tidy` (work folders nobody used for a day
 * go to Google Drive), shown first as its dry run and then started on the owner's word.
 *
 * Two commands, both fixed: `<bin> tidy --dry-run --json` and `<bin> tidy --json`. Nothing a
 * request carries reaches either, and no shell is involved. What may leave the disk is decided
 * inside the program (it removes only what it verified on Drive and skips a folder in use); this
 * module only runs it and reads its one JSON line.
 *
 * A real run uploads, so it can take many minutes. It is therefore nobody's open request: it is
 * started detached, in a session of its own, with its output in a file under the state
 * directory, and the app asks `status()` until it ended. The record of the run is a state file,
 * so a page opened again, or a server started again while the run goes on, reads the same run:
 * a server that did not start the process tells by its pid and start time whether it still
 * runs, and reads the result from the output file, else from cabinet's own `last_tidy`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CabinetFolder, CabinetPreview, CabinetResult, CabinetRun, CabinetStatus, CabinetWaiting } from "../shared/vps.ts";
import { run } from "./vps-command.ts";

export const DEFAULT_CABINET_BIN = "/usr/local/bin/cabinet";
export const DEFAULT_CABINET_STATE = "/var/lib/cabinet/state.json";
/** the dry run answers in about a second; a hung one is given up on */
export const PREVIEW_TIMEOUT_MS = 30_000;
/** cabinet's exit code for "another cabinet job holds the lock; nothing was changed" */
const EXIT_BUSY = 3;
/** how much of a list crosses the wire: the page shows a few and counts the rest */
const MAX_ITEMS = 20;
const MAX_FAILS = 50;
const MAX_PATH = 1024;
const MAX_WORDS = 300;
/** the output file holds one JSON line; anything far past that is not it */
const MAX_OUTPUT_BYTES = 4 * 1024 ** 2;

export class CabinetError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "CabinetError";
  }
}

/** What /api/vps/cabinet needs; tests and fixtures pass their own. */
export interface CabinetService {
  status(): CabinetStatus;
  preview(): Promise<CabinetPreview>;
  start(): CabinetStatus;
}

export interface CabinetOptions {
  /** where the run's record and its output are kept */
  stateDir: string;
  /** the cabinet program; unset, HERDR_CABINET_BIN, else /usr/local/bin/cabinet */
  bin?: string;
  /** cabinet's own state file (its `last_tidy`); unset, HERDR_CABINET_STATE, else /var/lib/cabinet/state.json */
  cabinetState?: string;
  previewTimeoutMs?: number;
  now?: () => number;
}

/** The run as this server keeps it: the wire's fields plus what names its process. */
interface RunRecord extends CabinetRun {
  pid: number | null;
  /** the process start in clock ticks since boot: with the pid, it names this process and no later one */
  start_ticks: number | null;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** a count or a size: a finite number that is not negative, else 0 */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function measure(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function words(value: unknown, limit = MAX_WORDS): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** The last thing a program said: its last line that is not empty, bounded. */
export function lastLine(output: string): string {
  return words(output.trim().split("\n").at(-1));
}

/** The program's answer: the last line of its output that is a JSON object; null when there is none. */
export function parseJsonLine(output: string): Json | null {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value)) return value;
    } catch { /* not the answer: an earlier line may be */ }
  }
  return null;
}

function waitingList(value: unknown): CabinetWaiting[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).filter((item) => typeof item["path"] === "string")
    .slice(0, MAX_ITEMS).map((item) => ({ path: words(item["path"], MAX_PATH), bytes: count(item["bytes"]), why: words(item["why"]) }));
}

/** The dry run's answer as the wire carries it: the largest folders first, a bounded few of them. */
export function parsePreview(json: Json): CabinetPreview {
  const all = Array.isArray(json["items"]) ? json["items"].filter(isObject).filter((item) => typeof item["path"] === "string") : [];
  const items: CabinetFolder[] = all.map((item) => ({ path: words(item["path"], MAX_PATH), bytes: count(item["bytes"]), idle_hours: measure(item["idle_hours"]) }))
    .sort((a, b) => b.bytes - a.bytes).slice(0, MAX_ITEMS);
  const busy = waitingList(json["busy"]);
  return {
    folders: typeof json["folders"] === "number" ? count(json["folders"]) : all.length,
    bytes: count(json["bytes"]),
    items,
    waiting: typeof json["waiting"] === "number" ? count(json["waiting"]) : busy.length,
    busy,
    free_gb: measure(json["free_gb"]),
    idle_days: measure(json["idle_days"]),
  };
}

/** A real run's answer (the program's JSON line, or cabinet's `last_tidy`); null when it is not one. */
export function parseResult(json: Json): CabinetResult | null {
  if (typeof json["moved"] !== "number") return null;
  const busy = waitingList(json["busy"]);
  const fails = Array.isArray(json["fails"]) ? json["fails"].filter((item): item is string => typeof item === "string").slice(0, MAX_FAILS).map((item) => words(item, MAX_PATH)) : [];
  const failed = typeof json["failed"] === "number" ? count(json["failed"]) : fails.length;
  return {
    ok: json["ok"] !== false && failed === 0,
    moved: count(json["moved"]),
    bytes: count(json["bytes"]),
    waiting: typeof json["waiting"] === "number" ? count(json["waiting"]) : busy.length,
    busy,
    failed,
    fails,
    scratch_folders: count(json["scratch_folders"]),
    scratch_bytes: count(json["scratch_bytes"]),
    browser_files: count(json["browser_files"]),
    free_before_gb: measure(json["free_before_gb"]),
    free_after_gb: measure(json["free_after_gb"]),
    seconds: measure(json["seconds"]),
  };
}

const BUSY_MESSAGE = "Another cabinet job is running. Nothing was changed.";

/**
 * How a run ended, from its output and (when this server saw it end) its exit code.
 * `said` is the program's last line when it is not JSON (cabinet ends a refusal with one
 * sentence and exit code 2). `fallback` is cabinet's own record of a run that ended after
 * this one started: what is left when the output file holds no answer.
 */
export function runOutcome(json: Json | null, code: number | null, said: string, fallback: CabinetResult | null): Pick<CabinetRun, "state" | "result" | "message"> {
  if (code === EXIT_BUSY || json?.["busy"] === true) return { state: "busy", result: null, message: words(json?.["message"]) || said || BUSY_MESSAGE };
  const result = json === null ? fallback : parseResult(json);
  if (result !== null) {
    // exit 1 with a result: something failed, and the result names it
    return { state: "done", result: code !== null && code !== 0 ? { ...result, ok: false } : result, message: null };
  }
  return { state: "failed", result: null, message: words(json?.["message"]) || said || (code === null ? "The run ended without a result." : `cabinet ended with code ${code} and no result.`) };
}

/**
 * Field 22 of /proc/<pid>/stat: when the process started. `null`: no such process, or one that
 * already exited (a zombie). `undefined`: this system has no /proc to ask.
 */
function startTicks(pid: number): number | null | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    try { accessSync("/proc/self/stat"); return null; } catch { return undefined; }
  }
  // the command may hold spaces and parentheses: the fields start after its last ")"
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z" || fields[0] === "X") return null;
  const ticks = Number(fields[19]);
  return Number.isFinite(ticks) ? ticks : null;
}

function writeJsonPrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readBounded(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > MAX_OUTPUT_BYTES ? text.slice(-MAX_OUTPUT_BYTES) : text;
  } catch {
    return "";
  }
}

export class CabinetTidy implements CabinetService {
  private readonly bin: string;
  private readonly cabinetState: string;
  private readonly recordPath: string;
  private readonly outPath: string;
  private readonly errPath: string;
  private readonly previewTimeoutMs: number;
  private readonly now: () => number;
  /** undefined: not read from the state file yet */
  private record: RunRecord | null | undefined;
  /** the run this process started and still waits on: its exit event ends it */
  private child: { id: string; process: ChildProcess } | null = null;
  private previewing: Promise<CabinetPreview> | null = null;

  constructor(options: CabinetOptions) {
    this.bin = options.bin ?? (process.env["HERDR_CABINET_BIN"] || DEFAULT_CABINET_BIN);
    this.cabinetState = options.cabinetState ?? (process.env["HERDR_CABINET_STATE"] || DEFAULT_CABINET_STATE);
    this.recordPath = join(options.stateDir, "cabinet-tidy.json");
    this.outPath = join(options.stateDir, "cabinet", "tidy.out");
    this.errPath = join(options.stateDir, "cabinet", "tidy.err");
    this.previewTimeoutMs = options.previewTimeoutMs ?? PREVIEW_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** The program to run, as a path; null when this PC has none that this user may run. */
  private program(): string | null {
    const path = this.bin.includes("/") ? this.bin : Bun.which(this.bin);
    if (!path) return null;
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile() ? path : null;
    } catch {
      return null;
    }
  }

  private required(): string {
    const program = this.program();
    if (program === null) throw new CabinetError(404, "cabinet_missing", "This server has no cabinet program.");
    return program;
  }

  private load(): RunRecord | null {
    if (this.record !== undefined) return this.record;
    let record: RunRecord | null = null;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.recordPath, "utf8"));
      if (isObject(raw) && typeof raw["id"] === "string" && typeof raw["started_at"] === "number"
        && (raw["state"] === "running" || raw["state"] === "done" || raw["state"] === "busy" || raw["state"] === "failed")) {
        record = {
          id: raw["id"],
          state: raw["state"],
          started_at: raw["started_at"],
          finished_at: typeof raw["finished_at"] === "number" ? raw["finished_at"] : null,
          result: isObject(raw["result"]) ? parseResult(raw["result"]) : null,
          message: typeof raw["message"] === "string" ? raw["message"] : null,
          pid: typeof raw["pid"] === "number" && Number.isSafeInteger(raw["pid"]) && raw["pid"] > 0 ? raw["pid"] : null,
          start_ticks: typeof raw["start_ticks"] === "number" ? raw["start_ticks"] : null,
        };
      }
    } catch { /* no run was started from here yet, or the file is not ours to read */ }
    this.record = record;
    return record;
  }

  private save(record: RunRecord): void {
    this.record = record;
    writeJsonPrivate(this.recordPath, record);
  }

  /** Whether the recorded run's process is still there. */
  private alive(record: RunRecord): boolean {
    // started by this process: its exit event is what ends the run
    if (this.child?.id === record.id) return true;
    if (record.pid === null) return false;
    const ticks = startTicks(record.pid);
    if (ticks === undefined) {
      try { process.kill(record.pid, 0); return true; } catch { return false; }
    }
    // the same pid with another start time is a later process that was handed the number
    return ticks !== null && (record.start_ticks === null || ticks === record.start_ticks);
  }

  /** The recorded run, ended here first when its process is gone (a run that outlived the server that started it). */
  private current(): RunRecord | null {
    const record = this.load();
    if (record?.state === "running" && !this.alive(record)) this.finish(record.id, { seen: false, code: null, failure: null });
    return this.load();
  }

  /** cabinet's own record of its last real tidy (`last_tidy` in its state file, `ts` in seconds), as a run; null when it has none. */
  private lastTidy(): CabinetRun | null {
    let tidy: unknown;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.cabinetState, "utf8"));
      tidy = isObject(raw) ? raw["last_tidy"] : null;
    } catch { return null; /* no cabinet state on this PC, or it is being rewritten: nothing to add */ }
    if (!isObject(tidy) || typeof tidy["ts"] !== "number" || !Number.isFinite(tidy["ts"])) return null;
    const result = parseResult(tidy);
    if (result === null) return null;
    const finished = Math.round(tidy["ts"] * 1000);
    return { id: `cabinet-${finished}`, state: "done", started_at: finished - Math.round((result.seconds ?? 0) * 1000), finished_at: finished, result, message: null };
  }

  /**
   * The recorded run ended. `seen`: this process started it and saw it end, with its exit `code`
   * (null when a signal ended it) or the `failure` to start it; otherwise it was only found gone.
   */
  private finish(id: string, end: { seen: boolean; code: number | null; failure: string | null }): void {
    const { seen, code, failure } = end;
    const record = this.load();
    if (!record || record.id !== id || record.state !== "running") return;
    if (this.child?.id === id) this.child = null;
    const output = readBounded(this.outPath);
    const json = parseJsonLine(output);
    // without an answer in the file, cabinet's own record of a tidy that ended after this one began is the answer
    const kept = json === null ? this.lastTidy() : null;
    const fallback = kept !== null && kept.finished_at !== null && kept.finished_at >= record.started_at - 1000 ? kept : null;
    const outcome = failure !== null && json === null && fallback === null
      ? { state: "failed" as const, result: null, message: `cabinet could not be started: ${words(failure)}` }
      : runOutcome(json, code, json === null ? lastLine(readBounded(this.errPath)) || lastLine(output) : "", fallback?.result ?? null);
    // found gone after the fact: it ended when it last wrote, not when this server looked
    let finished = this.now();
    if (!seen) {
      if (fallback?.finished_at) finished = fallback.finished_at;
      else { try { finished = Math.min(finished, Math.round(statSync(this.outPath).mtimeMs)); } catch { /* now */ } }
    }
    this.save({ ...record, ...outcome, finished_at: Math.max(record.started_at, finished) });
  }

  status(): CabinetStatus {
    const record = this.current();
    const tidy = this.lastTidy();
    let run: CabinetRun | null = null;
    if (record) {
      const { pid: _pid, start_ticks: _ticks, ...wire } = record;
      run = wire;
    }
    // a tidy cabinet ran by other means since (its timer, a terminal) is the last run
    if (tidy !== null && (run === null || (run.state !== "running" && (tidy.finished_at ?? 0) > (run.finished_at ?? run.started_at) + 2000))) run = tidy;
    return { available: this.program() !== null, now: this.now(), run };
  }

  /** `cabinet tidy --dry-run --json`: what a run would move. Changes nothing. Asks made together share one dry run. */
  preview(): Promise<CabinetPreview> {
    if (this.current()?.state === "running") return Promise.reject(new CabinetError(409, "tidy_running", "Files are being moved to Drive now."));
    this.previewing ??= this.dryRun().finally(() => { this.previewing = null; });
    return this.previewing;
  }

  private async dryRun(): Promise<CabinetPreview> {
    const program = this.required();
    // the environment as it is: the real run below gets the same one
    const result = await run([program, "tidy", "--dry-run", "--json"], this.previewTimeoutMs, undefined, MAX_OUTPUT_BYTES, process.env);
    if (result.timedOut) throw new CabinetError(504, "preview_timeout", `cabinet did not answer in ${Math.round(this.previewTimeoutMs / 1000)} s.`);
    const json = parseJsonLine(result.stdout);
    // what it said when that is not JSON: cabinet ends a refusal with one sentence on its output
    const said = words(json?.["message"]) || lastLine(result.stderr) || (json === null ? lastLine(result.stdout) : "");
    if (result.code === EXIT_BUSY || json?.["busy"] === true) throw new CabinetError(409, "cabinet_busy", said || BUSY_MESSAGE);
    // the system's own refusal to run the file (no interpreter, no permission): there was no program to answer
    if (json === null && result.stdout === "" && /^E[A-Z]+: /.test(result.stderr)) throw new CabinetError(502, "preview_failed", `cabinet could not be started: ${said}`);
    // it failed and said why, in its own words
    if (json === null && result.code !== 0 && said) throw new CabinetError(502, "preview_failed", said);
    if (json === null) throw new CabinetError(502, "bad_output", said ? `cabinet did not answer in JSON: ${said}` : "cabinet did not answer in JSON.");
    if (result.code !== 0 || json["ok"] === false) throw new CabinetError(502, "preview_failed", said || `cabinet's dry run ended with code ${String(result.code)}.`);
    return parsePreview(json);
  }

  /** `cabinet tidy --json`, detached: it goes on when the page closes and when this server stops. One at a time. */
  start(): CabinetStatus {
    // no await between this check and the record below: two requests cannot both pass it
    if (this.current()?.state === "running") throw new CabinetError(409, "tidy_running", "Files are being moved to Drive now.");
    // cabinet 2.1's dry run takes no lock (measured beside a run), but one that did would end this run at once, "busy" with itself
    if (this.previewing !== null) throw new CabinetError(409, "preview_running", "The check before the move is still running. Try again in a moment.");
    const program = this.required();
    mkdirSync(dirname(this.outPath), { recursive: true, mode: 0o700 });
    const id = `tidy-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const out = openSync(this.outPath, "w", 0o600);
    const err = openSync(this.errPath, "w", 0o600);
    let child: ChildProcess;
    try {
      // a session of its own: the stop of this server (a signal to its process group) does not reach it
      child = spawn(program, ["tidy", "--json"], { detached: true, stdio: ["ignore", out, err], env: process.env });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    const pid = child.pid ?? null;
    const ticks = pid === null ? null : startTicks(pid);
    this.child = { id, process: child };
    this.save({ id, state: "running", started_at: this.now(), finished_at: null, result: null, message: null, pid, start_ticks: ticks ?? null });
    child.once("error", (error) => this.finish(id, { seen: true, code: null, failure: error.message }));
    child.once("exit", (code) => this.finish(id, { seen: true, code, failure: null }));
    // this server may stop while it runs
    child.unref();
    return this.status();
  }
}
