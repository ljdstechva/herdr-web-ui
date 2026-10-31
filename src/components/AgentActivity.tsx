import { useEffect, useId, useState } from "react";
import { Activity as MonitorIcon, AlarmClock, Bot, ChevronDown, ChevronRight, ChevronUp, CircleCheck, CircleDot, Hourglass, MessageCircleQuestion, SquareTerminal, Workflow, type LucideIcon } from "lucide-react";
import { AgentMark } from "./AgentMark.tsx";
import "./AgentActivity.css";

import type { AgentStatus, OmoTask } from "../../shared/protocol.ts";
import { agentActivity, runningTasks, taskKind, wakeupInMs, type Activity } from "../lib/agentActivity.ts";
import { agentDisplayLabel } from "../lib/compose.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { TaskView, taskViewKind } from "./TaskView.tsx";
import { useMachineApi } from "../lib/machineContext.tsx";
import { clockOffsetMs, formatElapsed, taskElapsedMs } from "../lib/omoTasks.ts";

/** How often the list of what runs is read while something runs in the background. */
const POLL_MS = 3000;

export interface AgentActivityProps {
  paneId: string;
  agent: string | null | undefined;
  status: AgentStatus | undefined;
  /** the pane's running background tasks, as the server pushes them */
  background: number;
  /** the pane's turn ended on work still running, which it waits for */
  waiting: boolean;
}

const TASK_ICONS: Readonly<Record<string, LucideIcon>> = { shell: SquareTerminal, monitor: MonitorIcon, workflow: Workflow, wakeup: AlarmClock };

/** How a row of the list is doing, shown by an icon and a word: the main agent's state, or a task's. */
type RowState = "working" | "needs-you" | "waiting" | "idle" | "running";
const STATE_ICONS: Readonly<Record<RowState, LucideIcon>> = { working: CircleDot, "needs-you": MessageCircleQuestion, waiting: Hourglass, idle: CircleCheck, running: CircleDot };

function StateChip({ state, t }: { state: RowState; t: Translate }) {
  const Icon = STATE_ICONS[state];
  const words: Record<RowState, string> = { working: t("working"), "needs-you": t("Needs you"), waiting: t("waiting"), idle: t("idle"), running: t("running") };
  return <span className={`agent-activity-state is-${state}`}><Icon aria-hidden="true" />{words[state]}</span>;
}

/** The main agent's state: at work, asking the person, waiting on what it started, or at rest. */
export function mainState(status: AgentStatus | undefined, background: number, waiting: boolean): RowState {
  if (status === "working") return "working";
  if (status === "blocked") return "needs-you";
  return waiting || background > 0 ? "waiting" : "idle";
}

/** "2 subagents · 1 background command": what runs besides the agent, in words. */
function whatRuns(activity: Activity, t: Translate): string | null {
  const parts = [
    activity.agents > 0 ? t(activity.agents === 1 ? "{n} subagent" : "{n} subagents", { n: activity.agents }) : null,
    activity.commands > 0 ? t(activity.commands === 1 ? "{n} background command" : "{n} background commands", { n: activity.commands }) : null,
    activity.workflows > 0 ? t(activity.workflows === 1 ? "{n} workflow" : "{n} workflows", { n: activity.workflows }) : null,
    activity.wakeups > 0 ? t(activity.wakeups === 1 ? "{n} scheduled wake-up" : "{n} scheduled wake-ups", { n: activity.wakeups }) : null,
    activity.other > 0 ? t(activity.other === 1 ? "{n} background task" : "{n} background tasks", { n: activity.other }) : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * The chat's line over the message box while the agent works, or while what it started runs on
 * after its turn ended: its subagents and background commands, which the transcript shows only as
 * a call that was made. It opens on what runs and for how long.
 */
export function AgentActivity({ paneId, agent, status, background, waiting }: AgentActivityProps) {
  const t = useT();
  const { fetchPaneOmoActivity } = useMachineApi();
  const [tasks, setTasks] = useState<OmoTask[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  /** the task looked inside (TaskView): it stays open after the task ends and the line goes */
  const [viewing, setViewing] = useState<OmoTask | null>(null);
  const listId = useId();
  const watching = background > 0 || waiting;

  // the list is read while something runs beside the agent, at once when the count changes
  useEffect(() => {
    if (!watching) { setTasks(null); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        const next = await fetchPaneOmoActivity(paneId);
        if (!alive) return;
        const received = Date.now();
        setTasks(next.tasks); setOffset(clockOffsetMs(next.serverTime, received)); setNow(received);
      } catch { /* the count still says that something runs; the list is asked again */ }
      if (alive) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [watching, background, paneId, fetchPaneOmoActivity]);

  // the open list's times run on by the second
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  const activity = agentActivity(status, background, waiting, tasks);
  const running = background > 0 ? runningTasks(tasks) : [];
  useEffect(() => { if (activity === null || running.length === 0) setOpen(false); }, [activity === null, running.length]);
  const view = viewing !== null && <TaskView paneId={paneId} task={tasks?.find((task) => task.id === viewing.id) ?? viewing} onClose={() => setViewing(null)} />;
  if (activity === null) return view || null;

  const name = agentDisplayLabel(agent ?? null);
  const besides = whatRuns(activity, t);
  // at rest with nothing but its next wake-up ahead, the line says when that is
  const onlyWakeup = activity.wakeups > 0 && activity.wakesAt !== null && activity.agents + activity.commands + activity.workflows + activity.other === 0;
  const summary = activity.main
    ? besides === null ? t("{agent} is working", { agent: name }) : t("{agent} is working · {tasks}", { agent: name, tasks: besides })
    : onlyWakeup ? t("{agent} wakes up in {time}", { agent: name, time: formatElapsed(Math.max(0, activity.wakesAt! - (now + offset))) })
    : besides === null ? t("{agent} is waiting on background work", { agent: name }) : t("{tasks} still running", { tasks: besides });
  const listable = running.length > 0;
  const content = <>
    <span className="agent-activity-dot" aria-hidden="true" />
    <span className="agent-activity-text" role="status">{summary}</span>
    {listable && (open ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />)}
  </>;

  return (
    <div className="agent-activity" data-main={activity.main ? "" : undefined}>
      {open && listable && (
        <ul id={listId} className="agent-activity-list">
          <li className="agent-activity-task is-main">
            <AgentMark agent={agent ?? "agent"} size={16} />
            <span className="agent-activity-task-title">{name}</span>
            <span className="agent-activity-role">{t("main agent")}</span>
            <StateChip state={mainState(status, background, waiting)} t={t} />
          </li>
          {running.map((task) => {
            const elapsed = taskElapsedMs(task, now + offset);
            const due = wakeupInMs(task, now + offset);
            const Icon = TASK_ICONS[task.category ?? ""] ?? Bot;
            const kind = task.category === "shell" ? null : taskKind(task.category, t);
            const command = task.category === "shell" || task.category === "monitor";
            const row = <>
              <Icon aria-hidden="true" />
              <span className="agent-activity-task-title" title={task.title}>{task.title}</span>
              <span className="agent-activity-role">{command ? t("command") : task.category === "workflow" || task.category === "wakeup" ? kind : t("subagent")}</span>
              {kind && !command && task.category !== "workflow" && task.category !== "wakeup" && <span className="agent-activity-task-kind">{kind}</span>}
              {due !== null ? <span className="agent-activity-task-time">{t("in {time}", { time: formatElapsed(due) })}</span>
                : elapsed !== null && <span className="agent-activity-task-time">{formatElapsed(elapsed)}</span>}
              <StateChip state={due !== null ? "waiting" : "running"} t={t} />
            </>;
            // a Claude subagent opens on its conversation, a command on what it printed so far
            const opens = agent === "claude" && taskViewKind(task) !== null;
            return (
              <li key={task.id} className={`agent-activity-task${opens ? " is-openable" : ""}`}>
                {opens ? <button type="button" className="agent-activity-task-open" title={t("See inside")} onClick={() => setViewing(task)}>{row}<ChevronRight className="agent-activity-task-go" aria-hidden="true" /></button> : row}
              </li>
            );
          })}
        </ul>
      )}
      {listable
        ? <button type="button" className="agent-activity-bar" aria-expanded={open} aria-controls={open ? listId : undefined}
            title={open ? t("Hide what is running") : t("Show what is running")} onClick={() => setOpen((shown) => !shown)}>{content}</button>
        : <div className="agent-activity-bar">{content}</div>}
      {view}
    </div>
  );
}
