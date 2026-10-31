import { expect, test } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { splitTurn } from "./workBlocks.ts";
import { handbackAsAnswer } from "./subagentTurns.ts";

const handback = (input: string) => ({ kind: "tool" as const, name: "SubagentHandback", summary: "SubagentHandback", input, output: "{\"success\":true}" });

test("a subagent's handback is its answer", () => {
  const turns: ConversationTurn[] = [
    { role: "user", ts: "1", parts: [{ kind: "text", text: "run it" }] },
    { role: "assistant", ts: "2", parts: [{ kind: "tool", name: "Bash", summary: "ls", input: "{}", output: "a" }, handback("{\n  \"message\": \"DONE\"\n}")] },
  ];
  const shown = handbackAsAnswer(turns);
  expect(shown[0]).toBe(turns[0]!);
  expect(splitTurn(shown[1]!.parts).answer.map((part) => part.text)).toEqual(["DONE"]);
  expect(shown[1]!.parts[0]).toEqual(turns[1]!.parts[0]!);
});

test("a handback with no message, or not JSON, stays a call", () => {
  const turn: ConversationTurn = { role: "assistant", ts: "2", parts: [handback("{}"), handback("not json")] };
  expect(handbackAsAnswer([turn])[0]!.parts.every((part) => part.kind === "tool")).toBe(true);
});
