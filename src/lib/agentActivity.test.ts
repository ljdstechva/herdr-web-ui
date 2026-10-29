import { describe, expect, it } from "bun:test";
import type { OmoTask } from "../../shared/protocol.ts";
import { agentActivity, runningTasks, taskKind, wakeupInMs } from "./agentActivity.ts";

const task = (id: string, status: OmoTask["status"], category: string | null, started = "2026-10-24T00:00:00.000Z", due?: string): OmoTask =>
  ({ id, title: id, category, model: null, status, started_at: started, ended_at: null, turns: null, tool_calls: null, tokens: null, ...(due === undefined ? {} : { due_at: due }) });

describe("agent activity", () => {
  it("shows nothing while nothing works", () => {
    expect(agentActivity("idle", 0, false, null)).toBeNull();
    expect(agentActivity("done", 0, false, [task("a", "completed", "general-purpose")])).toBeNull();
    // a blocked agent is the prompt card's: the line is for work
    expect(agentActivity("blocked", 0, false, null)).toBeNull();
  });

  it("tells the agent's own turn, and what runs beside it by kind", () => {
    expect(agentActivity("working", 0, false, null)).toEqual({ main: true, agents: 0, commands: 0, workflows: 0, wakeups: 0, wakesAt: null, other: 0, waiting: false });
    const tasks = [task("a", "running", "general-purpose"), task("b", "running", "shell"), task("c", "completed", "explore")];
    expect(agentActivity("working", 2, false, tasks)).toEqual({ main: true, agents: 1, commands: 1, workflows: 0, wakeups: 0, wakesAt: null, other: 0, waiting: false });
  });

  it("keeps telling the background work after the agent's turn ended", () => {
    expect(agentActivity("idle", 2, true, [task("a", "running", "general-purpose"), task("b", "running", null)])).toEqual({ main: false, agents: 2, commands: 0, workflows: 0, wakeups: 0, wakesAt: null, other: 0, waiting: true });
    // the turn waits on work the count has not caught up with
    expect(agentActivity("idle", 0, true, null)).toEqual({ main: false, agents: 0, commands: 0, workflows: 0, wakeups: 0, wakesAt: null, other: 0, waiting: true });
  });

  it("trusts the pushed count over a list read before it changed", () => {
    // before the first read: the count alone
    expect(agentActivity("idle", 3, false, null)).toMatchObject({ agents: 0, commands: 0, other: 3 });
    // a task started since the last read
    expect(agentActivity("idle", 2, false, [task("a", "running", "shell")])).toMatchObject({ commands: 1, other: 1 });
    // everything ended since the last read: the list's running ones are no longer told
    expect(agentActivity("idle", 0, false, [task("a", "running", "shell")])).toBeNull();
  });

  it("tells monitors as commands, workflows and scheduled wake-ups by name, and when the first wake-up is due", () => {
    const tasks = [task("m", "running", "monitor"), task("w", "running", "workflow"), task("late", "running", "wakeup", undefined, "2026-10-24T01:00:00.000Z"),
      task("soon", "running", "wakeup", undefined, "2026-10-24T00:20:00.000Z"), task("a", "running", "general-purpose")];
    expect(agentActivity("idle", 5, false, tasks)).toEqual({ main: false, agents: 1, commands: 1, workflows: 1, wakeups: 2, wakesAt: Date.parse("2026-10-24T00:20:00.000Z"), other: 0, waiting: false });
    // a wake-up alone keeps the line: the agent goes on by itself
    expect(agentActivity("done", 1, false, [task("soon", "running", "wakeup", undefined, "2026-10-24T00:20:00.000Z")])).toMatchObject({ agents: 0, wakeups: 1 });
    const t = (key: string) => `<${key}>`;
    expect([taskKind("monitor", t), taskKind("workflow", t), taskKind("wakeup", t), taskKind("Explore", t), taskKind(null, t)]).toEqual(["<monitor>", "<workflow>", "<wake-up>", "Explore", null]);
    const now = Date.parse("2026-10-24T00:10:00.000Z");
    expect(wakeupInMs(tasks[3]!, now)).toBe(10 * 60_000);
    expect(wakeupInMs({ ...tasks[3]!, status: "completed" }, now)).toBeNull();
    expect(wakeupInMs(tasks[0]!, now)).toBeNull();
    // past its time it reads as now, not as a time gone by
    expect(wakeupInMs(tasks[3]!, now + 20 * 60_000)).toBe(0);
  });

  it("lists what has run longest first", () => {
    const tasks = [task("late", "running", null, "2026-10-24T00:05:00.000Z"), task("done", "completed", null), task("early", "running", null, "2026-10-24T00:01:00.000Z"), task("unknown", "running", null, "")];
    expect(runningTasks(tasks).map((found) => found.id)).toEqual(["early", "late", "unknown"]);
    expect(runningTasks(null)).toEqual([]);
  });
});
