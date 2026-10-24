import { Database } from "bun:sqlite";
import { closeSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, join } from "node:path";

import type { HerdrPane, OmoTask } from "../shared/protocol.ts";
import { rolloutInsideStore } from "./codex.ts";

/**
 * The subagents a Codex session spawned (`spawn_agent`), for the pane's running count and the
 * status line's list, as claude-subagents.ts does for Claude Code.
 *
 * Codex records them in its state database: `thread_spawn_edges` ties a parent thread to each
 * child (`open` whether or not the child still works: nearly every edge stays open), and the
 * child's own `threads` row names it (`agent_nickname`, `agent_path`) and its rollout. Whether a
 * child works now is told by that rollout: a `task_started` that no `task_complete` or
 * `turn_aborted` followed. A child runs inside the Codex process that runs its parent, so one
 * whose rollout was last written before that process started was cut off with an earlier one
 * (a parent killed mid-turn leaves its children's turns open forever): it is lost, not running.
 * Children of children count too, a few levels down.
 *
 * Read every few seconds per Codex pane: the database is opened read-only and closed again, and
 * a child's rollout is read only when its size or time changed, from its end (TAIL_BYTES, more
 * only when a long turn left no marker there).
 */
const TAIL_BYTES = 64 * 1024;
/** how far back a turn's start is looked for in a rollout that keeps writing without a marker */
const DEEP_TAIL_BYTES = 1024 * 1024;
const MAX_CHILDREN = 50;
const MAX_DEPTH = 4;
const RECENT_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 10;
/** a process's start is known to the second, and the clock can step */
const START_SLACK_MS = 60_000;
const THREAD_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export type TurnState = "running" | "ended" | "aborted";

/** Where a rollout's last turn stands, from the end of the file; null when no turn marker is in it. */
export function lastTurnState(tail: string): TurnState | null {
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.includes("event_msg")) continue;
    let type: unknown;
    try { type = (JSON.parse(line) as { payload?: { type?: unknown } }).payload?.type; } catch { continue; }
    if (type === "task_started") return "running";
    if (type === "task_complete") return "ended";
    if (type === "turn_aborted") return "aborted";
  }
  return null;
}

function readTail(path: string, size: number, bytes: number): string {
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

interface ChildThread {
  id: string;
  rollout_path: string;
  agent_nickname: string | null;
  agent_role: string | null;
  agent_path: string | null;
  model: string | null;
  created_at_ms: number | null;
  created_at: number;
}

/** The threads `parent` spawned, and those they spawned, newest first per level; none on a store without spawn edges. */
export function spawnedThreads(db: Database, parent: string): ChildThread[] {
  if (db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_spawn_edges'").get() === null) return [];
  const found: ChildThread[] = [];
  const seen = new Set([parent]);
  let level = [parent];
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0 && found.length < MAX_CHILDREN; depth += 1) {
    const rows = db.query<ChildThread, (string | number)[]>(
      `SELECT t.id, t.rollout_path, t.agent_nickname, t.agent_role, t.agent_path, t.model, t.created_at_ms, t.created_at
       FROM thread_spawn_edges e JOIN threads t ON t.id = e.child_thread_id
       WHERE e.parent_thread_id IN (${level.map(() => "?").join(", ")}) ORDER BY t.created_at DESC LIMIT ?`,
    ).all(...level, MAX_CHILDREN - found.length);
    level = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      found.push(row);
      level.push(row.id);
    }
  }
  return found;
}

/** What a child is called in the list: its nickname and the job its path names (`Sartre · platform supervisor`). */
export function childTitle(child: Pick<ChildThread, "id" | "agent_nickname" | "agent_path">): string {
  const job = child.agent_path ? basename(child.agent_path).replace(/[_-]+/g, " ").trim() : "";
  const name = child.agent_nickname?.trim() ?? "";
  return [name, job].filter(Boolean).join(" · ") || child.id.slice(0, 8);
}

const iso = (ms: number | null): string | null => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());

/** A rollout's last turn, kept by size and time: a child that wrote nothing since is not read again. */
export type TailReader = (path: string, stat: Stats) => TurnState | null;

export function cachedTailReader(): TailReader & { prune: (keep: ReadonlySet<string>) => void } {
  const kept = new Map<string, { size: number; mtimeMs: number; state: TurnState | null }>();
  const read = (path: string, stat: Stats): TurnState | null => {
    const hit = kept.get(path);
    if (hit !== undefined && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.state;
    let state = lastTurnState(readTail(path, stat.size, TAIL_BYTES));
    // a long turn can write more than the tail since it began
    if (state === null && stat.size > TAIL_BYTES) state = lastTurnState(readTail(path, stat.size, DEEP_TAIL_BYTES));
    kept.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, state });
    return state;
  };
  return Object.assign(read, { prune: (keep: ReadonlySet<string>) => { for (const path of kept.keys()) if (!keep.has(path)) kept.delete(path); } });
}

/**
 * A Codex thread's subagents as tasks: every one that runs, and the newest RECENT_LIMIT that
 * ended in the last day. `startedAt` is when the pane's Codex process started (null: unknown).
 */
export function codexSubagents(db: Database, parent: string, home: string, startedAt: number | null, now: number, read: TailReader, touched?: Set<string>): OmoTask[] {
  let store: string;
  try { store = realpathSync(join(home, "sessions")); } catch { return []; }
  const running: OmoTask[] = [];
  const ended: (OmoTask & { at: number })[] = [];
  for (const child of spawnedThreads(db, parent)) {
    let path: string;
    let stat: Stats;
    try {
      path = realpathSync(child.rollout_path);
      // a row names its file: only one inside this store is read
      if (!path.endsWith(".jsonl") || !rolloutInsideStore(store, path)) continue;
      stat = statSync(path);
      if (!stat.isFile()) continue;
    } catch { continue; }
    // quiet for a day: neither running (nothing works that long without a word) nor recent
    if (now - stat.mtimeMs > RECENT_MS) continue;
    touched?.add(path);
    const state = read(path, stat);
    const cutOff = startedAt !== null && stat.mtimeMs < startedAt - START_SLACK_MS;
    const task: OmoTask = {
      id: child.id,
      title: childTitle(child),
      category: child.agent_role,
      model: child.model,
      status: state === "running" ? (cutOff ? "lost" : "running") : state === "aborted" ? "cancelled" : "completed",
      started_at: iso(child.created_at_ms ?? child.created_at * 1000),
      ended_at: null,
      turns: null,
      tool_calls: null,
      tokens: null,
    };
    if (task.status === "running") running.push(task);
    else ended.push({ ...task, ended_at: iso(stat.mtimeMs), at: stat.mtimeMs });
  }
  ended.sort((a, b) => b.at - a.at);
  return [...running, ...ended.slice(0, RECENT_LIMIT).map(({ at: _at, ...task }) => task)];
}

/** The thread a rollout records: in its file name (`rollout-<time>-<id>.jsonl`). */
export function rolloutThread(path: string): string | null {
  return THREAD_ID.exec(basename(path))?.[1] ?? null;
}

export interface CodexSession {
  path: string;
  home: string;
  startedAt: number | null;
}

export interface CodexSubagentDeps {
  /** the pane's rollout, its store and when its Codex started; null while it has none */
  resolve: (pane: HerdrPane) => Promise<CodexSession | null>;
  /** a pane's running count changed */
  onChange: (paneId: string, running: number) => void;
  now?: () => number;
  pollMs?: number;
  /** how often a pane's rollout is looked up again (it can move on with /new or a resume) */
  refreshMs?: number;
}

/** Codex panes' subagents, read every few seconds while they run (see the module's comment). */
export class CodexSubagentStatus {
  private readonly sessions = new Map<string, CodexSession & { thread: string; at: number }>();
  private readonly counts = new Map<string, number>();
  private readonly lists = new Map<string, OmoTask[]>();
  private readonly read = cachedTailReader();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly deps: CodexSubagentDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 3000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  countOf(paneId: string): number {
    return this.counts.get(paneId) ?? 0;
  }

  tasksOf(paneId: string): OmoTask[] {
    return this.lists.get(paneId) ?? [];
  }

  known(paneId: string): boolean {
    return this.sessions.has(paneId);
  }

  /** The Codex panes of a snapshot: each one's rollout looked up when it is new or due, the others let go of. */
  refresh(panes: readonly HerdrPane[]): Promise<void> {
    if (this.refreshing !== null) return this.refreshing;
    const run = (async () => {
      const codex = panes.filter((pane) => pane.agent === "codex");
      const open = new Set(codex.map((pane) => pane.pane_id));
      for (const paneId of [...this.sessions.keys()]) if (!open.has(paneId)) this.forget(paneId);
      const now = this.now();
      for (const pane of codex) {
        const known = this.sessions.get(pane.pane_id);
        if (known !== undefined && now - known.at < (this.deps.refreshMs ?? 5000)) continue;
        await this.ensure(pane);
      }
    })().finally(() => { this.refreshing = null; });
    this.refreshing = run;
    return run;
  }

  /** One pane's rollout, looked up now. */
  async ensure(pane: HerdrPane): Promise<void> {
    let session: CodexSession | null = null;
    try { session = await this.deps.resolve(pane); } catch { /* herdr busy: as if none, asked again next time */ }
    const thread = session === null ? null : rolloutThread(session.path);
    if (session === null || thread === null) {
      if (this.sessions.has(pane.pane_id)) this.forget(pane.pane_id);
      return;
    }
    const before = this.sessions.get(pane.pane_id);
    this.sessions.set(pane.pane_id, { ...session, thread, at: this.now() });
    if (before?.thread !== thread) this.pollPane(pane.pane_id);
  }

  poll(): void {
    const touched = new Set<string>();
    for (const paneId of this.sessions.keys()) this.pollPane(paneId, touched);
    this.read.prune(touched);
  }

  private pollPane(paneId: string, touched = new Set<string>()): void {
    const session = this.sessions.get(paneId);
    if (session === undefined) return;
    let tasks: OmoTask[] = [];
    let db: Database | null = null;
    try {
      db = new Database(join(session.home, "state_5.sqlite"), { readonly: true, create: false });
      tasks = codexSubagents(db, session.thread, session.home, session.startedAt, this.now(), this.read, touched);
    } catch { /* no store, or one Codex is migrating: none known now */ } finally {
      db?.close();
    }
    this.lists.set(paneId, tasks);
    this.setCount(paneId, tasks.filter((task) => task.status === "running").length);
  }

  private forget(paneId: string): void {
    this.sessions.delete(paneId);
    this.lists.delete(paneId);
    this.setCount(paneId, 0);
    this.counts.delete(paneId);
  }

  private setCount(paneId: string, running: number): void {
    if ((this.counts.get(paneId) ?? 0) === running) return;
    this.counts.set(paneId, running);
    this.deps.onChange(paneId, running);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
