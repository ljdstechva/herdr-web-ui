import type { ConversationTurn } from "../../shared/protocol.ts";

/**
 * While a tool runs, its output is on the agent's screen but not in its transcript yet (Claude
 * Code and Codex write a call's result when it ends): the chat shows the end of the screen under
 * the running call, so a long command is seen working, as in the terminal.
 */

/** The call still running at the end of the newest agent turn: its summary, else null. */
export function runningTool(turns: readonly ConversationTurn[]): string | null {
  const last = turns[turns.length - 1];
  if (last === undefined || last.role !== "assistant") return null;
  const part = last.parts[last.parts.length - 1];
  if (part?.kind !== "tool" || part.output !== "" || part.error === true) return null;
  return part.summary || part.name;
}

/** A rule line: Claude Code draws its input box between two of them. */
const RULE = /^\s*[─━═]{8,}\s*$/;
/** Older Claude Code boxes its input: the box's top corner. */
const BOX_TOP = /^\s*╭[─━]{4,}/;

/**
 * The end of a screen, above the agent's own input box and footer: at most `lines` lines, with
 * the blank ones at either end left out. A screen with no box is kept to its end.
 */
export function screenTail(screen: string, lines = 14): string {
  let rows = screen.replace(/\r/g, "").split("\n").map((row) => row.trimEnd());
  const rules = rows.flatMap((row, index) => RULE.test(row) ? [index] : []);
  const top = rows.reduce((found, row, index) => BOX_TOP.test(row) ? index : found, -1);
  if (rules.length >= 2) rows = rows.slice(0, rules[rules.length - 2]);
  else if (top !== -1) rows = rows.slice(0, top);
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  rows = rows.slice(-lines);
  while (rows.length > 0 && rows[0] === "") rows.shift();
  return rows.join("\n");
}

/** A terminal's colours and cursor moves: an output file holds what the command printed, as printed. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** The end of a command's output as plain text: at most `lines` lines, a carriage return's overwritten start dropped. */
export function outputTail(output: string, lines = 14): string {
  const rows = output.replace(ANSI, "").split("\n").map((row) => row.slice(row.lastIndexOf("\r") + 1).trimEnd());
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows.slice(-lines).join("\n");
}
