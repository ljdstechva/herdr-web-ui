import { describe, expect, it } from "bun:test";
import { closeBackslash } from "./index.ts";

describe("closeBackslash", () => {
  it("adds a space after a Claude message's last backslash, so Claude Code's Enter sends it", () => {
    expect(closeBackslash("claude", "see C:\\temp\\")).toBe("see C:\\temp\\ ");
    // a payload in paste markers gets the space inside the closing one
    expect(closeBackslash("claude", "\u001b[200~see C:\\temp\\\u001b[201~")).toBe("\u001b[200~see C:\\temp\\ \u001b[201~");
  });

  it("leaves a backslash before the end, another agent's message and the terminal's line as written", () => {
    expect(closeBackslash("claude", "see C:\\temp\\x")).toBe("see C:\\temp\\x");
    expect(closeBackslash("claude", "first line \\\nsecond line")).toBe("first line \\\nsecond line");
    expect(closeBackslash("codex", "see C:\\temp\\")).toBe("see C:\\temp\\");
    expect(closeBackslash(null, "see C:\\temp\\")).toBe("see C:\\temp\\");
  });
});
