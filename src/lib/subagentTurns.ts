import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";

/**
 * A subagent's report as its answer. Claude Code 2.1.31x has a subagent deliver its final report
 * through a `SubagentHandback` call (`{"message": "…"}`) instead of a reply, so its transcript
 * ends in a tool row ("1 other tool") and the report sat folded inside the work block. In a look
 * inside a subagent (TaskView) that call reads as the answer it is. Other calls are left as they are.
 */
export function handbackAsAnswer(turns: readonly ConversationTurn[]): ConversationTurn[] {
  return turns.map((turn) => {
    if (turn.role !== "assistant" || !turn.parts.some(isHandback)) return turn;
    const parts = turn.parts.map((part): ConversationPart => {
      if (!isHandback(part)) return part;
      const message = reportOf(part.input);
      return message === null ? part : { kind: "text", text: message };
    });
    return { ...turn, parts };
  });
}

function isHandback(part: ConversationPart): part is Extract<ConversationPart, { kind: "tool" }> {
  return part.kind === "tool" && part.name === "SubagentHandback";
}

function reportOf(input: string): string | null {
  try {
    const value: unknown = JSON.parse(input);
    const message = typeof value === "object" && value !== null ? (value as Record<string, unknown>)["message"] : undefined;
    return typeof message === "string" && message.trim() !== "" ? message : null;
  } catch { return null; }
}
