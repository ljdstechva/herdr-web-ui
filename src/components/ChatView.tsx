import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown, BookOpen, Check, ChevronDown, ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, CircleHelp, CircleSlash, CircleX, Copy, Layers, MessageSquareText, SquareTerminal, TableOfContents, Target, X,
  type LucideProps,
} from "lucide-react";

import "./ChatView.css";

import { AgentMark } from "./AgentMark.tsx";
import { Markdown } from "./Markdown.tsx";
import { PromptCard } from "./PromptCard.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { turnRevision } from "../lib/turnRevision.ts";
import { useWholeOutput as useScopedOutput } from "../lib/useWholeOutput.ts";
import { turnSkills } from "../lib/skillActivity.ts";
import { ApiError } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { toTranscriptMessages, type TranscriptMessage } from "../lib/transcript.ts";
import { isLiveWorkTurn, isWaitingWorkTurn, formatWorkDuration, splitTurn, workFailed, workStartsOpen, workSummary, type ToolPart as ToolPartType } from "../lib/workBlocks.ts";
import { phaseRows, planRows, taskRows, todoRows, type ChecklistRow } from "../lib/checklist.ts";
import { isTodoTool, parseTodoAnswer, todoCallSummary, type TodoItem, type TodoStatus } from "../lib/todos.ts";
import { formatGoalTime, turnGoal, type GoalState, type GoalStatus } from "../lib/goals.ts";
import { useSettings } from "../lib/settings.ts";
import { statusEdgeRead } from "../lib/status.ts";
import { ConversationRefresh } from "../lib/conversationRefresh.ts";
import { usePageVisible } from "../lib/visibility.ts";
import { dismissKeyboardOn } from "../lib/keyboard.ts";
import { useFacesArrived } from "../lib/fontFaces.ts";
import { FileUrlContext, OpenFileContext } from "../lib/filePaths.ts";
import { patchText } from "../../shared/patch.ts";
import { toolVerb } from "../lib/toolVerbs.ts";
import { machinePath, paneStorageId } from "../../shared/machines.ts";
import { outbox, sentBaseline, transcriptHolds, type OutgoingMessage, type SentBaseline } from "../lib/outbox.ts";
import { fileUrl } from "../lib/api.ts";
import { useMachineId } from "../lib/machineContext.tsx";
import { lineDiff } from "../lib/diff.ts";
import { formatTokens, sameMessage } from "../lib/compose.ts";
import { formatElapsed, taskCallItems, taskResultMarkdown } from "../lib/omoTasks.ts";
import { sendUserFileCall } from "../lib/sendUserFile.ts";
import { chatOutline, type OutlineEntry } from "../lib/chatOutline.ts";
import { outputTail, runningTool, screenTail } from "../lib/liveTerminal.ts";

/** The pane this chat shows, for what its rows fetch on request (a tool call's whole output). */
export const ChatPaneContext = createContext<string | null>(null);
export const ChatHistoryContext = createContext("");
/** Set where the turns drawn are a subagent's (TaskView): a call's whole output is in its transcript, not the pane's. */
export const ChatTaskContext = createContext<string | null>(null);
import type { TypedAnswer } from "../lib/promptAnswer.ts";
import type { AgentStatus, ConversationMetadata, ConversationPart, ConversationTurn, InteractivePrompt, OmoTaskResult } from "../../shared/protocol.ts";
import { chatIsBlank, type ChatRead } from "../lib/greeting.ts";
import { currentLocale, useT } from "../lib/i18n.ts";

const TRANSCRIPT_LINES = 400;
const PROMPT_POLL_MS = 2000;
/** how often the end of the screen is read while a call runs (lib/liveTerminal.ts) */
const LIVE_SCREEN_MS = 1500;
/** how long an answer picked in the outline stays marked */
const PICKED_MS = 1600;
const OUTLINE_ICONS: Record<OutlineEntry["kind"], ComponentType<LucideProps>> = { answer: MessageSquareText, question: CircleHelp, result: Layers };
/** Scrolling this close to the top asks for the page before it. */
const LOAD_OLDER_PX = 400;

export interface ChatViewProps {
  paneId: string;
  refreshKey: number;
  /** bumped by a conversation push; coalesced at the former 2s polling cadence */
  invalidationKey?: number;
  /** only a mounted, visible chat asks the bridge to watch its native conversation */
  onConversationWatch?: (paneId: string, enabled: boolean) => void;
  /** the bridge pushes this pane's transcript changes; without, the chat reads every 2s as before */
  conversationPushes?: boolean;
  /** while the chat shows herdr's scrollback, the pane's terminal output invalidates it */
  onTerminalOutput?: (listener: (() => void) | null) => void;
  /** bumped when a composer message goes out, before the transcript holds it */
  sentKey?: number;
  connected: boolean;
  ended: boolean;
  agent: string | null;
  agentStatus?: AgentStatus;
  onMetadata?: (paneId: string, metadata: ConversationMetadata | null) => void;
  /** what the last read says of the conversation, for the composer's greeting; null while nothing is known (loading, a failed read, the chat gone) */
  onRead?: (paneId: string, read: ChatRead | null) => void;
  /** the composer shows its greeting: the chat's own "nothing yet" line stays out */
  greeted?: boolean;
  /** the agent's waiting prompt, for the composer to answer too */
  onPrompt?: (paneId: string, prompt: InteractivePrompt | null) => void;
  /** with no prompt waiting, the next prompt the agent suggests (Claude's grey input text) */
  onSuggestion?: (paneId: string, suggestion: string | null) => void;
  /** a cancelled send the agent put back in its input box: the composer fills it again, and it is no sent turn here either */
  onRestored?: (paneId: string, restored: string | null) => void;
  /** a Codex pane's Fast mode as each prompt read finds its screen; null where the screen does not say */
  onFast?: (paneId: string, fast: boolean | null) => void;
  /** bumped after the composer answered: read the prompt again now */
  promptRefreshKey?: number;
  /** a typed pick of an approval's option, waiting in the card for Confirm */
  pendingAnswer?: { promptId: string; answer: TypedAnswer } | null;
  /** the pick is done with (sent, cancelled): named by its pane and prompt, so another's pick is left alone; with no prompt, whichever pick the pane has */
  onPendingAnswerDone?: (paneId: string, promptId?: string) => void;
  /** where the prompt card is drawn: on the composer's column, over the input card (PaneTerminal
   * owns the place). The chat still owns the prompt, so the card is rendered from here into it */
  promptDock?: HTMLElement | null;
  /** a prompt was answered from its card; `toMessageBox`: the keyboard's focus was in the card and may go on to the message box */
  onPromptAnswered?: (toMessageBox: boolean) => void;
}

interface ChatState {
  source: "conversation" | "scrollback";
  conversationSource?: string;
  turns: ConversationTurn[];
  messages: TranscriptMessage[];
  /** The unmodified, ANSI-stripped screen when a native conversation cannot be read. */
  terminalText?: string;
  truncated: boolean;
}

const EMPTY_STATE: ChatState = { source: "conversation", turns: [], messages: [], truncated: false };


function formatTime(ts: string | null): string | null {
  if (ts === null) return null;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
}

function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gi, "$1")
    .replace(/(?:\*\*|__|~~|`)(.*?)(?:\*\*|__|~~|`)/g, "$1")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/^>\s?/gm, "");
}

/** A quiet text button that copies and says "Copied" for a moment. */
function CopyButton({ text, label, className = "icon-button chat-copy", children, onResult }: { text: string; label: string; className?: string; children?: React.ReactNode; onResult: (ok: boolean) => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    const ok = await copyText(text);
    setCopied(ok);
    onResult(ok);
    if (ok) window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className={copied ? `${className} is-copied` : className} onClick={() => void copy()} aria-label={copied ? t("Copied") : label} title={copied ? t("Copied") : label}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {children}
    </button>
  );
}

function ChecklistView({ rows }: { rows: ChecklistRow[] }) {
  return <ul className="chat-checklist">{rows.map((row, index) => (
    <li key={index} className={row.heading ? "chat-checklist-phase" : row.done ? "is-done" : row.active ? "is-active" : undefined}>
      {!row.heading && <span className="chat-checklist-box" aria-hidden="true">{row.done ? "✓" : "•"}</span>}{row.label}
    </li>
  ))}</ul>;
}

const TODO_ICONS: Record<TodoStatus, ComponentType<LucideProps>> = {
  completed: CircleCheck, in_progress: CircleDot, pending: Circle, blocked: CircleAlert, dropped: CircleSlash,
};
const TODO_LABELS: Record<TodoStatus, string> = {
  completed: "done", in_progress: "in progress", pending: "to do", blocked: "blocked", dropped: "dropped",
};

/** A todo list by phase: one row per item, its state as an icon (and in words, for screen readers). */
function TodoList({ items }: { items: TodoItem[] }) {
  const groups: { phase: string | null; items: TodoItem[] }[] = [];
  for (const item of items) {
    const group = groups[groups.length - 1];
    if (group && group.phase === item.phase) group.items.push(item); else groups.push({ phase: item.phase, items: [item] });
  }
  return <div className="todo-list">{groups.map((group, index) => (
    <div key={index} className="todo-group">
      {group.phase !== null && <p className="todo-phase">{group.phase}</p>}
      <ul>{group.items.map((item, row) => {
        const Icon = TODO_ICONS[item.status];
        return <li key={row} className={`todo-item is-${item.status}`}>
          <Icon className="todo-icon" aria-hidden="true" />
          <span className="todo-label">{item.label}<span className="sr-only"> ({TODO_LABELS[item.status]})</span>{item.note && <span className="todo-note">{item.note}</span>}</span>
        </li>;
      })}</ul>
    </div>
  ))}</div>;
}

function ompEditLineClass(line: string): string | undefined {
  if (line.startsWith("+-") || line.startsWith("-") || /^(CUT|REM)\b/.test(line)) return "chat-diff-del";
  if (line.startsWith("+")) return "chat-diff-add";
  if (/^(PUT|MV)/.test(line) || line.startsWith("[")) return "chat-diff-head";
  return undefined;
}

/** A file a tool call names: it opens in the viewer where one can, and reads as text elsewhere. */
function ToolFile({ path, suffix }: { path: string; suffix?: string }) {
  const t = useT();
  const open = useContext(OpenFileContext);
  if (open === null) return <p className="chat-tool-file">{path}{suffix}</p>;
  return <p className="chat-tool-file"><button type="button" className="chat-tool-file-link" title={t("Open {path}", { path })} onClick={() => open(path)}>{path}</button>{suffix}</p>;
}

/** An edit's old and new text as one diff: the unchanged lines once, the changes in place. */
function EditDiff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  return <pre className="chat-diff">{lines.map((line, index) =>
    <span key={index} className={line.kind === "add" ? "chat-diff-add" : line.kind === "del" ? "chat-diff-del" : undefined}>{line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}{line.text}{"\n"}</span>)}</pre>;
}

/** A Codex patch as a diff: each file it touches a header that opens it, then its lines coloured. */
function PatchView({ patch }: { patch: string }) {
  const sections: Array<{ file: string | null; action: string; lines: string[] }> = [];
  for (const line of patch.split("\n")) {
    const file = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(line);
    if (file !== null) { sections.push({ file: file[2]!.trim(), action: file[1]!, lines: [] }); continue; }
    if (/^\*\*\* (Begin|End) Patch/.test(line)) continue;
    if (sections.length === 0) sections.push({ file: null, action: "", lines: [] });
    sections.at(-1)!.lines.push(line);
  }
  // the blank line a patch ends on is not part of any file
  for (const section of sections) while (section.lines.at(-1)?.trim() === "") section.lines.pop();
  const lineClass = (line: string): string | undefined =>
    line.startsWith("@@") || line.startsWith("*** Move to:") ? "chat-diff-head" : line.startsWith("+") ? "chat-diff-add" : line.startsWith("-") ? "chat-diff-del" : undefined;
  return <div className="chat-tool-io">{sections.map((section, index) => <div key={index}>
    {section.file !== null && <ToolFile path={section.file} suffix={section.action === "Update" ? undefined : ` (${section.action.toLowerCase()})`} />}
    {section.lines.length > 0 && <pre className="chat-diff">{section.lines.map((line, at) => <span key={at} className={lineClass(line)}>{line}{"\n"}</span>)}</pre>}
  </div>)}</div>;
}

function ToolInputView({ part }: { part: ToolPartType }) {
  const t = useT();
  if (part.arguments_omitted) return <pre className="chat-tool-io">{t("Arguments omitted (too large)")}</pre>;
  // a todo call shows the list as it stood after it, when the agent answered with it
  const after = isTodoTool(part.name) ? parseTodoAnswer(part.output) : null;
  if (after !== null && after.length > 0) return <TodoList items={after} />;
  const patch = patchText(part.input);
  if (patch !== null) return <PatchView patch={patch} />;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(part.input) as Record<string, unknown>; }
  catch { return <pre className="chat-tool-io">{part.input}</pre>; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return <pre className="chat-tool-io">{part.input}</pre>;
  // an OmO or omp `task` call: the tasks it starts, not its JSON or a checklist nobody ticks
  const spawned = part.name === "task" ? taskCallItems(parsed) : null;
  if (spawned !== null) return <ol className="chat-task-calls">{spawned.map((item, index) => <li key={index} className="chat-task-call">
    <p className="chat-task-call-head"><span className="chat-task-call-title">{item.title}</span>{item.agent !== null && <span className="chat-task-call-agent">{item.agent}</span>}</p>
    {item.prompt.length > 0 && <pre className="chat-tool-io chat-task-call-prompt">{item.prompt}</pre>}
  </li>)}</ol>;
  const str = (key: string): string | undefined => typeof parsed[key] === "string" ? parsed[key] : undefined;
  const command = str("command") ?? str("cmd");
  if (command !== undefined) return <div className="chat-tool-io"><pre>{command}</pre>{(str("cwd") ?? str("description")) !== undefined && <p className="chat-tool-io-meta">{str("cwd") ?? str("description")}</p>}</div>;
  const oldString = str("old_string");
  const newString = str("new_string");
  if (oldString !== undefined || newString !== undefined) return <div className="chat-tool-io">{str("file_path") !== undefined && <ToolFile path={str("file_path")!} />}<EditDiff before={oldString ?? ""} after={newString ?? ""} /></div>;
  // several edits to one file: each its own diff, in order
  if (Array.isArray(parsed["edits"]) && parsed["edits"].every((item) => item !== null && typeof item === "object")) {
    const edits = parsed["edits"] as Array<Record<string, unknown>>;
    return <div className="chat-tool-io">{str("file_path") !== undefined && <ToolFile path={str("file_path")!} />}{edits.map((item, index) =>
      <EditDiff key={index} before={typeof item["old_string"] === "string" ? item["old_string"] : ""} after={typeof item["new_string"] === "string" ? item["new_string"] : ""} />)}</div>;
  }
  // SendUserFile: the files it names, openable where the viewer already opens any other path
  const sendUserFile = sendUserFileCall(parsed);
  if (sendUserFile !== null) return <div className="chat-tool-io">
    {sendUserFile.caption.length > 0 && <p className="chat-tool-io-meta">{sendUserFile.caption}</p>}
    {sendUserFile.files.map((file, index) => <ToolFile key={`${index}:${file}`} path={file} />)}
  </div>;
  const editScript = str("input");
  if (editScript !== undefined) return <pre className="chat-tool-io chat-diff">{editScript.split("\n").map((line, index) => <span key={index} className={ompEditLineClass(line)}>{line}{"\n"}</span>)}</pre>;
  const content = str("content");
  if (content !== undefined) return <div className="chat-tool-io">{(str("file_path") ?? str("path")) !== undefined && <ToolFile path={(str("file_path") ?? str("path"))!} />}<pre>{content}</pre></div>;
  const path = str("file_path") ?? str("path");
  if (path !== undefined) return <div className="chat-tool-io"><ToolFile path={path} suffix={str("pattern") !== undefined ? ` — /${str("pattern")}/` : undefined} /></div>;
  for (const [key, toRows] of [["list", phaseRows], ["todos", todoRows], ["plan", planRows], ["tasks", taskRows]] as const) {
    const value = parsed[key];
    if (Array.isArray(value)) {
      const rows = toRows(value);
      if (rows.length > 0) return <ChecklistView rows={rows} />;
    }
  }
  return <pre className="chat-tool-io">{part.input}</pre>;
}

/** A cut output's rest, fetched when asked for: the page carries the first few thousand characters. */
function useWholeOutput(ref: string | undefined): { text: string | null; state: "idle" | "loading" | "failed"; load: () => void } {
  const paneId = useContext(ChatPaneContext);
  const machineId = useMachineId();
  const history = useContext(ChatHistoryContext);
  const task = useContext(ChatTaskContext);
  const url = ref === undefined || paneId === null ? null : task !== null
    ? machinePath(machineId, `pane/task/tool-output?${new URLSearchParams({ pane_id: paneId, task_id: task, ref }).toString()}`)
    : machinePath(machineId, `pane/conversation/tool-output?${new URLSearchParams({ pane_id: paneId, ref }).toString()}`);
  return useScopedOutput(url, history);
}

/** Images a tool returned (pi reads a picture into the result); opened with the row. */
function ToolImages({ paneId, part }: { paneId: string; part: ToolPartType }) {
  const t = useT();
  const machineId = useMachineId();
  if (part.images === undefined || part.images.length === 0) return null;
  return <div className="chat-tool-images">{part.images.map((image) => {
    const src = machinePath(machineId, `pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: image.ref }).toString()}`);
    return <a key={image.ref} className="chat-user-image" href={src} target="_blank" rel="noopener noreferrer" title={t("Open image")}><img src={src} alt={t("Attached image")} loading="lazy" /></a>;
  })}</div>;
}

/**
 * One row of a work block: `▸ Ran bun test`, expanding to the call's input and output. A tool the
 * verb table knows reads as verb + object, and its id moves to the title and the opened detail;
 * any other keeps its id in front, as the agent names it.
 */
function WorkRow({ paneId, part }: { paneId: string; part: ToolPartType }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const whole = useWholeOutput(part.output_ref);
  const summary = part.arguments_omitted ? t("Arguments omitted (too large)") : todoCallSummary(part) ?? part.summary;
  // reads the call's input: once per call, not on every poll of the transcript
  const verb = useMemo(() => toolVerb({ name: part.name, input: part.input }, summary), [part.name, part.input, summary]);
  // the list is the answer of a todo call: its raw text would say it twice
  const output = isTodoTool(part.name) && parseTodoAnswer(part.output) !== null ? "" : whole.text ?? part.output;
  return <div className={`work-row${part.error ? " is-error" : ""}`}>
    <button type="button" className="work-row-head" aria-expanded={open} title={verb !== null ? `${part.name} · ${summary}` : undefined} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      {verb !== null ? <span className="work-row-name is-verb">{t(verb)}</span> : <span className="work-row-name">{part.name}</span>}
      {/* the spaces are for a screen reader: the row is read as words, not "Ranbun test" */}
      {part.error && verb === null && <>{" "}<span className="work-row-failed">{t("failed")}</span></>}
      {summary.length > 0 && summary !== part.name && <>{" "}<span className="work-row-summary">{summary}</span></>}
      {/* after a verb the word follows the object: "Ran pnpm test failed", not "Ran failed pnpm test" */}
      {part.error && verb !== null && <>{" "}<span className="work-row-failed">{t("failed")}</span></>}
    </button>
    {open && <div className="work-row-detail">{verb !== null && <p className="work-row-tool">{part.name}</p>}<ToolInputView part={part} /><ToolImages paneId={paneId} part={part} />{output.length > 0 && <section className="chat-tool-output"><h4>{t(part.error ? "Error" : "Output")}</h4><pre className={`chat-tool-io${whole.text !== null ? " is-whole" : ""}`}>{output}</pre>
      {part.output_ref !== undefined && whole.text === null && <button type="button" className="btn btn-ghost chat-tool-more" disabled={whole.state === "loading"} onClick={whole.load}>
        {t(whole.state === "loading" ? "Loading the whole output…" : whole.state === "failed" ? "Couldn't load the whole output — retry" : "Show the whole output ({size} characters)", { size: formatTokens(part.output_size ?? 0) })}
      </button>}</section>}</div>}
  </div>;
}

function ThinkingRow({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return <div className="work-row work-row-thinking">
    <button type="button" className="work-row-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <span className="work-row-name">{t("thinking")}</span>
    </button>
    {open && <div className="work-row-detail work-thinking-text">{text}</div>}
  </div>;
}

/**
 * Everything the agent did on the way — tool calls, reasoning and the narration
 * between them — under one header ("Worked for 7s · 1 edit"). Rows stay one line
 * each until opened; the narration between them is answer prose while the turn runs, dim after.
 */
function WorkBlockView({ paneId, parts, duration, live, waiting, defaultOpen, showThinking }: { paneId: string; parts: ConversationPart[]; duration: string | null; live: boolean; waiting: boolean; defaultOpen: boolean; showThinking: boolean }) {
  const t = useT();
  const [chosenOpen, setOpen] = useState<boolean | null>(null);
  const open = chosenOpen ?? defaultOpen;
  // reading or working inside the block is a choice to keep it: the fold at the end of the turn
  // must not take the rows from under the reader's focus or close the row they opened
  const keepOpen = () => { if (chosenOpen === null) setOpen(true); };
  const visible = parts.filter((part) => part.kind !== "skill" && (showThinking || part.kind !== "thinking"));
  if (visible.length === 0) return null;
  const summary = workSummary(parts);
  const failed = workFailed(parts);
  // a blocked agent is not working: the open block takes the sidebar's words for it
  const title = waiting ? t("Needs you") : live ? t("Working…") : duration !== null ? t("Worked for {duration}", { duration }) : t("Worked");
  return <section className={`work-block${live ? " is-live" : ""}${waiting ? " is-waiting" : ""}${open ? "" : " is-folded"}`}>
    <button type="button" className="work-block-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="work-row-caret" aria-hidden="true">{open ? <ChevronDown /> : <ChevronRight />}</span>
      <span className="work-block-title">{title}</span>
      {summary.length > 0 && <span className="work-block-summary">· {summary}</span>}
      {/* its own span: the counts before it are cut on a narrow screen, a failure never is */}
      {failed > 0 && <span className="work-block-failed">· {t("{n} failed", { n: failed })}</span>}
    </button>
    {open && <div className="work-block-rows" onFocus={keepOpen} onClick={keepOpen}>{visible.map((part, index) =>
      part.kind === "thinking" ? <ThinkingRow key={index} text={part.text} />
        : part.kind === "text" ? <div key={index} className="work-narration"><Markdown>{part.text}</Markdown></div>
          : part.kind === "tool" ? <WorkRow key={index} paneId={paneId} part={part} /> : null)}</div>}
  </section>;
}

/** Skill evidence stays visible even when the surrounding work block is folded. */
function SkillActivityList({ parts }: { parts: ConversationPart[] }) {
  const t = useT();
  const skills = turnSkills(parts);
  if (skills.length === 0) return null;
  return <div className="chat-skills" role="group" aria-label={t("Skill activity")}>
    {skills.map((skill) => <details className={`chat-skill${skill.status === "failed" ? " is-error" : ""}`} key={`${skill.evidence}:${skill.path ?? skill.name}`}>
      <summary><BookOpen aria-hidden="true" /><span className="chat-skill-name">{skill.name}</span><span className="chat-skill-status">{
        skill.evidence === "invocation"
          ? skill.status === "failed" ? t("Skill invocation failed") : skill.status === "requested" ? t("Skill requested") : t("Skill invoked")
          : skill.status === "failed" ? t("Skill read failed") : skill.status === "requested" ? t("Reading skill requested") : t("Skill instructions loaded")
      }</span><ChevronDown className="chat-skill-caret" aria-hidden="true" /></summary>
      <div className="chat-skill-detail"><p>{skill.evidence === "invocation" ? t("Recorded by the agent's Skill tool. This does not mean the skill's work is complete.") : t("The transcript records loading this skill's instructions. This does not confirm every step was followed.")}</p>
        {skill.path && <code>{skill.path}</code>}
      </div>
    </details>)}
  </div>;
}

/** The goal as this turn left it: like a skill, visible while the work block is folded. */
function GoalActivity({ goal }: { goal: GoalState }) {
  const t = useT();
  const word: Record<GoalStatus, string> = {
    active: t("in progress"), paused: t("paused"), blocked: t("blocked"), complete: t("complete"), budget_limited: t("out of budget"),
  };
  const spent = [
    goal.timeUsedSeconds !== null && goal.timeUsedSeconds > 0 ? formatGoalTime(goal.timeUsedSeconds) : null,
    goal.tokensUsed !== null && goal.tokensUsed > 0 ? t("{n} tokens", { n: formatTokens(goal.tokensUsed) }) : null,
  ].filter((item) => item !== null).join(" · ");
  return <details className={`chat-goal is-${goal.status}`}>
    <summary><Target aria-hidden="true" /><span className="chat-goal-label">{t("Goal")}</span><span className="chat-goal-objective">{goal.objective}</span>
      <span className="chat-goal-status">{word[goal.status]}</span><ChevronDown className="chat-skill-caret" aria-hidden="true" /></summary>
    <div className="chat-goal-detail">
      <p className="chat-goal-text">{goal.objective}</p>
      {goal.blockedReason !== null && <p className="chat-goal-reason">{goal.blockedReason}</p>}
      {spent.length > 0 && <p className="chat-goal-spent">{t("Used so far: {spent}", { spent })}</p>}
    </div>
  </details>;
}

/** Image files a message mentions as `@path`, the way this app attaches them: shown as thumbnails. */
const IMAGE_MENTION = /(?:^|\s)@(\S+\.(?:png|jpe?g|gif|webp))(?=\s|$)/gi;

function UserImages({ paneId, parts, text }: { paneId: string; parts: ConversationPart[]; text: string }) {
  const t = useT();
  const machineId = useMachineId();
  const open = useContext(OpenFileContext);
  const pasted = parts.filter((part): part is Extract<ConversationPart, { kind: "image" }> => part.kind === "image");
  const mentioned = [...new Set([...text.matchAll(IMAGE_MENTION)].map((match) => match[1]!))];
  if (pasted.length === 0 && mentioned.length === 0) return null;
  return <div className="chat-user-images">
    {pasted.map((part) => {
      const src = machinePath(machineId, `pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: part.ref }).toString()}`);
      return <a key={part.ref} className="chat-user-image" href={src} target="_blank" rel="noopener noreferrer" title={t("Open image")}><img src={src} alt={t("Attached image")} loading="lazy" /></a>;
    })}
    {mentioned.map((path) => {
      const src = fileUrl(path, paneId, machineId);
      return open !== null
        ? <button key={path} type="button" className="chat-user-image" title={t("Open {path}", { path })} onClick={() => open(path)}><img src={src} alt={path} loading="lazy" /></button>
        : <a key={path} className="chat-user-image" href={src} target="_blank" rel="noopener noreferrer" title={path}><img src={src} alt={path} loading="lazy" /></a>;
    })}
  </div>;
}

interface TurnProps {
  paneId: string;
  turn: ConversationTurn;
  /** the last turn while the agent runs: its work block reads "Working…" */
  live: boolean;
  /** ...and "Needs you" while the agent is blocked */
  waiting: boolean;
  showThinking: boolean;
  /** arrived after the transcript was first drawn: an agent's turn rises in (ChatView.css .is-entered) */
  entered: boolean;
  /** the turn's name in the chat's outline, on its outermost element: a pick there scrolls to it */
  anchor?: string;
}

const TASK_RESULT_ICONS: Record<OmoTaskResult["status"], ComponentType<LucideProps>> = { completed: CircleCheck, failed: CircleX, cancelled: CircleSlash };

/** One OmO background task that ended: what it was and how it went, and what it found on request. */
function TaskResultRow({ task }: { task: OmoTaskResult }) {
  const t = useT();
  const Icon = TASK_RESULT_ICONS[task.status];
  const word: Record<OmoTaskResult["status"], string> = { completed: t("done"), failed: t("failed"), cancelled: t("cancelled") };
  const meta = [
    task.agent, task.model, task.duration_ms === null ? null : formatElapsed(task.duration_ms),
    task.turns === null ? null : t(task.turns === 1 ? "{n} turn" : "{n} turns", { n: task.turns }),
    task.tool_calls === null ? null : t(task.tool_calls === 1 ? "{n} tool call" : "{n} tool calls", { n: task.tool_calls }),
    task.tokens === null || task.tokens === 0 ? null : t("{n} tokens", { n: formatTokens(task.tokens) }),
  ].filter((item) => item !== null).join(" · ");
  // the answer is drawn once the row is opened: a wake can carry many tasks, each with a long answer
  const [opened, setOpened] = useState(false);
  return <details className={`chat-task-result is-${task.status}`} onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
    <summary>
      <Icon className="chat-task-result-icon" aria-hidden="true" />
      <span className="chat-task-result-main">
        <span className="chat-task-result-title">{task.title}</span>
        {meta.length > 0 && <span className="chat-task-result-meta">{meta}</span>}
      </span>
      <span className="chat-task-result-status">{word[task.status]}</span>
      <ChevronDown className="chat-skill-caret" aria-hidden="true" />
    </summary>
    {opened && <div className="chat-task-result-body">
      {task.result.length > 0 ? <Markdown>{taskResultMarkdown(task.result)}</Markdown> : <p className="chat-task-result-note">{t("The task reported no result")}</p>}
      {task.result_cut === true && <p className="chat-task-result-note">{t("This is the first part of a longer result")}</p>}
    </div>}
  </details>;
}

/** what a runtime notice was: a background result by name, anything else by its own first line */
function noticeLabel(t: ReturnType<typeof useT>, notice: Extract<ConversationPart, { kind: "notice" }>): string {
  if (notice.source === undefined || notice.source === "async-result") return t("Background result delivered");
  const first = notice.text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? notice.source;
  return first.length > 96 ? `${first.slice(0, 95)}…` : first;
}

// a turn that did not change keeps its object across polls: skip re-rendering it
export const Turn = memo(function Turn({ paneId, turn, live, waiting, showThinking, entered, anchor }: TurnProps) {
  const t = useT();
  // under the turn, not in its meta row: that row fades out once the pointer and focus leave
  const [copyFailed, setCopyFailed] = useState(false);
  const copyError = copyFailed && <p className="chat-copy-error" role="alert">{t("Couldn't copy. Select the text and copy it manually.")}</p>;
  const copied = (ok: boolean): void => setCopyFailed(!ok);
  const time = formatTime(turn.ts);
  const compact = turn.parts.find((part): part is Extract<ConversationPart, { kind: "compact" }> => part.kind === "compact");
  if (compact !== undefined) {
    return <details className="chat-compact" data-turn-key={anchor}>
      <summary>{t("Conversation compacted")}{time !== null && <> · <time dateTime={turn.ts ?? undefined}>{time}</time></>}</summary>
      <div className="chat-compact-text"><Markdown>{compact.text}</Markdown></div>
    </details>;
  }
  // OmO's background tasks reported back: a card of what ended, each result on request
  const ended = turn.parts.find((part): part is Extract<ConversationPart, { kind: "task_result" }> => part.kind === "task_result");
  if (ended !== undefined) {
    const heading = ended.tasks.length === 1 ? t("Background task ended") : t("{n} background tasks ended", { n: ended.tasks.length });
    return <section className="chat-task-results" aria-label={heading} data-turn-key={anchor}>
      <p className="chat-task-results-head"><Layers aria-hidden="true" /><span>{heading}</span>{time !== null && <> · <time dateTime={turn.ts ?? undefined}>{time}</time></>}</p>
      {ended.tasks.map((task) => <TaskResultRow key={task.id} task={task} />)}
    </section>;
  }
  // the runtime spoke, not the user: a quiet divider like a compaction, the text on request
  const notice = turn.parts.find((part): part is Extract<ConversationPart, { kind: "notice" }> => part.kind === "notice");
  if (notice !== undefined) {
    return <details className="chat-compact chat-notice" data-turn-key={anchor}>
      <summary><span className="chat-notice-label">{noticeLabel(t, notice)}</span>{time !== null && <> · <time dateTime={turn.ts ?? undefined}>{time}</time></>}</summary>
      <pre className="chat-compact-text chat-notice-text">{notice.text}</pre>
    </details>;
  }
  if (turn.role === "user") {
    const text = turn.parts.filter((part): part is Extract<ConversationPart, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n\n");
    return <article className="chat-turn chat-turn-user" data-turn-key={anchor}>
      <UserImages paneId={paneId} parts={turn.parts} text={text} />
      {/* one row: with a mouse the time and copy sit beside the bubble, on touch under it */}
      <div className="chat-user-row">
        {text.length > 0 && <div className="chat-bubble"><Markdown>{text}</Markdown></div>}
        <div className="chat-turn-meta">{time !== null && <time dateTime={turn.ts ?? undefined}>{time}</time>}{text.length > 0 && <CopyButton text={text} label={t("Copy message")} onResult={copied} />}</div>
      </div>
      {copyError}
      {/* the skill this message invoked (omp, omo, pi): the runtime recorded its instructions with it */}
      <SkillActivityList parts={turn.parts} />
    </article>;
  }
  const { work, answer } = splitTurn(turn.parts);
  const answerText = answer.map((part) => part.text).join("\n\n");
  const goal = turnGoal(turn.parts);
  return <article className={`chat-turn chat-turn-agent${entered ? " is-entered" : ""}`} data-turn-key={anchor}>
    <SkillActivityList parts={turn.parts} />
    {goal !== null && <GoalActivity goal={goal} />}
    {work.length > 0 && <WorkBlockView paneId={paneId} parts={work} duration={formatWorkDuration(turn.ts, turn.end_ts ?? null)} live={live} waiting={waiting} defaultOpen={workStartsOpen(live, turn.parts)} showThinking={showThinking} />}
    {answer.map((part, index) => <Markdown key={index}>{part.text}</Markdown>)}
    {answerText.length > 0 && <div className="chat-turn-meta chat-agent-meta">
      {/* a mouse reads one copy glyph and the words "Plain text"; touch reads the two formats */}
      <CopyButton className="chat-meta-btn" text={answerText} label={t("Copy as markdown")} onResult={copied}><span className="chat-meta-fmt">MD</span></CopyButton>
      <CopyButton className="chat-meta-btn chat-meta-plain" text={plainText(answerText)} label={t("Copy as plain text")} onResult={copied}><span className="chat-meta-fmt">TXT</span><span className="chat-meta-word">{t("Plain text")}</span></CopyButton>
      {time !== null && <time dateTime={turn.ts ?? undefined}>{time}</time>}
    </div>}
    {copyError}
  </article>;
});

const NO_PARTS: ConversationPart[] = [];
/**
 * What the transcript held when each message on its way appeared (lib/outbox.ts sentBaseline), by
 * the message's id. Kept beside the outbox, not in a chat: a chat left and shown again while a
 * message is still on its way (the terminal lens and back) must not count the transcript anew,
 * with the message's own turn already in it.
 */
const sentBaselines = new Map<string, SentBaseline>();
/** the text of a user's turn, as the composer sent it */
const userTurnText = (turn: ConversationTurn): string =>
  turn.parts.filter((part): part is Extract<ConversationPart, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n\n");

/**
 * A message on its way (lib/outbox.ts): the bubble the transcript will draw for it, and where its
 * time will stand, how far it has got. The transcript's own turn takes its place without a move.
 */
const OutgoingTurn = memo(function OutgoingTurn({ paneId, message }: { paneId: string; message: OutgoingMessage }) {
  const t = useT();
  const sent = message.state === "sent";
  return <article className="chat-turn chat-turn-user chat-outgoing" data-state={message.state}>
    <UserImages paneId={paneId} parts={NO_PARTS} text={message.text} />
    <div className="chat-user-row">
      <div className="chat-bubble"><Markdown>{message.text}</Markdown></div>
      <div className="chat-turn-meta chat-outgoing-status">
        {sent ? <Check aria-hidden="true" /> : <span className="chat-outgoing-dot" aria-hidden="true" />}
        <span>{t(sent ? "Sent" : "Sending…")}</span>
      </div>
    </div>
  </article>;
});

function FallbackTurn({ paneId, message }: { paneId: string; message: TranscriptMessage }) {
  if (message.role === "status") return null;
  const turn: ConversationTurn = { role: message.role === "user" ? "user" : "assistant", ts: null, parts: [{ kind: "text", text: message.text }] };
  return <Turn paneId={paneId} turn={turn} live={false} waiting={false} showThinking={false} entered={false} />;
}

// the app re-renders on every pane-status and poll; an unchanged transcript sits those out
export const ChatView = memo(function ChatView({ paneId, refreshKey, invalidationKey = 0, onConversationWatch, conversationPushes = false, onTerminalOutput, sentKey = 0, connected, ended, agent, agentStatus, onMetadata, onRead, greeted = false, onPrompt, onSuggestion, onRestored, onFast, promptRefreshKey = 0, pendingAnswer = null, onPendingAnswerDone, promptDock = null, onPromptAnswered }: ChatViewProps) {
  const t = useT();
  const { fetchPaneConversation, fetchPanePromptState, fetchPaneTranscript, fetchRunningOutput, peekPaneConversation } = useMachineApi();
  // The conversation as this page last read it (lib/api.ts keeps the answer for its 304s): a chat
  // opened again, from another pane or back from the terminal lens, draws it at once and reads
  // behind it, where it used to stand empty on a loading line until the first answer came.
  const [seed] = useState(() => {
    const known = peekPaneConversation(paneId);
    return known !== null && known.source !== "scrollback" ? known : null;
  });
  const { settings } = useSettings();
  // this pane's messages on their way: drawn under the transcript until it holds them itself
  const chatMachineId = useMachineId();
  const outboxOwner = paneStorageId(chatMachineId, paneId);
  // the answer's image thumbnails read the file as the viewer does, from this pane's PC
  const imageUrl = useCallback((path: string) => fileUrl(path, paneId, chatMachineId), [paneId, chatMachineId]);
  const outgoing = useSyncExternalStore(outbox.subscribe, () => outbox.read(outboxOwner));
  // polls pause while the page is hidden and pick up at once when it is back
  const visible = usePageVisible();
  /** the answer last laid out: an unchanged poll (a 304) hands back this very object */
  const lastAnswer = useRef<unknown>(null);
  const [conversationRefresh] = useState(() => new ConversationRefresh());
  const onMetadataRef = useRef(onMetadata);
  onMetadataRef.current = onMetadata;
  const [seeded] = useState<{ state: ChatState; signature: string } | null>(() => {
    if (seed === null) return null;
    const state: ChatState = { source: "conversation", conversationSource: seed.source, turns: seed.turns, messages: [], truncated: false };
    return { state, signature: JSON.stringify(state) };
  });
  const [state, setState] = useState<ChatState>(seeded?.state ?? EMPTY_STATE);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [newMessages, setNewMessages] = useState(false);
  /** scrolled up from the end: the way back is offered even when nothing new came */
  const [away, setAway] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const outlineId = useId();
  const outlineDock = useRef<HTMLDivElement>(null);
  /** the end of the screen while a call runs: its output is not in the transcript until it ends */
  const [liveScreen, setLiveScreen] = useState("");
  const [screenWanted, setScreenWanted] = useState(false);
  /** an answer for this pane arrived (or failed): until then, and while a replaced history is read again, an empty chat is only loading */
  const [loaded, setLoaded] = useState(seed !== null);
  const [prompt, setPrompt] = useState<InteractivePrompt | null>(null);
  // Each prompt that appears is an occurrence of its own, and gets a card of its own. The prompt's
  // id is a hash of what it says, so the same question asked twice shares it: the read below keeps
  // one object while one prompt stays on screen, and that object is what tells them apart.
  const promptOccurrence = useRef<{ of: InteractivePrompt | null; count: number }>({ of: null, count: 0 });
  if (prompt !== null && promptOccurrence.current.of !== prompt) promptOccurrence.current = { of: prompt, count: promptOccurrence.current.count + 1 };
  // turns the transcript holds on a path /tree walked away from: no page can reach them, so the
  // only way to say they exist is to be told, and to say it where the reader would look for them
  const [abandoned, setAbandoned] = useState<{ count: number; branches: number; summary: string | null } | null>(seed?.abandoned ?? null);
  // the suggestion is handed up from each read, with the pane that read it: never kept here,
  // where a pane switch or a send upstream could leave it stale
  const onSuggestionRef = useRef(onSuggestion);
  onSuggestionRef.current = onSuggestion;
  // restored is handed up the same way, and also kept here: while it holds, the send it names
  // is filtered out of the rendered turns (the terminal shows no sent turn for it either)
  const onRestoredRef = useRef(onRestored);
  onRestoredRef.current = onRestored;
  const onFastRef = useRef(onFast);
  onFastRef.current = onFast;
  const [restored, setRestored] = useState<string | null>(null);
  // a read begun before the latest send answers for the turn before it: its suggestion is dropped
  const sentKeyRef = useRef(sentKey);
  sentKeyRef.current = sentKey;
  const [promptPollKey, setPromptPollKey] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const signature = useRef(seeded?.signature ?? "");
  // Older pages sit above the newest one. Once any shows, the newest page is
  // polled from its start at that moment, so the two always meet.
  const [older, setOlder] = useState<ConversationTurn[]>([]);
  /** the page before everything shown; null at the conversation's beginning, undefined when unknown */
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(seed?.cursor);
  const [olderState, setOlderState] = useState<"idle" | "loading" | "failed">("idle");
  const heldFrom = useRef<string | null>(null);
  const loadingOlder = useRef(false);
  /** bumped whenever the older pages are dropped: a load still in flight for them is ignored */
  const olderGeneration = useRef(0);
  const history = useRef<string | undefined>(seed?.history_id);
  const [historyId, setHistoryId] = useState<string | undefined>(seed?.history_id);
  const openedWith = useRef<{ scope: string; keys: Set<string> } | null>(null);
  const shownPane = useRef(paneId);
  const prepended = useRef<{ top: number; height: number } | null>(null);
  const [pollKey, setPollKey] = useState(0);
  /**
   * The assistant turn that was last when a message went out, with the turns it was read from.
   * It holds only while those turns are unchanged: once the transcript moves at all, the status
   * applies again (a slash command Claude logs as no user turn continues the very same turn).
   */
  const [sentOver, setSentOver] = useState<{ turn: ConversationTurn; page: ConversationTurn[] } | null>(null);
  /** the newest page as rendered: an earlier page loaded above it does not move the transcript */
  const heldPage = useRef<ConversationTurn[]>([]);
  const seenSent = useRef(sentKey);
  const seenStatus = useRef<{ pane: string; status: AgentStatus | undefined }>({ pane: paneId, status: agentStatus });
  const seenConnected = useRef(connected);
  const seenInvalidation = useRef({ pane: paneId, key: invalidationKey });

  const dropOlder = (): void => {
    olderGeneration.current += 1; loadingOlder.current = false;
    heldFrom.current = null; prepended.current = null; setOlder([]); setOlderCursor(undefined); setOlderState("idle");
  };

  // the composer's model line comes with the seeded conversation, not one read later
  useEffect(() => {
    if (seed !== null) onMetadataRef.current?.(paneId, seed.metadata ?? null);
  }, []);

  const mountedPane = useRef(paneId);
  useEffect(() => {
    // the pane this chat was mounted for starts as seeded above; only another pane starts over
    if (mountedPane.current === paneId) return;
    mountedPane.current = "";
    shownPane.current = paneId;
    history.current = undefined; setHistoryId(undefined);
    stickToBottom.current = true; signature.current = ""; setState(EMPTY_STATE); setNewMessages(false); setAway(false); setLoaded(false); setError(null); setErrorStatus(null); setPrompt(null); setAbandoned(null); setRestored(null);
    dropOlder();
    lastAnswer.current = null;
    setSentOver(null);
  }, [paneId]);

  useEffect(() => {
    if (seenSent.current === sentKey) return;
    seenSent.current = sentKey;
    // sent into a run (a queued message sent now): that turn is the one running, not one to finish
    const page = heldPage.current;
    const last = page[page.length - 1];
    setSentOver(last?.role === "assistant" && agentStatus !== "working" && agentStatus !== "blocked" ? { turn: last, page } : null);
  }, [sentKey, agentStatus]);

  // Status edges still read immediately, including on a bridge without conversation pushes.
  // They share the same serialized reader as pushes, sends and the periodic backstop.
  useEffect(() => {
    const seen = seenStatus.current;
    seenStatus.current = { pane: paneId, status: agentStatus };
    if (seen.pane === paneId && statusEdgeRead(seen.status, agentStatus)) setPollKey((key) => key + 1);
  }, [paneId, agentStatus]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const terminalState = async (): Promise<ChatState> => {
      const result = await fetchPaneTranscript(paneId, TRANSCRIPT_LINES);
      return { source: "scrollback", turns: [], messages: toTranscriptMessages(result.text).filter((message) => message.role !== "status"), terminalText: result.text, truncated: result.truncated === true };
    };
    /** The turns between the held start and where the newest page now starts, a page at a time; null when they cannot be joined. */
    const turnsBetween = async (held: string, start: string): Promise<ConversationTurn[] | null> => {
      const pages: ConversationTurn[][] = [];
      let before = start;
      try {
        for (let step = 0; step < 32 && before !== held; step++) {
          if (cancelled) return null;
          const page = await fetchPaneConversation(paneId, { before, since: held });
          if (typeof page.cursor !== "string") return null;
          pages.unshift(page.turns);
          before = page.cursor;
        }
      } catch {
        return null;
      }
      return before === held ? pages.flat() : null;
    };
    const read = async (): Promise<void> => {
      let generation = olderGeneration.current;
      let terminalAttempted = false;
      try {
        let conversation;
        try {
          conversation = await fetchPaneConversation(paneId, heldFrom.current === null ? undefined : { from: heldFrom.current });
        } catch (cause) {
          // a new session or a Codex backtrack replaced the transcript the older pages came from
          if (heldFrom.current === null || !(cause instanceof ApiError) || cause.status !== 409) throw cause;
          if (cancelled || generation !== olderGeneration.current) return;
          dropOlder(); setState(EMPTY_STATE); setLoaded(false); signature.current = ""; lastAnswer.current = null;
          generation = olderGeneration.current;
          conversation = await fetchPaneConversation(paneId);
        }
        if (cancelled || generation !== olderGeneration.current) return;
        if (history.current !== conversation.history_id) {
          dropOlder(); generation = olderGeneration.current;
          history.current = conversation.history_id; setHistoryId(conversation.history_id);
          stickToBottom.current = true; setNewMessages(false); setAway(false);
        }
        // A 304 hands back the native conversation already shown. A cached fallback only
        // says where to read: its terminal screen can change independently of this answer.
        if (conversation.source !== "scrollback" && conversation === lastAnswer.current) { setError(null); setErrorStatus(null); return; }
        // The newest page moved past the held start: the turns in between join the older
        // pages and the newest page is held from its new start, so no poll reads more than a page.
        const held = heldFrom.current;
        let moved: ConversationTurn[] = [];
        if (held !== null && conversation.source !== "scrollback" && typeof conversation.cursor === "string" && conversation.cursor !== held) {
          const between = await turnsBetween(held, conversation.cursor);
          if (cancelled || generation !== olderGeneration.current) return;
          if (between === null) {
            dropOlder(); setState(EMPTY_STATE); setLoaded(false); signature.current = ""; lastAnswer.current = null;
            setPollKey((key) => key + 1); return;
          }
          else { moved = between; heldFrom.current = conversation.cursor; }
        }
        if (moved.length > 0) setOlder((turns) => [...turns, ...moved]);
        if (heldFrom.current === null) setOlderCursor(conversation.source === "scrollback" ? undefined : conversation.cursor);
        onMetadataRef.current?.(paneId, conversation.source === "scrollback" ? null : conversation.metadata ?? null);
        setAbandoned(conversation.abandoned ?? null);
        let next: ChatState;
        if (conversation.source !== "scrollback") next = { source: "conversation", conversationSource: conversation.source, turns: conversation.turns, messages: [], truncated: false };
        else {
          terminalAttempted = true;
          next = await terminalState();
          if (cancelled || generation !== olderGeneration.current) return;
        }
        const nextSignature = JSON.stringify(next);
        if (nextSignature !== signature.current) {
          if (signature.current !== "" && !stickToBottom.current) setNewMessages(true);
          signature.current = nextSignature;
          setState(next);
        }
        setError(null); setErrorStatus(null); setLoaded(true);
        // only an answer laid out in full is skipped when it comes back unchanged: a read
        // cancelled mid-way (a pane switch, the page hidden during a gap fill) is redone
        lastAnswer.current = conversation;
      } catch (cause) {
        if (cancelled || generation !== olderGeneration.current) return;
        // Keep known native turns on a transient failure. With nothing to show yet,
        // the pane's independently readable terminal is useful while the same coordinator
        // retries history. Auth failures and gone panes must keep their refusal instead.
        if (!terminalAttempted && (!(cause instanceof ApiError) || cause.status >= 500) && heldPage.current.length === 0 && heldFrom.current === null) {
          try {
            const next = await terminalState();
            if (cancelled || generation !== olderGeneration.current) return;
            const nextSignature = JSON.stringify(next);
            if (nextSignature !== signature.current) { signature.current = nextSignature; setState(next); }
            lastAnswer.current = null;
            onMetadataRef.current?.(paneId, null);
          } catch (terminalError) {
            cause = terminalError;
          }
        }
        if (cancelled || generation !== olderGeneration.current) return;
        setLoaded(true);
        setError(cause instanceof Error ? cause.message : String(cause));
        setErrorStatus(cause instanceof ApiError ? cause.status : null);
      }
    };
    conversationRefresh.setRead(read);
    onConversationWatch?.(paneId, true);
    return () => {
      cancelled = true;
      // Older pages queued behind this reader must not start for a hidden/replaced screen.
      olderGeneration.current += 1;
      loadingOlder.current = false; setOlderState("idle");
      onConversationWatch?.(paneId, false);
      conversationRefresh.stop();
    };
  }, [paneId, fetchPaneConversation, fetchPaneTranscript, conversationRefresh, visible, onConversationWatch]);

  // Sends, status/history repairs and visibility return read immediately without cancelling
  // the answer in flight. The reader is installed before this effect requests its first read.
  useEffect(() => {
    if (visible) conversationRefresh.refresh();
  }, [paneId, refreshKey, pollKey, visible, fetchPaneConversation, fetchPaneTranscript, conversationRefresh, onConversationWatch]);

  // Mount/visibility return already read immediately; only a changed push key invalidates.
  useEffect(() => {
    const seen = seenInvalidation.current;
    seenInvalidation.current = { pane: paneId, key: invalidationKey };
    if (seen.pane === paneId && seen.key !== invalidationKey && visible) conversationRefresh.invalidate();
  }, [paneId, invalidationKey, visible, conversationRefresh]);

  useEffect(() => { conversationRefresh.setPushes(conversationPushes); }, [conversationPushes, conversationRefresh]);

  // A scrollback stand-in has no native file for the server to watch. Its source is the
  // pane's own screen, so terminal output is the invalidation, under the same 2s bound.
  useEffect(() => {
    if (state.source !== "scrollback" || !visible || onTerminalOutput === undefined) return;
    onTerminalOutput(() => conversationRefresh.invalidate());
    return () => onTerminalOutput(null);
  }, [state.source, visible, onTerminalOutput, conversationRefresh]);

  // Catch writes made offline as soon as the existing socket is connected again.
  useEffect(() => {
    const before = seenConnected.current;
    seenConnected.current = connected;
    if (connected && !before && visible) conversationRefresh.refresh();
  }, [connected, visible, conversationRefresh]);

  const loadOlder = useCallback(async (): Promise<void> => {
    const node = scroller.current;
    if (node === null || loadingOlder.current || typeof olderCursor !== "string") return;
    const before = olderCursor;
    const generation = olderGeneration.current;
    loadingOlder.current = true;
    setOlderState("loading");
    await conversationRefresh.page(async () => {
      try {
        if (shownPane.current !== paneId || olderGeneration.current !== generation) return;
        const page = await fetchPaneConversation(paneId, { before });
        if (shownPane.current !== paneId || olderGeneration.current !== generation) return;
        if (page.history_id !== history.current) {
          dropOlder(); setState(EMPTY_STATE); setLoaded(false); signature.current = ""; lastAnswer.current = null;
          setPollKey((key) => key + 1); return;
        }
        // a bridge without pages answers with its newest turns: nothing older to add
        if (page.source === "scrollback" || page.cursor === undefined) { setOlderCursor(undefined); setOlderState("idle"); return; }
        const first = heldFrom.current === null;
        heldFrom.current ??= before;
        prepended.current = { top: node.scrollTop, height: node.scrollHeight };
        setOlder((turns) => [...page.turns, ...turns]);
        setOlderCursor(page.cursor);
        setOlderState("idle");
        // the newest page may have slid since it was read: poll it from the held start now
        if (first) setPollKey((key) => key + 1);
      } catch (cause) {
        if (shownPane.current !== paneId || olderGeneration.current !== generation) return;
        if (cause instanceof ApiError && cause.status === 409) {
          dropOlder(); setState(EMPTY_STATE); setLoaded(false); signature.current = ""; lastAnswer.current = null;
          setPollKey((key) => key + 1);
        }
        else setOlderState("failed");
      } finally {
        if (olderGeneration.current === generation) loadingOlder.current = false;
      }
    });
  }, [fetchPaneConversation, olderCursor, paneId, conversationRefresh]);

  // Older turns went in above the reader: keep the same turns under their eyes.
  useLayoutEffect(() => {
    const node = scroller.current;
    const anchor = prepended.current;
    if (node === null || anchor === null) return;
    prepended.current = null;
    node.scrollTop = anchor.top + (node.scrollHeight - anchor.height);
  }, [older]);

  // Prompts belong to the visible screen, not the native transcript: a Codex directory-trust
  // menu can appear while idle without any file mutation. Keep their independent 2s poll.
  const pollPrompt = connected && !ended && agent !== null;
  useEffect(() => {
    if (!pollPrompt) { setPrompt(null); setRestored(null); onSuggestionRef.current?.(paneId, null); onRestoredRef.current?.(paneId, null); return; }
    if (!visible) return;
    let cancelled = false;
    let timer = 0;
    const readPrompt = async (): Promise<void> => {
      // the same prompt keeps its object: the composer and the card only change with it
      const sent = sentKeyRef.current;
      try {
        const next = await fetchPanePromptState(paneId);
        if (!cancelled) {
          setPrompt((current) => current?.id === next.prompt?.id ? current : next.prompt);
          onFastRef.current?.(paneId, next.fast);
          if (sentKeyRef.current === sent) {
            onSuggestionRef.current?.(paneId, next.suggestion);
            setRestored(next.restored);
            onRestoredRef.current?.(paneId, next.restored);
          }
        }
      }
      catch { if (!cancelled) { setPrompt(null); setRestored(null); onSuggestionRef.current?.(paneId, null); onRestoredRef.current?.(paneId, null); } }
      finally { if (!cancelled) timer = window.setTimeout(() => void readPrompt(), PROMPT_POLL_MS); }
    };
    void readPrompt();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [pollPrompt, paneId, promptPollKey, promptRefreshKey, fetchPanePromptState, visible]);

  useEffect(() => {
    onPrompt?.(paneId, prompt);
    return () => onPrompt?.(paneId, null);
  }, [onPrompt, paneId, prompt]);

  // a pane left behind keeps no suggestion and no restored send
  useEffect(() => () => { onSuggestionRef.current?.(paneId, null); onRestoredRef.current?.(paneId, null); }, [paneId]);

  // away from the page, the prompt is not read: it can be answered in the terminal and asked
  // again unseen, so a typed pick waiting for Confirm does not outlive the page being hidden
  useEffect(() => {
    if (!visible) onPendingAnswerDone?.(paneId);
  }, [visible, onPendingAnswerDone, paneId]);

  // Before paint and without animation: an opened conversation starts at its end
  // instead of scrolling there from the top.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node !== null && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [state, prompt]);

  // A resized composer, a raised keyboard or a narrower window shrinks the view
  // without a scroll event; a reader at the end stays at the end, at once. So does a
  // conversation that rewraps inside an unchanged view: its width or its type changed
  // (Settings → Chat width, Chat font size, Chat font). One that only grew taller did so under
  // the reader's hand (a folded block opened, a whole output asked for): following the end there
  // would jump past what was just opened. New messages follow in the layout effect above.
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    let lane = "";
    const observer = new ResizeObserver((entries) => {
      let follow = false;
      for (const entry of entries) {
        if (entry.target === node) { follow = true; continue; }
        const style = getComputedStyle(entry.target);
        const next = `${entry.contentRect.width}|${style.fontSize}|${style.fontFamily}`;
        if (next !== lane) { lane = next; follow = true; }
      }
      if (follow && stickToBottom.current) node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
    });
    observer.observe(node);
    if (node.firstElementChild !== null) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, []);
  // One of the app's faces arrived (font-display: swap; a unicode-range chunk on the first Korean
  // answer): the conversation rewraps with no width, size or family string changed, so the
  // observer above takes it for one that only grew taller. A reader at the end stays at the end.
  const faces = useFacesArrived();
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node !== null && stickToBottom.current) node.scrollTo({ top: node.scrollHeight, behavior: "instant" });
  }, [faces]);
  // a tap or a drag down the transcript puts a phone's keyboard away to read (lib/keyboard.ts)
  useEffect(() => {
    const node = scroller.current;
    return node === null ? undefined : dismissKeyboardOn(node);
  }, []);

  useEffect(() => {
    if (!outlineOpen) return;
    const outside = (event: PointerEvent): void => { if (!outlineDock.current?.contains(event.target as Node)) setOutlineOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") setOutlineOpen(false); };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [outlineOpen]);
  useEffect(() => {
    if (!screenWanted || !visible) { setLiveScreen(""); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        // Claude Code writes a running command's output to a file of its own (server
        // runningOutputFile); its screen shows only a line count. Others: the end of the screen
        let shown: string | null = null;
        if (agent === "claude") shown = await fetchRunningOutput(paneId).then((output) => outputTail(output.text), () => null);
        if (shown === null) shown = screenTail((await fetchPaneTranscript(paneId, 80)).text);
        if (alive) setLiveScreen(shown);
      } catch {
        // the next read tries again; what was shown stays until the call ends
      }
      if (alive) timer = setTimeout(() => void read(), LIVE_SCREEN_MS);
    };
    void read();
    return () => { alive = false; clearTimeout(timer); };
  }, [screenWanted, visible, paneId, agent, fetchPaneTranscript, fetchRunningOutput]);

  const onScroll = (): void => {
    const node = scroller.current;
    if (node === null) return;
    stickToBottom.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 48;
    setAway(!stickToBottom.current);
    if (stickToBottom.current) setNewMessages(false);
    if (node.scrollTop < LOAD_OLDER_PX && olderState === "idle") void loadOlder();
  };
  const scrollToBottom = (): void => {
    const node = scroller.current;
    if (node === null) return;
    node.scrollTo({ top: node.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    stickToBottom.current = true; setNewMessages(false); setAway(false);
  };
  const turns = useMemo(() => older.length > 0 ? [...older, ...state.turns] : state.turns, [older, state.turns]);
  // A cancelled send back in the agent's input box is no sent turn: the transcript still holds it
  // (empty, blank, held and onRead keep the turns as read), but the rendered list drops it while
  // the last turn is that very send — matching the terminal, which shows it only as typed text.
  const shownTurns = useMemo(() => {
    const last = turns[turns.length - 1];
    if (restored === null || last?.role !== "user") return turns;
    const sent = last.parts.filter((part): part is Extract<ConversationPart, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("\n");
    return sameMessage(sent, restored) ? turns.slice(0, -1) : turns;
  }, [turns, restored]);
  // A message on its way is drawn until the transcript holds it (lib/outbox.ts transcriptHolds):
  // then the transcript's own turn is the message. Only what the user wrote counts: a runtime's
  // notice or a compaction is a user turn with no text of theirs.
  const userTexts = useMemo(() => (state.source === "conversation"
    ? turns.filter((turn) => turn.role === "user").map(userTurnText)
    : state.messages.filter((message) => message.role === "user").map((message) => message.text)).filter((text) => text.trim() !== ""), [state.source, state.messages, turns]);
  const inTranscript = (message: OutgoingMessage): boolean => {
    const baseline = sentBaselines.get(message.id);
    return baseline !== undefined && transcriptHolds(message, baseline, userTexts);
  };
  const outgoingShown = outgoing.filter((message) => !message.seen && !inTranscript(message));
  // counted once, with the transcript as it stood when the message appeared; never while it is unread
  useLayoutEffect(() => {
    const known = sentBaselines;
    // other panes' messages are in here too: only a long list is cut, to those still on their way here
    if (known.size > 64) for (const id of [...known.keys()]) if (!outgoing.some((message) => message.id === id)) known.delete(id);
    outgoing.forEach((message, index) => {
      if (message.seen) return;
      if (!known.has(message.id)) { if (loaded && error === null) known.set(message.id, sentBaseline(outgoing, index, userTexts)); }
      else if (inTranscript(message)) outbox.markSeen(outboxOwner, message.id);
    });
  });
  // the reader's own message is always brought into view, wherever they had scrolled to
  const newestOutgoing = useRef<string | null>(null);
  useLayoutEffect(() => {
    const newest = outgoing[outgoing.length - 1]?.id ?? null;
    const arrived = newest !== null && newest !== newestOutgoing.current;
    newestOutgoing.current = newest;
    if (arrived) { stickToBottom.current = true; setNewMessages(false); setAway(false); }
    const node = scroller.current;
    if (node !== null && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [outgoing]);
  heldPage.current = state.turns;
  const finishedBeforeSend = sentOver !== null && sentOver.page === state.turns ? sentOver.turn : null;
  const empty = state.source === "conversation" ? turns.length === 0
    : agent !== null ? !state.terminalText?.trim() : state.messages.length === 0;
  const blank = !ended && chatIsBlank({ loaded, failed: error !== null, transcript: state.source === "conversation", turns: turns.length, older: typeof olderCursor === "string", abandoned: abandoned?.count ?? 0, prompt: prompt !== null, agent });
  // the scrollback standing in says nothing of the conversation: it has no history to compare
  const known = loaded && error === null && !ended && state.source === "conversation";
  const held = turns.length + (abandoned?.count ?? 0);
  // before paint: the greeting replaces the line below in the same frame, not one after it
  useLayoutEffect(() => {
    onRead?.(paneId, known ? { blank, turns: held, history: historyId } : null);
  }, [onRead, paneId, known, blank, held, historyId]);
  // the chat left the screen (another lens): nothing is known of it until it is read again
  useLayoutEffect(() => () => onRead?.(paneId, null), [onRead, paneId]);

  // The turns the transcript opened with stand still, however many; an answer that arrives later
  // rises in (Turn `entered`, ChatView.css). What it opened with is taken at the first page drawn
  // of each conversation, so a switch of pane or session draws its page still too.
  const scope = `${paneId}:${historyId ?? ""}`;
  const turnKey = (turn: ConversationTurn, index: number): string => `${scope}:${turn.role}:${turn.ts ?? index}`;
  if (loaded && state.source === "conversation" && openedWith.current?.scope !== scope) openedWith.current = { scope, keys: new Set(shownTurns.map(turnKey)) };
  const entered = (key: string): boolean => openedWith.current?.scope === scope && !openedWith.current.keys.has(key);

  // The answers the agent gave, newest first, at the chat's right: one that scrolled away while
  // subagents kept the transcript busy is a pick away (lib/chatOutline.ts). A pick scrolls to it
  // and marks it a moment; the list closes, as a menu does.
  const outline = useMemo(() => state.source === "conversation" ? chatOutline(shownTurns, (turn, index) => `${scope}:${turn.role}:${turn.ts ?? index}`).reverse() : [], [state.source, shownTurns, scope]);
  const jumpTo = (key: string): void => {
    setOutlineOpen(false);
    const node = scroller.current?.querySelector<HTMLElement>(`[data-turn-key="${CSS.escape(key)}"]`);
    if (!node) return;
    stickToBottom.current = false;
    setAway(true);
    node.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    // not React's: the turn is memoized and its className is the turn's own
    delete node.dataset["picked"];
    void node.offsetWidth;
    node.dataset["picked"] = "";
    window.setTimeout(() => { delete node.dataset["picked"]; }, PICKED_MS);
  };
  const runningCall = state.source === "conversation" && agentStatus === "working" && !ended ? runningTool(shownTurns) : null;
  useEffect(() => setScreenWanted(runningCall !== null), [runningCall]);
  return <ChatPaneContext.Provider value={paneId}><ChatHistoryContext.Provider value={historyId ?? ""}><FileUrlContext.Provider value={imageUrl}><div className="chat-view" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-label={t("conversation of {pane}", { pane: paneId })}>
    <div className="chat-transcript" data-conversation-source={state.conversationSource}>
      {/* the conversation below is not all the file holds: a /tree left these behind, and pi moved
          its leaf without writing anything, so nothing here could say they were ever there. First
          in the transcript, because paging back would otherwise drop them under their own heading */}
      {state.source === "conversation" && abandoned !== null && abandoned.count > 0 && (
        <details className="chat-compact chat-abandoned">
          <summary>{t(abandoned.branches > 1
            ? abandoned.count === 1 ? "{n} earlier turn on {b} branches you navigated away from" : "{n} earlier turns on {b} branches you navigated away from"
            : abandoned.count === 1 ? "{n} earlier turn on a branch you navigated away from" : "{n} earlier turns on a branch you navigated away from",
            { n: abandoned.count, b: abandoned.branches })}</summary>
          {abandoned.summary !== null
            ? <div className="chat-compact-text"><Markdown>{abandoned.summary}</Markdown></div>
            : <p className="chat-abandoned-note">{t("pi kept them in the session file but answers from the branch you chose. Use /tree in the terminal to go back.")}</p>}
        </details>
      )}
      {/* one button in every state: swapping it for a status line of another height would shift the reader */}
      {state.source === "conversation" && typeof olderCursor === "string" && (
        <button type="button" className="btn btn-ghost chat-older" disabled={olderState === "loading"} onClick={() => void loadOlder()}>
          {t(olderState === "loading" ? "Loading earlier messages…" : olderState === "failed" ? "Couldn't load earlier messages — retry" : "Earlier messages")}
        </button>
      )}
      {state.source === "conversation" && olderCursor === null && older.length > 0 && <p className="chat-endcap">{t("beginning of conversation")}</p>}
      {state.source === "conversation"
        ? shownTurns.map((turn, index) => {
            const last = index === shownTurns.length - 1;
            const live = isLiveWorkTurn(turn, last, agentStatus, finishedBeforeSend);
            const key = turnKey(turn, index);
            return <RenderBoundary key={key} resetKey={turnRevision(turn)} fallback={() => <p className="chat-inline-state chat-inline-error">{t("This message can't be shown here. The terminal has it.")}</p>}>
              <Turn paneId={paneId} turn={turn} live={live} waiting={isWaitingWorkTurn(live, agentStatus)} showThinking={settings.showThinking} entered={entered(key)} anchor={key} />
            </RenderBoundary>;
          })
        : agent !== null
          ? <section className="chat-terminal-fallback" aria-label={t("Terminal output")}>
              <p className="chat-terminal-label">{t("Terminal output")}</p>
              {!empty && <pre>{state.terminalText}</pre>}
            </section>
          : state.messages.map((message, index) => <FallbackTurn key={index} paneId={paneId} message={message} />)}
      {runningCall !== null && liveScreen !== "" && <section className="chat-live-terminal" aria-label={t("Running now")}>
        <p className="chat-live-terminal-label"><SquareTerminal aria-hidden="true" /><span>{t("Running now")}</span><span className="chat-live-terminal-call">{runningCall}</span></p>
        <pre>{liveScreen}</pre>
      </section>}
      {outgoingShown.map((message) => <OutgoingTurn key={message.id} paneId={paneId} message={message} />)}
      {!ended && !connected && <p className="chat-inline-state" role="status">{t("Reconnecting…")}</p>}
      {error !== null && <p className="chat-inline-state chat-inline-error" role="alert">{errorStatus === 401 ? t("locked — the token gate is asking again") : error}</p>}
      {!loaded && error === null && <p className="chat-inline-state" role="status">{t("Loading conversation…")}</p>}
      {loaded && empty && outgoingShown.length === 0 && error === null && prompt === null && !(greeted && blank) && <div className="chat-empty"><AgentMark agent={agent ?? "agent"} size={32} /><p>{t(state.source === "scrollback" ? "No terminal output yet" : "No conversation yet — say something below")}</p></div>}
      {ended && <p className="chat-endcap">{t("terminal ended")}</p>}
    </div>
    {newMessages ? <button type="button" className="btn chat-new-messages" onClick={scrollToBottom}>{t("New messages")} <ArrowDown aria-hidden="true" /></button>
      : away && <button type="button" className="btn chat-new-messages is-icon" aria-label={t("Jump to latest")} title={t("Jump to latest")} onClick={scrollToBottom}><ArrowDown aria-hidden="true" /></button>}
  </div>
  {outline.length > 0 && <div className="chat-outline-dock" ref={outlineDock}>
    <button type="button" className="icon-button chat-outline-toggle" aria-expanded={outlineOpen} aria-controls={outlineOpen ? outlineId : undefined} aria-label={t("Answers")} title={t("Answers")} onClick={() => setOutlineOpen((open) => !open)}>
      <TableOfContents aria-hidden="true" /><span className="chat-outline-count" aria-hidden="true">{outline.length}</span>
    </button>
    {outlineOpen && <nav id={outlineId} className="chat-outline" aria-label={t("Answers")}>
      <p className="chat-outline-head"><span>{t("Answers")}</span><button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={() => setOutlineOpen(false)}><X aria-hidden="true" /></button></p>
      <ol className="chat-outline-list">
        {outline.map((entry) => {
          const Icon = OUTLINE_ICONS[entry.kind];
          const time = formatTime(entry.ts);
          return <li key={entry.key}><button type="button" className={`chat-outline-item is-${entry.kind}`} onClick={() => jumpTo(entry.key)}>
            <Icon className="chat-outline-icon" aria-hidden="true" />
            <span className="chat-outline-title">{entry.title}</span>
            {time !== null && <time className="chat-outline-time" dateTime={entry.ts ?? undefined}>{time}</time>}
          </button></li>;
        })}
      </ol>
      {typeof olderCursor === "string" && <button type="button" className="btn btn-ghost chat-outline-older" disabled={olderState === "loading"} onClick={() => void loadOlder()}>
        {t(olderState === "loading" ? "Loading earlier messages…" : olderState === "failed" ? "Couldn't load earlier messages — retry" : "Earlier messages")}
      </button>}
    </nav>}
  </div>}
  {/* The prompt card is not part of the transcript: it is drawn on the composer's column, over the
      input card, where PaneTerminal keeps its place. The prompt itself (its poll, the answer, the
      re-read) stays here. */}
  {prompt !== null && promptDock !== null && createPortal(
    <PromptCard key={promptOccurrence.current.count} paneId={paneId} prompt={prompt} typedAnswer={pendingAnswer?.promptId === prompt.id ? pendingAnswer.answer : null} onTypedAnswerDone={() => onPendingAnswerDone?.(paneId, prompt.id)} onPromptChanged={() => setPromptPollKey((key) => key + 1)} onAnswered={(toMessageBox) => {
      // the card reports only while it is the one shown; still, only its own prompt is cleared
      onPromptAnswered?.(toMessageBox);
      setPrompt((current) => current === prompt ? null : current);
      // a form of several questions goes on to its next one: read it now, not at the next poll
      if (prompt.steps) setPromptPollKey((key) => key + 1);
      onPendingAnswerDone?.(paneId, prompt.id);
    }} />, promptDock)}
  </FileUrlContext.Provider></ChatHistoryContext.Provider></ChatPaneContext.Provider>;
});
