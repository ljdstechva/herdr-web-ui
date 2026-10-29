import type { AgentStatus, OmoTask } from "../../shared/protocol.ts";
import type { Translate } from "./i18n.ts";

/**
 * What the chat's activity line says works now: the agent's own turn, and what it started that
 * runs on (its subagents, its background commands), also after its turn ended.
 */
export interface Activity {
  /** the agent itself is in a turn */
  main: boolean;
  /** subagents running (Claude Code's agents, Codex's spawned agents, OmO's tasks) */
  agents: number;
  /** background commands running (Claude Code's `run_in_background` shells, and its monitors' watches) */
  commands: number;
  /** Claude Code's background workflows running */
  workflows: number;
  /** wake-ups Claude Code scheduled for itself, not due yet, and when the first is (null: not told) */
  wakeups: number;
  wakesAt: number | null;
  /** running tasks the list has not described yet: the pane's count, before or behind its list */
  other: number;
  /** the turn ended on work it waits for (server/background-wait.ts) */
  waiting: boolean;
}

/**
 * The activity to show, or null when nothing works. `background` is the pane's running count
 * (pushed at once); `tasks` its list, read every few seconds (null before the first read). The
 * list says which tasks are agents and which are commands; where it holds fewer running tasks
 * than the count, the rest are told as tasks.
 */
export function agentActivity(status: AgentStatus | undefined, background: number, waiting: boolean, tasks: readonly OmoTask[] | null): Activity | null {
  const running = (tasks ?? []).filter((task) => task.status === "running");
  // the count is pushed the moment a task starts or ends; a list read before that says nothing of it
  const listed = background === 0 ? [] : running;
  const commands = listed.filter((task) => task.category === "shell" || task.category === "monitor").length;
  const workflows = listed.filter((task) => task.category === "workflow").length;
  const wakes = listed.filter((task) => task.category === "wakeup");
  const due = wakes.map((task) => Date.parse(task.due_at ?? "")).filter((at) => Number.isFinite(at));
  const agents = listed.length - commands - workflows - wakes.length;
  const other = Math.max(0, background - listed.length);
  const activity: Activity = { main: status === "working", agents, commands, workflows, wakeups: wakes.length, wakesAt: due.length > 0 ? Math.min(...due) : null, other, waiting };
  return activity.main || agents + commands + workflows + wakes.length + other > 0 || waiting ? activity : null;
}

/** The word a running task's kind is listed under: Claude Code's other background work by name, a subagent by its agent type. */
export function taskKind(category: string | null, t: Translate): string | null {
  if (category === "monitor") return t("monitor");
  if (category === "workflow") return t("workflow");
  if (category === "wakeup") return t("wake-up");
  return category;
}

/** How long until a scheduled wake-up is due, or null for any other task. */
export function wakeupInMs(task: OmoTask, now: number): number | null {
  const due = task.category === "wakeup" && task.status === "running" ? Date.parse(task.due_at ?? "") : NaN;
  return Number.isFinite(due) ? Math.max(0, due - now) : null;
}

/** The running tasks to list, longest-running first: what has run longest is what one asks about. */
export function runningTasks(tasks: readonly OmoTask[] | null): OmoTask[] {
  return (tasks ?? []).filter((task) => task.status === "running").sort((a, b) => (Date.parse(a.started_at ?? "") || Infinity) - (Date.parse(b.started_at ?? "") || Infinity));
}
