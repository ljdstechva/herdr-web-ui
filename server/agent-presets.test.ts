import { describe, expect, it } from "bun:test";
import { loadAgentPresets, resolvePreset, withPresets } from "./agent-presets.ts";

const file = (value: unknown) => () => JSON.stringify(value);
const gpt = { kind: "claude-gpt", label: "Claude Code (GPT)", agent: "claude", args: ["--settings", "/home/me/ccr/claude-gpt.settings.json"] };

describe("agent presets", () => {
  it("reads valid entries and skips every other one whole", () => {
    const presets = loadAgentPresets("/state", file([
      gpt,
      { ...gpt, kind: "Bad Kind" },
      { ...gpt, kind: "claude" },
      { ...gpt, kind: "no-label", label: " " },
      { ...gpt, kind: "bad-args", args: ["--x", 3] },
      { ...gpt, kind: "nul-arg", args: ["a\0b"] },
      { ...gpt, label: "duplicate kind" },
      null,
    ]));
    expect(presets).toEqual([gpt]);
  });

  it("is empty for an absent, unreadable or wrongly shaped file", () => {
    expect(loadAgentPresets("/state", () => { throw new Error("ENOENT"); })).toEqual([]);
    expect(loadAgentPresets("/state", () => "{not json")).toEqual([]);
    expect(loadAgentPresets("/state", file({ presets: [gpt] }))).toEqual([]);
  });

  it("offers a preset only for an agent the server has, wearing that agent's mark", () => {
    const kinds = [{ kind: "claude", label: "Claude Code" }, { kind: "codex", label: "Codex" }];
    expect(withPresets(kinds, [gpt]).map((kind) => kind.kind)).toEqual(["claude", "claude-gpt", "codex"]);
    expect(withPresets(kinds, [gpt]).find((kind) => kind.kind === "claude-gpt")).toEqual({ kind: "claude-gpt", label: "Claude Code (GPT)", mark: "claude" });
    expect(withPresets([{ kind: "codex", label: "Codex" }], [gpt])).toEqual([{ kind: "codex", label: "Codex" }]);
  });

  it("starts a preset's agent with its arguments first, and any other kind as asked", () => {
    expect(resolvePreset("claude-gpt", ["--resume"], [gpt])).toEqual({ kind: "claude", args: ["--settings", "/home/me/ccr/claude-gpt.settings.json", "--resume"] });
    expect(resolvePreset("claude-gpt", undefined, [gpt])).toEqual({ kind: "claude", args: gpt.args });
    expect(resolvePreset("codex", undefined, [gpt])).toEqual({ kind: "codex", args: undefined });
  });
});
