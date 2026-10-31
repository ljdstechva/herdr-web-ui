import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import "./TaskView.css";

import { ChatHistoryContext, ChatPaneContext, ChatTaskContext, Turn } from "./ChatView.tsx";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { formatElapsed, taskElapsedMs } from "../lib/omoTasks.ts";
import { taskKind } from "../lib/agentActivity.ts";
import type { ConversationTurn, OmoTask } from "../../shared/protocol.ts";

const POLL_MS = 2500;
/** a terminal's colours and cursor moves: an output file holds what the command printed, as printed */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** What a look inside a task shows: a subagent's conversation, a command's output, or nothing to look at. */
export function taskViewKind(task: Pick<OmoTask, "category">): "conversation" | "output" | null {
  if (task.category === "shell" || task.category === "monitor") return "output";
  if (task.category === "workflow" || task.category === "wakeup") return null;
  return "conversation";
}

/**
 * A look inside one of a Claude pane's background tasks, from the status line's list: a
 * subagent's own conversation drawn as the chat draws turns, or what a background command has
 * printed so far. Read every few seconds while it is open; the reader at the end stays there.
 */
export function TaskView({ paneId, task, onClose }: { paneId: string; task: OmoTask; onClose: () => void }) {
  const t = useT();
  const { settings } = useSettings();
  const { fetchTaskConversation, fetchTaskOutput } = useMachineApi();
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

  useEffect(() => { close.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    if (kind === null) return;
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
          setOutput({ text: next.text.replace(ANSI, ""), cut: next.cut });
        }
        setFailed(false);
      } catch {
        if (alive) setFailed(true);
      }
      if (alive) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { alive = false; clearTimeout(timer); };
  }, [kind, paneId, task.id, fetchTaskConversation, fetchTaskOutput]);

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
  const shown = [...older, ...(turns ?? [])];
  const moreBefore = olderCursor === undefined ? cursor !== null : olderCursor !== null;
  const loading = kind === "conversation" ? turns === null : kind === "output" ? output === null : false;

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal task-view" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <header className="modal-header task-view-header">
          <span className="task-view-heading">
            <h2 className="modal-title task-view-title" id={`${id}-title`}>{task.title}</h2>
            <span className={`task-view-meta is-${task.status}`}>{[words[task.status], meta].filter((item) => item !== "").join(" · ")}</span>
          </span>
          <button ref={close} type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div ref={body} className="modal-body task-view-body" onScroll={onScroll}>
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
    </div>,
    document.body,
  );
}
