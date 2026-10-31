import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Bot, SquareTerminal } from "lucide-react";

import "./TaskView.css";

import { ChatHistoryContext, ChatPaneContext, ChatTaskContext, Turn } from "./ChatView.tsx";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { formatElapsed, taskElapsedMs } from "../lib/omoTasks.ts";
import { taskKind } from "../lib/agentActivity.ts";
import { outputTail } from "../lib/liveTerminal.ts";
import { handbackAsAnswer } from "../lib/subagentTurns.ts";
import type { ConversationTurn, OmoTask } from "../../shared/protocol.ts";

const POLL_MS = 2500;

/** What a look inside a task shows: a subagent's conversation, a command's output, or nothing to look at. */
export function taskViewKind(task: Pick<OmoTask, "category">): "conversation" | "output" | null {
  if (task.category === "shell" || task.category === "monitor") return "output";
  if (task.category === "workflow" || task.category === "wakeup") return null;
  return "conversation";
}

/**
 * A look inside one of a Claude pane's background tasks, in the chat's place (PaneTerminal keeps
 * the chat mounted under it, so Back returns to it as it was): a subagent's own conversation drawn
 * as the chat draws turns, or what a background command has printed so far. Read every few
 * seconds while it is shown, with the task's own state; the reader at the end stays there.
 */
export function TaskView({ paneId, task: opened, agentName, onClose }: { paneId: string; task: OmoTask; agentName: string; onClose: () => void }) {
  const t = useT();
  const { settings } = useSettings();
  const { fetchTaskConversation, fetchTaskOutput, fetchPaneOmoActivity } = useMachineApi();
  /** the task as the pane's list last read it: it ends while it is looked at */
  const [task, setTask] = useState(opened);
  useEffect(() => setTask(opened), [opened]);
  const kind = taskViewKind(task);
  const id = useId();
  const [turns, setTurns] = useState<ConversationTurn[] | null>(null);
  const [older, setOlder] = useState<ConversationTurn[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [history, setHistory] = useState("");
  const [output, setOutput] = useState<{ text: string; cut: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const atEnd = useRef(true);

  // the keyboard's place is Back: a reader who came by keyboard goes on from there
  useEffect(() => { if (document.activeElement === document.body || document.activeElement?.closest(".agent-activity, .bg-tasks")) close.current?.focus({ preventScroll: true }); }, [opened.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Escape goes back unless something over the view (a menu, a dialog) takes it first
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (kind === null) return;
    setTurns(null); setOlder([]); setOlderCursor(undefined); setOutput(null); setFailed(false); atEnd.current = true;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      try {
        if (kind === "conversation") {
          const next = await fetchTaskConversation(paneId, task.id);
          if (!alive) return;
          setTurns(next.turns); setCursor(next.cursor ?? null); setHistory(next.history_id ?? "");
        } else {
          const next = await fetchTaskOutput(paneId, task.id);
          if (!alive) return;
          setOutput({ text: outputTail(next.text, Infinity), cut: next.cut });
        }
        setFailed(false);
      } catch {
        if (alive) setFailed(true);
      }
      // its state (running → done) from the pane's list, read with it
      await fetchPaneOmoActivity(paneId).then((list) => {
        const now = list.tasks.find((candidate) => candidate.id === opened.id);
        if (alive && now !== undefined) setTask(now);
      }, () => undefined);
      if (alive) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
    // a task's kind never changes: what it is read as follows the task opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, opened.id, fetchTaskConversation, fetchTaskOutput, fetchPaneOmoActivity]);

  // the first earlier page is the one before the newest page's cursor; after it, its own
  const loadOlder = async (): Promise<void> => {
    const before = olderCursor === undefined ? cursor : olderCursor;
    if (before === null) return;
    try {
      const page = await fetchTaskConversation(paneId, task.id, { before });
      setOlder((shown) => [...page.turns, ...shown]);
      setOlderCursor(page.cursor ?? null);
    } catch { setFailed(true); }
  };

  // what arrives keeps a reader at the end there; one who scrolled up reads on in peace
  useLayoutEffect(() => {
    const node = body.current;
    if (node !== null && atEnd.current) node.scrollTop = node.scrollHeight;
  }, [turns, output]);
  const onScroll = (): void => {
    const node = body.current;
    if (node !== null) atEnd.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 48;
  };

  const running = task.status === "running";
  const words: Record<OmoTask["status"], string> = {
    running: t("running"), completed: t("done"), failed: t("failed"), cancelled: t("cancelled"), lost: t("lost"),
  };
  const elapsed = taskElapsedMs(task, Date.now());
  const meta = [taskKind(task.category, t), task.model, elapsed === null ? null : formatElapsed(elapsed)].filter((item) => item !== null).join(" · ");
  // the report a subagent handed back reads as its answer, not as a folded call (lib/subagentTurns.ts)
  const shown = useMemo(() => handbackAsAnswer([...older, ...(turns ?? [])]), [older, turns]);
  const moreBefore = olderCursor === undefined ? cursor !== null : olderCursor !== null;
  const loading = kind === "conversation" ? turns === null : kind === "output" ? output === null : false;

  return (
    <section className="task-view" aria-labelledby={`${id}-title`}>
      <header className="task-view-header">
        <button ref={close} type="button" className="btn btn-ghost task-view-back" onClick={onClose}>
          <ArrowLeft aria-hidden="true" /><span>{t("Back to {agent}", { agent: agentName })}</span>
        </button>
        <div className="task-view-headline">
          {kind === "output" ? <SquareTerminal className="task-view-icon" aria-hidden="true" /> : <Bot className="task-view-icon" aria-hidden="true" />}
          <span className="task-view-heading">
            <h2 className="task-view-title" id={`${id}-title`}>{task.title}</h2>
            <span className={`task-view-meta is-${task.status}`}>{[kind === "output" ? t("command") : t("subagent"), words[task.status], meta].filter((item) => item !== "").join(" · ")}</span>
          </span>
        </div>
      </header>
      <div ref={body} className="task-view-body" onScroll={onScroll}>
        {kind === null && <p className="task-view-note">{t("There is nothing to show inside this task")}</p>}
        {failed && <p className="task-view-note is-error" role="alert">{t("Couldn't read this task. Trying again…")}</p>}
        {loading && !failed && <p className="task-view-note" role="status">{t("Loading…")}</p>}
        {kind === "conversation" && turns !== null && <ChatPaneContext.Provider value={paneId}><ChatHistoryContext.Provider value={history}><ChatTaskContext.Provider value={task.id}>
          <div className="chat-transcript task-view-transcript">
            {moreBefore && <button type="button" className="btn btn-ghost chat-older" onClick={() => void loadOlder()}>{t("Earlier messages")}</button>}
            {shown.map((turn, index) => <Turn key={`${turn.role}:${turn.ts ?? index}:${index}`} paneId={paneId} turn={turn} live={running && index === shown.length - 1} waiting={false} showThinking={settings.showThinking} entered={false} />)}
            {shown.length === 0 && <p className="task-view-note">{t("Nothing written yet")}</p>}
          </div>
        </ChatTaskContext.Provider></ChatHistoryContext.Provider></ChatPaneContext.Provider>}
        {kind === "output" && output !== null && <>
          {output.cut && <p className="task-view-note">{t("The last 64 KB of the output")}</p>}
          <pre className="task-view-output">{output.text.length > 0 ? output.text : t("Nothing printed yet")}</pre>
        </>}
      </div>
    </section>
  );
}
