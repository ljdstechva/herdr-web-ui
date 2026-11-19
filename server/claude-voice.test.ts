import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeVoice, claudeBoxWords, claudeVoiceSettings, type ClaudeVoiceDeps } from "./claude-voice.ts";
import type { ClaudeVoiceEvent } from "../shared/claude-voice.ts";

const rule = "─".repeat(60);
/** Claude Code's screen around its message box, as 2.1.328 draws it while it listens */
const screen = (box: string[], top = "                                     ● REC · tap to send") =>
  ["⏺ Done.", "", top, rule, ...box, rule, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");

describe("the words in Claude Code's box", () => {
  test("rows joined, without the prompt mark or the level meter at the caret", () => {
    expect(claudeBoxWords(screen([
      "❯ Well, I don't wish to see it anymore, observed Phoebe, turning away her eyes. It is certainly very like the old",
      "  portrait.▁",
    ]))).toBe("Well, I don't wish to see it anymore, observed Phoebe, turning away her eyes. It is certainly very like the old portrait.");
    expect(claudeBoxWords(screen(["❯ Well, I don't wish to see█"]))).toBe("Well, I don't wish to see");
  });

  test("an empty box is no words, a screen without one is null", () => {
    expect(claudeBoxWords(screen(["❯ █"]))).toBe("");
    expect(claudeBoxWords(screen(["❯"]))).toBe("");
    expect(claudeBoxWords("$ ls\nREADME.md")).toBeNull();
    expect(claudeBoxWords(screen(["! ls"]))).toBeNull();
  });
});

describe("Claude Code's voice settings", () => {
  const homes: string[] = [];
  afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
  const home = (settings: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), "voice-home-"));
    homes.push(dir);
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(settings));
    return dir;
  };

  test("as /voice writes them, and the older key", () => {
    expect(claudeVoiceSettings(home({ voice: { enabled: true, mode: "tap" } }))).toEqual({ enabled: true, mode: "tap" });
    expect(claudeVoiceSettings(home({ voiceEnabled: true }))).toEqual({ enabled: true, mode: "hold" });
    expect(claudeVoiceSettings(home({ voiceEnabled: true, voice: { enabled: false } }))).toEqual({ enabled: false, mode: null });
    expect(claudeVoiceSettings(home({}))).toEqual({ enabled: false, mode: null });
    expect(claudeVoiceSettings(join(tmpdir(), "no-such-home"))).toEqual({ enabled: false, mode: null });
  });
});

describe("a dictation into a Claude pane", () => {
  const dirs: string[] = [];
  const voices: ClaudeVoice[] = [];
  afterEach(() => {
    for (const voice of voices.splice(0)) voice.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** a pane whose box the test writes, and the keys the take sent it */
  function setup(overrides: Partial<ClaudeVoiceDeps> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "cv-"));
    dirs.push(dir);
    const pane = { box: ["❯ "], keys: [] as string[][], top: "                                     ● REC · tap to send" };
    const deps: ClaudeVoiceDeps = {
      dir, name: "t",
      pane: async () => ({ agent: "claude", status: "idle" }),
      boxReads: async () => [screen(pane.box, pane.top), null],
      screen: async () => screen(pane.box, pane.top),
      keys: async (_, keys) => { pane.keys.push(keys); if (keys[0] === "esc") pane.box = ["❯ "]; },
      blocked: () => false,
      settings: () => ({ enabled: true, mode: "tap" }),
      recorderInstalled: () => true,
      timing: { recorderWait: 300, poll: 20, settleSilence: 120, settleStable: 60, settleMax: 1500, clearWait: 300, max: 10_000 },
      ...overrides,
    };
    const voice = new ClaudeVoice(deps);
    voices.push(voice);
    return { dir, pane, voice };
  }

  /** what the arecord stand-in does: say its pane, then read */
  function recorder(dir: string, paneId: string) {
    const socket = connect(join(dir, "t.sock"));
    const state = { answer: null as string | null, audio: [] as number[], closed: false, socket };
    let head = "";
    socket.on("data", (data: Buffer) => {
      if (state.answer === null) {
        head += data.toString("latin1");
        const at = head.indexOf("\n");
        if (at < 0) return;
        state.answer = head.slice(0, at);
        for (const byte of Buffer.from(head.slice(at + 1), "latin1")) state.audio.push(byte);
        return;
      }
      for (const byte of data) state.audio.push(byte);
    });
    socket.on("close", () => { state.closed = true; });
    socket.on("connect", () => socket.write(`${JSON.stringify({ pane: paneId, pid: 1 })}\n`));
    return state;
  }

  async function until(check: () => boolean, ms = 2000): Promise<void> {
    for (const deadline = Date.now() + ms; !check();) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(10);
    }
  }

  test("taps Space, hands the recorder its pane's audio, sends the words, settles them and empties the box with Esc", async () => {
    const { dir, pane, voice } = setup();
    await voice.listen();
    const events: ClaudeVoiceEvent[] = [];
    const take = voice.open("w1:p1", (event) => events.push(event));
    take.audio(new Uint8Array([1, 2, 3, 4]));
    await until(() => pane.keys.length === 1);
    expect(pane.keys[0]).toEqual(["space"]);

    const stranger = recorder(dir, "w9:p9");
    await until(() => stranger.answer !== null);
    expect(stranger.answer).toBe("no");

    const mine = recorder(dir, "w1:p1");
    await until(() => mine.audio.length >= 4);
    expect(mine.answer).toBe("ok");
    expect(mine.audio.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(events[0]).toEqual({ type: "listening" });
    take.audio(new Uint8Array([5, 6]));
    await until(() => mine.audio.length >= 6);

    pane.box = ["❯ hello there▃"];
    await until(() => events.some((event) => event.type === "partial" && event.text === "hello there"));
    take.finish();
    pane.box = ["❯ hello there, friend.▁"];
    await until(() => events.at(-1)?.type === "final");
    expect(events.at(-1)).toEqual({ type: "final", text: "hello there, friend." });
    expect(pane.keys).toEqual([["space"], ["esc"]]);
    // the service heard silence after the last word
    expect(mine.audio.length).toBeGreaterThanOrEqual(6 + 3200);
    expect(mine.audio.slice(6).every((byte) => byte === 0)).toBe(true);
    // a new take on the same pane is no longer refused
    const next: ClaudeVoiceEvent[] = [];
    voice.open("w1:p1", (event) => next.push(event)).cancel();
    expect(next).toEqual([]);
  });

  test("refuses a box with text, a pane waiting for an answer, a pane without Claude and a missing recorder, without a key", async () => {
    const cases: [Partial<ClaudeVoiceDeps>, string][] = [
      [{ boxReads: async () => [screen(["❯ half a thought"]), null] }, "input_draft"],
      [{ blocked: () => true }, "agent_blocked"],
      [{ pane: async () => ({ agent: "codex", status: "idle" }) }, "not_claude"],
      [{ recorderInstalled: () => false }, "recorder_missing"],
    ];
    for (const [overrides, code] of cases) {
      const { pane, voice } = setup(overrides);
      await voice.listen();
      const events: ClaudeVoiceEvent[] = [];
      voice.open("w1:p1", (event) => events.push(event));
      await until(() => events.length === 1);
      expect(events[0]).toMatchObject({ type: "error", code });
      expect(pane.keys).toEqual([]);
    }
  });

  test("a Space that started no recording is taken back", async () => {
    const { pane, voice } = setup();
    // voice mode off in that session: no REC, the Space typed into the box
    pane.top = "";
    await voice.listen();
    const events: ClaudeVoiceEvent[] = [];
    voice.open("w1:p1", (event) => events.push(event));
    await until(() => events.length === 1, 3000);
    expect(events[0]).toMatchObject({ type: "error", code: "not_listening" });
    expect(pane.keys).toEqual([["space"], ["backspace"]]);
  });

  test("one dictation per pane, and none without the socket", async () => {
    const { voice } = setup();
    const before: ClaudeVoiceEvent[] = [];
    voice.open("w1:p1", (event) => before.push(event));
    expect(before[0]).toMatchObject({ type: "error", code: "unavailable" });
    await voice.listen();
    voice.open("w1:p1", () => undefined);
    const second: ClaudeVoiceEvent[] = [];
    voice.open("w1:p1", (event) => second.push(event));
    expect(second[0]).toMatchObject({ type: "error", code: "busy" });
  });

  test("a cancel presses Esc; a recording Claude Code stopped itself is left alone", async () => {
    const { dir, pane, voice } = setup();
    await voice.listen();
    const take = voice.open("w1:p1", () => undefined);
    await until(() => pane.keys.length === 1);
    const mine = recorder(dir, "w1:p1");
    await until(() => mine.answer === "ok");
    await Bun.sleep(30);
    take.cancel();
    await until(() => pane.keys.length === 2);
    expect(pane.keys[1]).toEqual(["esc"]);

    const events: ClaudeVoiceEvent[] = [];
    voice.open("w2:p1", (event) => events.push(event));
    await until(() => pane.keys.length === 3);
    const theirs = recorder(dir, "w2:p1");
    await until(() => theirs.answer === "ok");
    theirs.socket.destroy();
    await until(() => events.some((event) => event.type === "error"));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "stopped" });
    expect(pane.keys.length).toBe(3);
  });
});
