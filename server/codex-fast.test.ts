import { describe, expect, it } from "bun:test";
import { codexFastBinding, codexFastOnScreen, herdrKeyFor, isFastTier } from "./codex-fast.ts";

const screen = (status: string): string => [
  "  /model - choose what model and reasoning effort to use",
  "",
  "› Ask Codex to do anything",
  "",
  status,
  "  ← for agents · ? for shortcuts                              ⚠ 1 warning · f2 to view",
].join("\n");

describe("codexFastOnScreen", () => {
  it("reads Fast mode off the status line under the input box", () => {
    expect(codexFastOnScreen(screen("  GPT-6-Astra max fast · /opt/workstation/07 StoneDepot"))).toBe(true);
    expect(codexFastOnScreen(screen("  GPT-6-Astra max · /opt/workstation/07 StoneDepot"))).toBe(false);
    expect(codexFastOnScreen(screen("  GPT-6.1-Sol xhigh fast · ~/project · main"))).toBe(true);
  });

  it("is not misled by a folder or a branch named fast", () => {
    expect(codexFastOnScreen(screen("  GPT-6-Astra ultra · /srv/fast · fast"))).toBe(false);
  });

  it("reads a line a narrow pane cut short", () => {
    expect(codexFastOnScreen(screen("  GPT-6-Astra max fast"))).toBe(true);
    expect(codexFastOnScreen(screen("  GPT-6-Astra max"))).toBe(false);
  });

  it("says nothing when the status line is not on the screen", () => {
    expect(codexFastOnScreen("  Select Model and Effort\n\n› 1. GPT-6.1-Sol\n  2. GPT-6-Astra (current)\n\n  enter select · esc back")).toBe(null);
    expect(codexFastOnScreen("")).toBe(null);
    // a message being typed that happens to read like one is far above the status line's place
    expect(codexFastOnScreen(["  GPT-6-Astra max fast · /x", ...Array.from({ length: 9 }, (_, row) => `output line ${row}`)].join("\n"))).toBe(null);
  });
});

describe("herdrKeyFor", () => {
  it("names a function key and a modified key as herdr does", () => {
    expect(herdrKeyFor("f9")).toBe("f9");
    expect(herdrKeyFor("F12")).toBe("f12");
    expect(herdrKeyFor("ctrl-t")).toBe("ctrl+t");
    expect(herdrKeyFor("alt-shift-f")).toBe("alt+shift+f");
  });

  it("vouches for nothing else", () => {
    for (const binding of ["", "f13", "ctrl-/", "shift-left", "ctrl-ctrl-a", "super-a", "g g", "enter"]) expect(herdrKeyFor(binding)).toBe(null);
  });
});

describe("codexFastBinding", () => {
  it("reads the key Codex's /keymap wrote", () => {
    expect(codexFastBinding('model = "gpt-6-astra"\n\n[tui.keymap.global]\ntoggle_fast_mode = "f9"\n')).toBe("f9");
    expect(codexFastBinding('[tui]\nkeymap = { global = { toggle_fast_mode = "ctrl-t" } }\n')).toBe("ctrl-t");
  });

  it("takes the first of several keys that can be sent", () => {
    expect(codexFastBinding('[tui.keymap.global]\ntoggle_fast_mode = ["shift-left", "f6"]\n')).toBe("f6");
  });

  it("finds none in a config that binds none, or that cannot be read", () => {
    expect(codexFastBinding('model = "gpt-6-astra"\n[tui.keymap.global]\ntoggle_vim_mode = "f7"\n')).toBe(null);
    expect(codexFastBinding('[tui.keymap.global]\ntoggle_fast_mode = []\n')).toBe(null);
    expect(codexFastBinding("this is = not [toml")).toBe(null);
  });
});

describe("isFastTier", () => {
  it("knows the two names Codex gives Fast mode", () => {
    expect(isFastTier("priority")).toBe(true);
    expect(isFastTier("fast")).toBe(true);
    expect(isFastTier("default")).toBe(false);
    expect(isFastTier(null)).toBe(false);
  });
});
