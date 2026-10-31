import { expect, test } from "bun:test";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { runningTool, screenTail } from "./liveTerminal.ts";

const tool = (output: string, error?: boolean): ConversationTurn => ({ role: "assistant", ts: null, parts: [{ kind: "text", text: "On it." }, { kind: "tool", name: "Bash", summary: "bun test", input: "bun test", output, ...(error ? { error } : {}) }] });

test("a call is running while it has no output yet and ends the newest agent turn", () => {
  expect(runningTool([tool("")])).toBe("bun test");
  expect(runningTool([tool("ok")])).toBeNull();
  expect(runningTool([tool("", true)])).toBeNull();
  expect(runningTool([tool(""), { role: "user", ts: null, parts: [{ kind: "text", text: "hi" }] }])).toBeNull();
  expect(runningTool([])).toBeNull();
});

test("the screen's end is what is above Claude Code's input box", () => {
  const screen = ["⏺ Bash(bun test)", "  ⎿  12 pass", "     3 running…", "", "✻ Working… (12s)", "", "─".repeat(40), "> ", "─".repeat(40), "  ⏵⏵ auto mode on", ""].join("\n");
  expect(screenTail(screen)).toBe(["⏺ Bash(bun test)", "  ⎿  12 pass", "     3 running…", "", "✻ Working… (12s)"].join("\n"));
  expect(screenTail(screen, 2)).toBe("✻ Working… (12s)");
});

test("an older boxed input and a screen with no box", () => {
  expect(screenTail(["out 1", "out 2", "╭──────────╮", "│ >        │", "╰──────────╯"].join("\n"))).toBe("out 1\nout 2");
  expect(screenTail("\n\na\nb\n\n")).toBe("a\nb");
});
