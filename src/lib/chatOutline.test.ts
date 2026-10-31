import { expect, test } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { chatOutline, outlineTitle } from "./chatOutline.ts";

test("a title is the answer's first heading, else its first sentence, as plain words", () => {
  expect(outlineTitle("## Deploy **done**\n\nAll checks passed.")).toBe("Deploy done");
  expect(outlineTitle("The build is live at `0116b58`. Tests passed.")).toBe("The build is live at 0116b58.");
  expect(outlineTitle("- see [the log](https://x.test/log) for details")).toBe("see the log for details");
  expect(outlineTitle("Here is what I found:\n\n1. one")).toBe("Here is what I found");
});

test("a long title is cut at a word", () => {
  const title = outlineTitle("Both folders are gone from the VPS and the laptop keeps its copies because they were ignored first");
  expect(title.length).toBeLessThanOrEqual(56);
  expect(title.endsWith("…")).toBe(true);
  expect(title).toBe("Both folders are gone from the VPS and the laptop keeps…");
});

test("the outline has agent answers and ended tasks, not prompts or bare work", () => {
  const turns: ConversationTurn[] = [
    { role: "user", ts: "1", parts: [{ kind: "text", text: "deploy it" }] },
    { role: "assistant", ts: "2", parts: [{ kind: "tool", name: "Bash", summary: "ls", input: "ls", output: "a" }] },
    { role: "assistant", ts: "3", parts: [{ kind: "tool", name: "Bash", summary: "ls", input: "ls", output: "a" }, { kind: "text", text: "Deployed. Shall I push it?" }] },
    { role: "user", ts: "4", parts: [{ kind: "task_result", tasks: [{ id: "a", title: "Check links", agent: null, model: null, status: "completed", duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "" }, { id: "b", title: "Fix", agent: null, model: null, status: "completed", duration_ms: null, turns: null, tool_calls: null, tokens: null, result: "" }] }] },
  ];
  expect(chatOutline(turns, (turn) => `k${turn.ts}`)).toEqual([
    { key: "k3", title: "Deployed. Shall I push it?", ts: "3", kind: "question" },
    { key: "k4", title: "Check links +1", ts: "4", kind: "result" },
  ]);
});
