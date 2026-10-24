import { useEffect, useId, useState } from "react";
import { Bot, ChevronDown, ChevronUp, SquareTerminal } from "lucide-react";
import "./AgentActivity.css";

import type { AgentStatus, OmoTask } from "../../shared/protocol.ts";
import { agentActivity, runningTasks, type Activity } from "../lib/agentActivity.ts";
import { agentDisplayLabel } from "../lib/compose.ts";
import { useT, type Translate } from "../lib/i18n.ts";
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

/** "2 subagents · 1 background command": what runs besides the agent, in words. */
function whatRuns(activity: Activity, t: Translate): string | null {
  const parts = [
    activity.agents > 0 ? t(activity.agents === 1 ? "{n} subagent" : "{n} subagents", { n: activity.agents }) : null,
    activity.commands > 0 ? t(activity.commands === 1 ? "{n} background command" : "{n} background commands", { n: activity.commands }) : null,
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
  if (activity === null) return null;

  const name = agentDisplayLabel(agent ?? null);
  const besides = whatRuns(activity, t);
  const summary = activity.main
    ? besides === null ? t("{agent} is working", { agent: name }) : t("{agent} is working · {tasks}", { agent: name, tasks: besides })
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
          {running.map((task) => {
            const elapsed = taskElapsedMs(task, now + offset);
            const Icon = task.category === "shell" ? SquareTerminal : Bot;
            return (
              <li key={task.id} className="agent-activity-task">
                <Icon aria-hidden="true" />
                <span className="agent-activity-task-title" title={task.title}>{task.title}</span>
                {task.category && task.category !== "shell" && <span className="agent-activity-task-kind">{task.category}</span>}
                {elapsed !== null && <span className="agent-activity-task-time">{formatElapsed(elapsed)}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {listable
        ? <button type="button" className="agent-activity-bar" aria-expanded={open} aria-controls={open ? listId : undefined}
            title={open ? t("Hide what is running") : t("Show what is running")} onClick={() => setOpen((shown) => !shown)}>{content}</button>
        : <div className="agent-activity-bar">{content}</div>}
    </div>
  );
}
