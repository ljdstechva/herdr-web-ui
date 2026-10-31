import type { ConversationTurn } from "../../shared/protocol.ts";
import { splitTurn } from "./workBlocks.ts";

/**
 * The chat's list of what the agent told the reader, for jumping back to an answer that scrolled
 * away while subagents kept the transcript busy: one entry per agent turn with an answer, and per
 * card of background tasks that ended. Its title is a very short summary of the answer: its first
 * heading, else its first sentence, without the markdown, cut at a word.
 */
export interface OutlineEntry {
  key: string;
  title: string;
  ts: string | null;
  /** `question`: the answer ends by asking the reader something; `result`: background tasks reported back */
  kind: "answer" | "question" | "result";
}

const TITLE_MAX = 56;

/** A line of markdown as plain words: no heading marks, emphasis, code ticks, link targets, list or quote marks. */
function plainLine(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The very short summary of an answer: its first heading, else its first sentence, cut at a word to `max` characters. */
export function outlineTitle(markdown: string, max = TITLE_MAX): string {
  const lines = markdown.split("\n").filter((line) => line.trim() !== "" && !/^\s*(```|~~~|\|?\s*:?-{3,}|---+\s*$)/.test(line));
  const heading = lines.find((line) => /^\s{0,3}#{1,6}\s/.test(line));
  const first = plainLine(heading ?? lines[0] ?? "");
  // a sentence ends at its stop followed by a space; "e.g." and a path's dot are no end
  const sentence = /^(.{12,}?[.!?:])\s/.exec(`${first} `)?.[1] ?? first;
  const cut = (heading === undefined ? sentence : first).replace(/:$/, "");
  if (cut.length <= max) return cut;
  // one more than fits: a space there means the word before it ends inside the room
  const room = cut.slice(0, max);
  const word = room.lastIndexOf(" ");
  return `${(word > max / 2 ? room.slice(0, word) : room.slice(0, max - 1)).replace(/[\s,;:.-]+$/, "")}…`;
}

/** The entries of `turns`, oldest first; `keyOf` names each turn as the chat draws it. */
export function chatOutline(turns: readonly ConversationTurn[], keyOf: (turn: ConversationTurn, index: number) => string): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  turns.forEach((turn, index) => {
    const ended = turn.parts.find((part) => part.kind === "task_result");
    if (ended?.kind === "task_result" && ended.tasks.length > 0) {
      const first = ended.tasks[0]!.title;
      const title = ended.tasks.length === 1 ? first : `${first} +${ended.tasks.length - 1}`;
      entries.push({ key: keyOf(turn, index), title: outlineTitle(title), ts: turn.ts, kind: "result" });
      return;
    }
    if (turn.role !== "assistant") return;
    const answer = splitTurn(turn.parts).answer.map((part) => part.text).join("\n\n").trim();
    if (answer === "") return;
    const title = outlineTitle(answer);
    if (title === "") return;
    entries.push({ key: keyOf(turn, index), title, ts: turn.ts, kind: /\?\s*$/.test(answer) ? "question" : "answer" });
  });
  return entries;
}
