import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxTranscript, ClaudeVoice, claudeBoxView, claudeBoxWords, claudeVoiceSettings, type ClaudeVoiceDeps } from "./claude-voice.ts";
import type { RebuildJob } from "./claude-rebuild.ts";
import type { ClaudeVoiceEvent } from "../shared/claude-voice.ts";

const rule = "─".repeat(60);
/** Claude Code's screen around its message box, as 2.1.328 draws it while it listens */
const screen = (box: string[], top = "                                     ● REC · tap to send", above = rule) =>
  ["⏺ Done.", "", top, above, ...box, rule, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
/** the rule above a box whose text scrolled out of it, as 2.1.330 draws it */
const scrolledRule = (rows: number): string => `─── ↑ ${rows} more ${"─".repeat(60)}`.slice(0, 60);

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

describe("Claude Code's box, whole and scrolled", () => {
  test("a whole box has nothing above it", () => {
    expect(claudeBoxView(screen(["❯ Well, I don't wish to see it anymore, observed", "  Phoebe.▁"]))).toEqual({ above: 0, rows: ["Well, I don't wish to see it anymore, observed", "Phoebe."], width: 60 });
    expect(claudeBoxView(screen(["❯ ▁"]))).toEqual({ above: 0, rows: [""], width: 60 });
  });

  test("a scrolled box says how many rows are above the ones it shows", () => {
    expect(claudeBoxView(screen(["  pass it on Monday. Yeah, see, was for the", "  DNR will give the penalty.█"], undefined, scrolledRule(7))))
      .toEqual({ above: 7, rows: ["pass it on Monday. Yeah, see, was for the", "DNR will give the penalty."], width: 60 });
    // the caret alone on the last row
    expect(claudeBoxView(screen(["  the last words", "  ▂"], undefined, scrolledRule(12)))?.rows).toEqual(["the last words", ""]);
  });

  test("no box, a bash line and a named session's rule over other rows are no dictation box", () => {
    expect(claudeBoxView("$ ls\nREADME.md")).toBeNull();
    expect(claudeBoxView(screen(["! ls"]))).toBeNull();
    expect(claudeBoxView(screen(["  not a prompt row"], undefined, `─── my session ${"─".repeat(40)}`))).toBeNull();
  });
});

describe("a dictation longer than the box", () => {
  const view = (above: number, rows: string[], width = 60) => ({ above, rows, width });

  test("rows that scrolled out of the box stay in the text", () => {
    const transcript = new BoxTranscript();
    expect(transcript.read(view(0, ["one two three", "four five"]))).toBe("one two three four five");
    expect(transcript.read(view(0, ["one two three", "four five six", "seven"]))).toBe("one two three four five six seven");
    expect(transcript.read(view(1, ["four five six", "seven eight", "nine"]))).toBe("one two three four five six seven eight nine");
    expect(transcript.read(view(3, ["nine ten", "eleven"]))).toBe("one two three four five six seven eight nine ten eleven");
  });

  test("words still being recognised change on the rows shown, never above them", () => {
    const transcript = new BoxTranscript();
    transcript.read(view(0, ["the report", "that I send", "yes today"]));
    expect(transcript.read(view(1, ["that I sent", "yesterday because", "the client"]))).toBe("the report that I sent yesterday because the client");
    // the text got shorter again: fewer rows above
    expect(transcript.read(view(0, ["the report", "that I sent"]))).toBe("the report that I sent");
  });

  test("a pane that changed its width keeps what was said before the rows shown", () => {
    const transcript = new BoxTranscript();
    transcript.read(view(0, ["alpha beta gamma delta", "epsilon zeta eta theta", "iota kappa lambda mu"], 30));
    transcript.read(view(1, ["epsilon zeta eta theta", "iota kappa lambda mu", "nu xi omicron pi"], 30));
    // wrapped anew at another width, the box now starts in the middle of an old row
    expect(transcript.read(view(3, ["eta theta iota kappa", "lambda mu nu xi", "omicron pi rho"], 22)))
      .toBe("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho");
    // and goes on from there at the new width
    expect(transcript.read(view(4, ["lambda mu nu xi", "omicron pi rho sigma", "tau"], 22)))
      .toBe("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau");
  });

  test("rows nobody read are a gap: what was known is kept, what is shown is added", () => {
    const transcript = new BoxTranscript();
    transcript.read(view(0, ["first row here", "second row here"]));
    expect(transcript.read(view(5, ["much later words", "and the end"]))).toBe("first row here second row here much later words and the end");
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
    const pane = { box: ["❯ "], keys: [] as string[][], top: "                                     ● REC · tap to send", rule };
    const deps: ClaudeVoiceDeps = {
      dir, name: "t",
      pane: async () => ({ agent: "claude", status: "idle" }),
      boxReads: async () => [screen(pane.box, pane.top, pane.rule), null],
      screen: async () => screen(pane.box, pane.top, pane.rule),
      keys: async (_, keys) => { pane.keys.push(keys); if (keys[0] === "esc") { pane.box = ["❯ "]; pane.top = ""; pane.rule = rule; } },
      blocked: () => false,
      settings: () => ({ enabled: true, mode: "tap" }),
      recorderInstalled: () => true,
      timing: { recorderWait: 300, poll: 20, settlePoll: 20, settleSilence: 120, settleStable: 60, settleMax: 1500, clearWait: 300, clearPoll: 10, max: 10_000 },
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
    // the pane is the take's until Claude Code's screen shows no recording
    await until(() => !voice.busy("w1:p1"));
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

  test("a take nobody speaks into ends itself, before Claude Code's own silence limit would send its words", async () => {
    const timing = { recorderWait: 300, silence: 150, poll: 20, settlePoll: 20, settleSilence: 60, settleStable: 40, settleMax: 1500, clearWait: 300, clearPoll: 10, max: 10_000 };
    const { dir, pane, voice } = setup({ timing });
    await voice.listen();
    const events: ClaudeVoiceEvent[] = [];
    voice.open("w1:p1", (event) => events.push(event));
    await until(() => pane.keys.length === 1);
    const mine = recorder(dir, "w1:p1");
    await until(() => mine.answer === "ok");
    pane.box = ["❯ three words here▁"];
    await until(() => events.some((event) => event.type === "partial"));
    // new words keep it open
    await Bun.sleep(100);
    pane.box = ["❯ three words here and more▁"];
    await Bun.sleep(100);
    expect(events.some((event) => event.type === "final")).toBe(false);
    // then nothing: the phone never finishes, the take does, with an Esc and never an Enter
    await until(() => events.at(-1)?.type === "final");
    expect(events.at(-1)).toEqual({ type: "final", text: "three words here and more" });
    expect(pane.keys).toEqual([["space"], ["esc"]]);

    // a take nobody spoke into at all ends the same way, with no words
    const quiet = setup({ timing });
    await quiet.voice.listen();
    const none: ClaudeVoiceEvent[] = [];
    quiet.voice.open("w1:p1", (event) => none.push(event));
    await until(() => quiet.pane.keys.length === 1);
    const theirs = recorder(quiet.dir, "w1:p1");
    await until(() => theirs.answer === "ok");
    await until(() => none.at(-1)?.type === "final");
    expect(none.at(-1)).toEqual({ type: "final", text: "" });
    expect(quiet.pane.keys).toEqual([["space"], ["esc"]]);
  });

  /** a rebuild whose program is the test's: what it was given, and whether it was stopped */
  function rebuilder(answer: (words: string) => Promise<string | null> | string | null) {
    const jobs: Array<{ ran: Array<[string, readonly string[]]>; cancelled: number }> = [];
    const rebuild = (): RebuildJob => {
      const job = { ran: [] as Array<[string, readonly string[]]>, cancelled: 0 };
      jobs.push(job);
      return { run: async (words, keywords) => { job.ran.push([words, keywords]); return answer(words); }, cancel: () => { job.cancelled += 1; } };
    };
    return { jobs, rebuild };
  }

  test("a dictation that scrolls Claude Code's box comes back whole", async () => {
    const { dir, pane, voice } = setup();
    await voice.listen();
    const events: ClaudeVoiceEvent[] = [];
    const take = voice.open("w1:p1", (event) => events.push(event));
    await until(() => pane.keys.length === 1);
    const mine = recorder(dir, "w1:p1");
    await until(() => mine.answer === "ok");
    const partial = (text: string) => until(() => events.some((event) => event.type === "partial" && event.text === text));

    pane.box = ["❯ So I want to ask if you can", "  please check the report▃"];
    await partial("So I want to ask if you can please check the report");
    pane.box = ["❯ So I want to ask if you can", "  please check the report that", "  I sent yesterday▅"];
    await partial("So I want to ask if you can please check the report that I sent yesterday");
    // the box is full: its first row scrolls out and the rule above counts it
    pane.rule = scrolledRule(1);
    pane.box = ["  please check the report that", "  I sent yesterday because the", "  client is asking▂"];
    await partial("So I want to ask if you can please check the report that I sent yesterday because the client is asking");
    pane.rule = scrolledRule(2);
    pane.box = ["  I sent yesterday because the", "  client is asking for the", "  update.▁"];
    take.finish();
    await until(() => events.at(-1)?.type === "final");
    expect(events.at(-1)).toEqual({ type: "final", text: "So I want to ask if you can please check the report that I sent yesterday because the client is asking for the update." });
    expect(pane.keys).toEqual([["space"], ["esc"]]);
  });

  test("asked to, the words are rebuilt once they are sent: the raw ones first, one Esc, the pane free meanwhile", async () => {
    let answer: (text: string | null) => void = () => undefined;
    const { jobs, rebuild } = rebuilder(() => new Promise<string | null>((resolve) => { answer = resolve; }));
    const { dir, pane, voice } = setup({ rebuild });
    await voice.listen();
    const events: ClaudeVoiceEvent[] = [];
    const take = voice.open("w1:p1", (event) => events.push(event));
    take.options({ polish: true, keywords: ["herdr", " /voice ", "<b>", "x".repeat(200), 7 as unknown as string] });
    await until(() => pane.keys.length === 1);
    expect(jobs).toHaveLength(0);
    const mine = recorder(dir, "w1:p1");
    await until(() => mine.answer === "ok");
    // the program starts with the listening, not with the words
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.ran).toEqual([]);

    pane.box = ["❯ Open the herder app. And check the files.▁"];
    take.finish();
    await until(() => events.at(-1)?.type === "final");
    expect(events.at(-1)).toEqual({ type: "final", text: "Open the herder app. And check the files.", polish: true });
    await until(() => jobs[0]!.ran.length === 1);
    expect(jobs[0]!.ran[0]).toEqual(["Open the herder app. And check the files.", ["herdr", "/voice", "b"]]);
    // the box is clear and the rebuild needs nothing of the pane: another dictation may start
    await until(() => !voice.busy("w1:p1"));
    answer("Open the herdr app and check the files.");
    await until(() => events.at(-1)?.type === "polished");
    expect(events.at(-1)).toEqual({ type: "polished", text: "Open the herdr app and check the files." });
    expect(pane.keys).toEqual([["space"], ["esc"]]);
    expect(jobs).toHaveLength(1);
  });

  test("a rebuild that gives nothing leaves the words as heard; no rebuild is promised for no words or on a server without one", async () => {
    const failing = rebuilder(() => null);
    const first = setup({ rebuild: failing.rebuild });
    await first.voice.listen();
    const events: ClaudeVoiceEvent[] = [];
    const take = first.voice.open("w1:p1", (event) => events.push(event));
    take.options({ polish: true });
    await until(() => first.pane.keys.length === 1);
    const mine = recorder(first.dir, "w1:p1");
    await until(() => mine.answer === "ok");
    first.pane.box = ["❯ hello there▁"];
    take.finish();
    await until(() => events.at(-1)?.type === "polished");
    expect(events.slice(-2)).toEqual([{ type: "final", text: "hello there", polish: true }, { type: "polished", text: "hello there" }]);

    // nothing was said: nothing to rebuild, and the program that was started is stopped
    const silent = rebuilder(() => "never asked");
    const second = setup({ rebuild: silent.rebuild });
    await second.voice.listen();
    const quiet: ClaudeVoiceEvent[] = [];
    const none = second.voice.open("w1:p1", (event) => quiet.push(event));
    none.options({ polish: true });
    await until(() => second.pane.keys.length === 1);
    const theirs = recorder(second.dir, "w1:p1");
    await until(() => theirs.answer === "ok");
    none.finish();
    await until(() => quiet.at(-1)?.type === "final");
    expect(quiet.at(-1)).toEqual({ type: "final", text: "" });
    await until(() => !second.voice.busy("w1:p1"));
    expect(silent.jobs).toHaveLength(1);
    expect(silent.jobs[0]!.ran).toEqual([]);
    expect(silent.jobs[0]!.cancelled).toBeGreaterThan(0);

    // a server that cannot rebuild sends the words alone, whatever was asked
    const third = setup();
    await third.voice.listen();
    const plain: ClaudeVoiceEvent[] = [];
    const unasked = third.voice.open("w1:p1", (event) => plain.push(event));
    unasked.options({ polish: true });
    await until(() => third.pane.keys.length === 1);
    const last = recorder(third.dir, "w1:p1");
    await until(() => last.answer === "ok");
    third.pane.box = ["❯ as heard▁"];
    unasked.finish();
    await until(() => plain.at(-1)?.type === "final");
    expect(plain.at(-1)).toEqual({ type: "final", text: "as heard" });
  });

  test("the phone leaving with its words presses no second Esc; a cancel while they are rebuilt stops the program", async () => {
    // an older page closes at `final`: the Esc is pressed already, and one more would open Claude Code's rewind
    const { dir, pane, voice } = setup();
    await voice.listen();
    const events: ClaudeVoiceEvent[] = [];
    const take = voice.open("w1:p1", (event) => { events.push(event); if (event.type === "final") void take.cancel(); });
    await until(() => pane.keys.length === 1);
    const mine = recorder(dir, "w1:p1");
    await until(() => mine.answer === "ok");
    pane.box = ["❯ hello▁"];
    take.finish();
    await until(() => !voice.busy("w1:p1"));
    await Bun.sleep(40);
    expect(events.at(-1)).toEqual({ type: "final", text: "hello" });
    expect(pane.keys).toEqual([["space"], ["esc"]]);

    const slow = rebuilder(() => new Promise<string | null>(() => undefined));
    const other = setup({ rebuild: slow.rebuild });
    await other.voice.listen();
    const theirs: ClaudeVoiceEvent[] = [];
    const second = other.voice.open("w1:p1", (event) => theirs.push(event));
    second.options({ polish: true });
    await until(() => other.pane.keys.length === 1);
    const rec = recorder(other.dir, "w1:p1");
    await until(() => rec.answer === "ok");
    other.pane.box = ["❯ hello again▁"];
    second.finish();
    await until(() => slow.jobs[0]?.ran.length === 1);
    await second.cancel();
    await Bun.sleep(40);
    expect(theirs.at(-1)).toEqual({ type: "final", text: "hello again", polish: true });
    expect(slow.jobs[0]!.cancelled).toBeGreaterThan(0);
    expect(other.pane.keys).toEqual([["space"], ["esc"]]);
  });
});
