import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../shared/protocol.ts";
import { cachedTailReader, childTitle, CodexSubagentStatus, codexSubagents, lastTurnState, rolloutThread } from "./codex-subagents.ts";

const event = (type: string) => JSON.stringify({ timestamp: "2026-10-24T00:00:00.000Z", type: "event_msg", payload: { type } });
const item = JSON.stringify({ type: "response_item", payload: { type: "reasoning" } });
const PARENT = "019fe723-896b-77a0-8ac9-13f1407a8594";
const id = (n: number) => `019fe724-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("codex subagents", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  /** A Codex home: a state database with spawn edges, and the children's rollouts in its sessions folder. */
  function store(children: { n: number; parent?: string; lines: string[]; nickname?: string | null; path?: string | null; ageMs?: number; outside?: boolean }[], edges = true) {
    const home = mkdtempSync(join(tmpdir(), "herdr-codex-subagents-"));
    roots.push(home);
    mkdirSync(join(home, "sessions", "2026", "10", "24"), { recursive: true });
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, source TEXT NOT NULL, agent_nickname TEXT, agent_role TEXT, agent_path TEXT, model TEXT, created_at_ms INTEGER)");
    if (edges) db.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)");
    for (const child of children) {
      const folder = child.outside ? mkdtempSync(join(tmpdir(), "herdr-codex-elsewhere-")) : join(home, "sessions", "2026", "10", "24");
      if (child.outside) roots.push(folder);
      const rollout = join(folder, `rollout-2026-10-24T00-00-00-${id(child.n)}.jsonl`);
      writeFileSync(rollout, `${child.lines.join("\n")}\n`);
      if (child.ageMs) { const at = new Date(Date.now() - child.ageMs); utimesSync(rollout, at, at); }
      db.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, NULL, ?, 'gpt-6', ?)").run(id(child.n), rollout, 1792780000, '{"subagent":{}}', child.nickname === undefined ? `Agent${child.n}` : child.nickname, child.path === undefined ? `/root/job_${child.n}` : child.path, 1792780000000 + child.n);
      if (edges) db.query("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')").run(child.parent ?? PARENT, id(child.n));
    }
    return { home, db };
  }

  it("reads the last turn marker from the end of a rollout", () => {
    expect(lastTurnState([event("task_started"), item].join("\n"))).toBe("running");
    expect(lastTurnState([event("task_started"), item, event("task_complete")].join("\n"))).toBe("ended");
    expect(lastTurnState([event("task_started"), event("turn_aborted")].join("\n"))).toBe("aborted");
    expect(lastTurnState([event("task_complete"), event("task_started"), item].join("\n"))).toBe("running");
    expect(lastTurnState(`${item}\n{"type":"event_msg","payload":{"ty`)).toBeNull();
  });

  it("names a child by its nickname and the job its path names", () => {
    expect(childTitle({ id: id(1), agent_nickname: "Sartre", agent_path: "/root/platform_supervisor" })).toBe("Sartre · platform supervisor");
    expect(childTitle({ id: id(1), agent_nickname: null, agent_path: null })).toBe(id(1).slice(0, 8));
    expect(rolloutThread(`/x/rollout-2026-10-24T00-00-00-${id(7)}.jsonl`)).toBe(id(7));
    expect(rolloutThread("/x/notes.jsonl")).toBeNull();
  });

  it("lists a child mid-turn as running, and the ones that ended or were stopped as such", () => {
    const { home, db } = store([
      { n: 1, lines: [event("task_started"), item] },
      { n: 2, lines: [event("task_started"), event("task_complete")], nickname: "Noether", path: "/root/onlinejobs_research" },
      { n: 3, lines: [event("task_started"), event("turn_aborted")] },
    ]);
    const tasks = codexSubagents(db, PARENT, home, null, Date.now(), cachedTailReader());
    // the running first, then what ended
    expect(tasks[0]?.id).toBe(id(1));
    expect(Object.fromEntries(tasks.map((task) => [task.id, task.status]))).toEqual({ [id(1)]: "running", [id(2)]: "completed", [id(3)]: "cancelled" });
    expect(tasks.find((task) => task.id === id(2))?.title).toBe("Noether · onlinejobs research");
    expect(tasks.find((task) => task.id === id(1))?.ended_at).toBeNull();
    expect(tasks.find((task) => task.id === id(2))?.ended_at).not.toBeNull();
  });

  it("calls a child cut off by an earlier Codex process lost, and counts grandchildren", () => {
    const { home, db } = store([
      { n: 1, lines: [event("task_started"), item], ageMs: 10 * 60_000 },
      { n: 2, lines: [event("task_started"), item] },
      { n: 3, parent: id(2), lines: [event("task_started"), item] },
    ]);
    // the pane's Codex started five minutes ago: child 1 last wrote before it
    const tasks = codexSubagents(db, PARENT, home, Date.now() - 5 * 60_000, Date.now(), cachedTailReader());
    const status = Object.fromEntries(tasks.map((task) => [task.id, task.status]));
    expect(status).toEqual({ [id(1)]: "lost", [id(2)]: "running", [id(3)]: "running" });
  });

  it("reads no file outside the store, nothing quiet for a day, and nothing on a store without spawn edges", () => {
    const { home, db } = store([
      { n: 1, lines: [event("task_started"), item], outside: true },
      { n: 2, lines: [event("task_started"), item], ageMs: 2 * 24 * 60 * 60_000 },
    ]);
    expect(codexSubagents(db, PARENT, home, null, Date.now(), cachedTailReader())).toEqual([]);
    const old = store([{ n: 1, lines: [event("task_started")] }], false);
    expect(codexSubagents(old.db, PARENT, old.home, null, Date.now(), cachedTailReader())).toEqual([]);
  });

  it("finds a turn's start behind a long tail of output", () => {
    const filler = Array.from({ length: 2000 }, () => JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(60) } }));
    const { home, db } = store([{ n: 1, lines: [event("task_complete"), event("task_started"), ...filler] }]);
    expect(codexSubagents(db, PARENT, home, null, Date.now(), cachedTailReader())[0]?.status).toBe("running");
  });

  it("counts a pane's running children, tells a change, and lets go of a pane that left", async () => {
    const { home } = store([{ n: 1, lines: [event("task_started"), item] }, { n: 2, lines: [event("task_started"), item] }]);
    const rollout = join(home, "sessions", "2026", "10", "24", `rollout-2026-10-24T00-00-00-${PARENT}.jsonl`);
    writeFileSync(rollout, `${event("task_started")}\n`);
    const changes: [string, number][] = [];
    const status = new CodexSubagentStatus({ resolve: async () => ({ path: rollout, home, startedAt: null }), onChange: (pane, running) => changes.push([pane, running]) });
    const pane = { pane_id: "w1:p1", agent: "codex" } as HerdrPane;
    await status.refresh([pane]);
    expect(status.countOf("w1:p1")).toBe(2);
    expect(status.tasksOf("w1:p1")).toHaveLength(2);
    // one child ends
    writeFileSync(join(home, "sessions", "2026", "10", "24", `rollout-2026-10-24T00-00-00-${id(2)}.jsonl`), `${event("task_started")}\n${event("task_complete")}\n`);
    status.poll();
    expect(status.countOf("w1:p1")).toBe(1);
    // the pane is no Codex pane any more
    await status.refresh([{ pane_id: "w1:p1", agent: "claude" } as HerdrPane]);
    expect(status.countOf("w1:p1")).toBe(0);
    expect(changes).toEqual([["w1:p1", 2], ["w1:p1", 1], ["w1:p1", 0]]);
  });
});
