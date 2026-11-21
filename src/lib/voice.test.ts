import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { VoiceEvent } from "../../shared/voice.ts";
import type { InsertedSpan, VoiceError, VoiceText } from "./voice.ts";
import {
  applyDictation,
  barScales,
  classifyRelease,
  createSpeechGate,
  createVoiceEngine,
  dictationLocale,
  insertAtCaret,
  levelFromRms,
  micErrorReason,
  pickRecorderMime,
  readVoiceEvents,
  replaceIfUnchanged,
  smoothLevel,
  speechErrorReason,
  CLAUDE_TAIL_MS,
  SPEECH_HANG_MS,
  transcribeLanguage,
  voiceErrorFromCode,
  voiceKeywords,
} from "./voice.ts";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<VoiceEvent[]> {
  const events: VoiceEvent[] = [];
  for await (const event of readVoiceEvents(streamOf(chunks))) events.push(event);
  return events;
}

describe("pickRecorderMime", () => {
  it("prefers webm/opus, then mp4, webm, ogg", () => {
    expect(pickRecorderMime(() => true)).toEqual({ mimeType: "audio/webm;codecs=opus", extension: "webm" });
    expect(pickRecorderMime((type) => type !== "audio/webm;codecs=opus")).toEqual({ mimeType: "audio/mp4", extension: "m4a" });
    expect(pickRecorderMime((type) => type === "audio/webm" || type === "audio/ogg;codecs=opus")).toEqual({ mimeType: "audio/webm", extension: "webm" });
    expect(pickRecorderMime((type) => type === "audio/ogg;codecs=opus")).toEqual({ mimeType: "audio/ogg;codecs=opus", extension: "ogg" });
  });

  it("is null when nothing records", () => {
    expect(pickRecorderMime(() => false)).toBeNull();
  });
});

describe("classifyRelease", () => {
  it("keeps a tap and finishes a hold from 300 ms", () => {
    expect(classifyRelease(0)).toBe("keep");
    expect(classifyRelease(299)).toBe("keep");
    expect(classifyRelease(300)).toBe("finish");
    expect(classifyRelease(2000)).toBe("finish");
  });
});

describe("smoothLevel", () => {
  it("attacks faster than it releases", () => {
    const rise = smoothLevel(0, 1, 30);
    const fall = 1 - smoothLevel(1, 0, 30);
    expect(rise).toBeGreaterThan(fall);
    expect(rise).toBeGreaterThan(0);
    expect(rise).toBeLessThan(1);
  });

  it("holds still with no time passed and converges over time", () => {
    expect(smoothLevel(0.4, 1, 0)).toBe(0.4);
    expect(smoothLevel(0, 1, 1000)).toBeCloseTo(1, 3);
    expect(smoothLevel(1, 0, 5000)).toBeCloseTo(0, 3);
  });
});

describe("levelFromRms", () => {
  it("maps silence to 0, speech into the range, loud to 1", () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(Number.NaN)).toBe(0);
    expect(levelFromRms(0.01)).toBeCloseTo(0.4, 5);
    expect(levelFromRms(1)).toBe(1);
  });
});

describe("barScales", () => {
  const samples: Array<[number, number]> = [];
  for (const level of [0, 0.1, 0.5, 1, 2, -1]) for (const time of [0, 137, 900, 4321, 99999]) samples.push([level, time]);

  it("returns seven bars within [0.12, 1] with the centre at least the edges", () => {
    for (const [level, time] of samples) {
      const bars = barScales(level, time);
      expect(bars).toHaveLength(7);
      for (const bar of bars) {
        expect(bar).toBeGreaterThanOrEqual(0.12);
        expect(bar).toBeLessThanOrEqual(1);
      }
      expect(bars[3]!).toBeGreaterThanOrEqual(bars[0]!);
      expect(bars[3]!).toBeGreaterThanOrEqual(bars[6]!);
    }
  });

  it("moves with level and with time, even in silence", () => {
    expect(barScales(0.8, 500)[3]!).toBeGreaterThan(barScales(0.1, 500)[3]!);
    expect(barScales(0, 0)).not.toEqual(barScales(0, 900));
    expect(barScales(0.5, 0)).not.toEqual(barScales(0.5, 250));
  });
});

describe("readVoiceEvents", () => {
  it("joins a line split across three chunks", async () => {
    expect(await collect(['{"type":"del', 'ta","te', 'xt":"안녕"}\n'])).toEqual([{ type: "delta", text: "안녕" }]);
  });

  it("reads a trailing line without a newline and skips blank lines", async () => {
    const events = await collect(['\n{"type":"delta","text":"git "}\n\n', '  \n{"type":"done","text":"git status"}\n{"type":"polished","text":"git status"}']);
    expect(events).toEqual([
      { type: "delta", text: "git " },
      { type: "done", text: "git status" },
      { type: "polished", text: "git status" },
    ]);
  });

  it("decodes a multi-byte character split between chunks", async () => {
    const bytes = new TextEncoder().encode('{"type":"done","text":"한"}\n');
    const cut = bytes.indexOf(0xed) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    const events: VoiceEvent[] = [];
    for await (const event of readVoiceEvents(stream)) events.push(event);
    expect(events).toEqual([{ type: "done", text: "한" }]);
  });

  it("passes error events through and rejects a line that is not an event", async () => {
    expect(await collect(['{"type":"error","code":"provider_error","message":"boom"}\n'])).toEqual([{ type: "error", code: "provider_error", message: "boom" }]);
    await expect(collect(['{"type":"other"}\n'])).rejects.toThrow("unexpected voice event");
  });
});

describe("insertAtCaret", () => {
  it("inserts into an empty box without a space", () => {
    expect(insertAtCaret("", 0, 0, "hello")).toEqual({ value: "hello", start: 0, end: 5 });
  });

  it("separates from a preceding word", () => {
    expect(insertAtCaret("run", 3, 3, "the tests")).toEqual({ value: "run the tests", start: 4, end: 13 });
  });

  it("adds nothing after a space or a newline", () => {
    expect(insertAtCaret("run ", 4, 4, "tests")).toEqual({ value: "run tests", start: 4, end: 9 });
    expect(insertAtCaret("line\n", 5, 5, "next")).toEqual({ value: "line\nnext", start: 5, end: 9 });
  });

  it("replaces a selection mid-text", () => {
    expect(insertAtCaret("open old file", 5, 8, "src/app.ts")).toEqual({ value: "open src/app.ts file", start: 5, end: 15 });
    expect(insertAtCaret("abcdef", 2, 4, "X")).toEqual({ value: "ab X ef", start: 3, end: 4 });
  });

  it("trims the dictation and leaves the box alone when it is empty", () => {
    expect(insertAtCaret("a", 1, 1, "  b  ")).toEqual({ value: "a b", start: 2, end: 3 });
    expect(insertAtCaret("abc", 1, 2, "   ")).toEqual({ value: "abc", start: 1, end: 2 });
  });
});

describe("replaceIfUnchanged", () => {
  it("swaps in the polished text when the span still holds the raw text", () => {
    expect(replaceIfUnchanged("say 어 hello world", { start: 4, end: 17 }, "어 hello world", "Hello, world.")).toEqual({ value: "say Hello, world.", end: 17 });
  });

  it("is null when the user edited the span", () => {
    expect(replaceIfUnchanged("say hullo world", { start: 4, end: 15 }, "hello world", "Hello, world.")).toBeNull();
    expect(replaceIfUnchanged("short", { start: 2, end: 40 }, "ort", "x")).toBeNull();
  });
});

describe("dictationLocale", () => {
  it("maps the UI language to a recognition locale when the browser names none", () => {
    expect(dictationLocale("auto", "system", "ko", [])).toBe("ko-KR");
    expect(dictationLocale("auto", "system", "ja", [])).toBe("ja-JP");
    expect(dictationLocale("auto", "system", "zh", [])).toBe("zh-CN");
    expect(dictationLocale("auto", "system", "en", [])).toBe("en-US");
  });

  it("follows the browser's first language on auto when the UI is not translated into it", () => {
    // a Hungarian browser gets an English UI, but is heard in Hungarian
    expect(dictationLocale("auto", "system", "en", ["hu-HU", "en-US"])).toBe("hu-HU");
    expect(dictationLocale("auto", "system", "en", ["de"])).toBe("de");
    expect(dictationLocale("auto", "system", "ko", ["de-DE", "ko-KR"])).toBe("de-DE");
    // not a language tag: the UI language
    expect(dictationLocale("auto", "system", "en", ["*"])).toBe("en-US");
    expect(dictationLocale("auto", "system", "en", ["hu"])).toBe("hu");
    expect(dictationLocale("auto", "system", "en", ["fil-PH"])).toBe("en-US");
  });

  it("keeps the UI language's locale on auto when the browser's first language is a UI language", () => {
    expect(dictationLocale("auto", "system", "ko", ["ko", "en"])).toBe("ko-KR");
    expect(dictationLocale("auto", "system", "en", ["en-GB"])).toBe("en-US");
    expect(dictationLocale("auto", "system", "ja", ["ja"])).toBe("ja-JP");
    expect(dictationLocale("auto", "system", "zh", ["zh-TW"])).toBe("zh-CN");
    expect(dictationLocale("auto", "system", "zh", ["zh-Hant-TW"])).toBe("zh-CN");
    expect(dictationLocale("auto", "system", "en", ["en-US", "hu"])).toBe("en-US");
  });

  it("keeps a UI language chosen by hand on auto, and a chosen dictation language over both", () => {
    expect(dictationLocale("auto", "ko", "ko", ["hu-HU"])).toBe("ko-KR");
    expect(dictationLocale("hu-HU", "en", "en", ["en-US"])).toBe("hu-HU");
    expect(dictationLocale("pt-BR", "system", "en", ["de-DE"])).toBe("pt-BR");
  });
});

describe("transcribeLanguage", () => {
  it("sends the two-letter subtag, or the UI language for a tag without one", () => {
    expect(transcribeLanguage("hu-HU", "en")).toBe("hu");
    expect(transcribeLanguage("zh-TW", "en")).toBe("zh");
    expect(transcribeLanguage("DE", "ko")).toBe("de");
    expect(transcribeLanguage("fil-PH", "en")).toBe("en");
  });
});

describe("error reasons and keywords", () => {
  it("maps server, microphone and speech errors to short reasons", () => {
    expect(voiceErrorFromCode("voice_not_configured")).toBe("not_configured");
    expect(voiceErrorFromCode("audio_too_large")).toBe("too_large");
    expect(voiceErrorFromCode("provider_auth")).toBe("provider_auth");
    expect(voiceErrorFromCode("provider_error")).toBe("provider");
    expect(voiceErrorFromCode(null)).toBe("provider");
    expect(micErrorReason("NotAllowedError")).toBe("permission");
    expect(micErrorReason("NotFoundError")).toBe("no_mic");
    expect(speechErrorReason("no-speech")).toBeNull();
    expect(speechErrorReason("not-allowed")).toBe("permission");
    expect(speechErrorReason("audio-capture")).toBe("no_mic");
    expect(speechErrorReason("network")).toBe("network");
  });

  it("trims, dedupes, caps the count and drops overlong keywords instead of cutting them", () => {
    expect(voiceKeywords([" git ", "", "git", "bun test"])).toEqual(["git", "bun test"]);
    expect(voiceKeywords(Array.from({ length: 80 }, (_, index) => `k${index}`))).toHaveLength(50);
    expect(voiceKeywords(["x".repeat(200), "y".repeat(80), "z".repeat(81)])).toEqual(["y".repeat(80)]);
  });
});

describe("createSpeechGate", () => {
  /** feeds one reading per 16 ms frame from `from` and returns the gate's decisions with their times */
  const run = (gate: ReturnType<typeof createSpeechGate>, rms: number, from: number, ms: number) => {
    const changes: Array<[number, string]> = [];
    for (let now = from; now < from + ms; now += 16) {
      const change = gate.step(rms, now);
      if (change) changes.push([now, change]);
    }
    return changes;
  };

  it("stays shut in silence and opens on the first loud frame", () => {
    const gate = createSpeechGate();
    expect(run(gate, 0, 0, 1500)).toEqual([]);
    expect(gate.everOpened).toBe(false);
    expect(run(gate, 0.05, 1504, 32)).toEqual([[1504, "open"]]);
    expect(gate.everOpened).toBe(true);
  });

  it("keeps a pause between words and closes after the hang", () => {
    const gate = createSpeechGate();
    run(gate, 0.05, 0, 500);
    expect(run(gate, 0, 496, SPEECH_HANG_MS - 100)).toEqual([]);
    expect(gate.open).toBe(true);
    const closes = run(gate, 0, 496 + SPEECH_HANG_MS - 100, 400);
    expect(closes).toHaveLength(1);
    expect(closes[0]![1]).toBe("close");
    expect(closes[0]![0] - gate.lastLoudAt).toBeGreaterThanOrEqual(SPEECH_HANG_MS);
  });

  it("learns a steady noise floor and still opens for speech above it", () => {
    const gate = createSpeechGate();
    expect(run(gate, 0.008, 0, 3000)).toEqual([]);
    expect(run(gate, 0.015, 3000, 200)).toEqual([]);
    expect(run(gate, 0.08, 3200, 32)).toEqual([[3200, "open"]]);
  });

  it("never shuts on a long loud sentence", () => {
    const gate = createSpeechGate();
    expect(run(gate, 0.1, 0, 30_000)).toEqual([[0, "open"]]);
  });
});

describe("applyDictation", () => {
  const end = (value: string) => ({ start: value.length, end: value.length });
  /** the box after an applied dictation; fails the test when it was refused or changed nothing */
  const applied = (...args: Parameters<typeof applyDictation>) => {
    const next = applyDictation(...args);
    if (next === null || next === "too_long") throw new Error(`not applied: ${String(next)}`);
    return next;
  };

  it("puts each take's polish on its own words, even when a later take finished first", () => {
    const spans = new Map<number, InsertedSpan>();
    let box = applied("", end(""), spans, { take: 1, phase: "raw", text: "음 git status 봐줘" }).value;
    box = applied(box, end(box), spans, { take: 2, phase: "raw", text: "그리고 커밋" }).value;
    expect(box).toBe("음 git status 봐줘 그리고 커밋");
    box = applied(box, end(box), spans, { take: 1, phase: "polished", text: "git status 봐 줘." }).value;
    expect(box).toBe("git status 봐 줘. 그리고 커밋");
    box = applied(box, end(box), spans, { take: 2, phase: "polished", text: "그리고 커밋해 줘." }).value;
    expect(box).toBe("git status 봐 줘. 그리고 커밋해 줘.");
  });

  it("drops a polish whose take never inserted text or whose words were edited", () => {
    const spans = new Map<number, InsertedSpan>();
    expect(applyDictation("hi", end("hi"), spans, { take: 7, phase: "polished", text: "Hi." })).toBeNull();
    const box = applied("", end(""), spans, { take: 1, phase: "raw", text: "음 안녕" }).value;
    expect(applyDictation(`${box}하세요`.replace("음", "응"), end(box), spans, { take: 1, phase: "polished", text: "안녕." })).toBeNull();
  });

  it("refuses a dictation that would push the box past its limit, keeping the draft after the caret", () => {
    const spans = new Map<number, InsertedSpan>();
    const draft = "앞 뒤";
    expect(applyDictation(draft, { start: 1, end: 1 }, spans, { take: 1, phase: "raw", text: "가나다라" }, 6)).toBe("too_long");
    expect(spans.size).toBe(0);
    const fits = applyDictation(draft, { start: 1, end: 1 }, spans, { take: 2, phase: "raw", text: "가" }, 6);
    expect(fits).toEqual({ value: "앞 가 뒤", caret: 3 });
    expect(applyDictation("앞 가 뒤", { start: 5, end: 5 }, spans, { take: 2, phase: "polished", text: "가나다" }, 6)).toBeNull();
  });

  it("leaves a selection alone and writes nothing for an unchanged polish", () => {
    const spans = new Map<number, InsertedSpan>();
    const box = applied("", end(""), spans, { take: 1, phase: "raw", text: "run tests" }).value;
    expect(applyDictation(box, { start: 4, end: 9 }, spans, { take: 1, phase: "polished", text: "Run tests." })).toBeNull();
    const again = applied("", end(""), spans, { take: 2, phase: "raw", text: "run tests" }).value;
    expect(applyDictation(again, end(again), spans, { take: 2, phase: "polished", text: "run tests" })).toBeNull();
  });

  it("drops a polish once the box was edited, even when the old offsets still read the same", () => {
    const spans = new Map<number, InsertedSpan>();
    const draft = "um check tests";
    const box = applied(draft, { start: 0, end: 0 }, spans, { take: 1, phase: "raw", text: "um check tests" }).value;
    expect(box).toBe("um check tests um check tests");
    // the user deletes the dictated words: the original draft now sits at the stored offsets
    expect(applyDictation(draft, { start: 0, end: 0 }, spans, { take: 1, phase: "polished", text: "check tests" })).toBeNull();
  });

  it("forgets a take whose words were overwritten by the next one", () => {
    const spans = new Map<number, InsertedSpan>();
    const first = applied("", end(""), spans, { take: 1, phase: "raw", text: "음 첫째" }).value;
    const second = applied(first, { start: 0, end: first.length }, spans, { take: 2, phase: "raw", text: "둘째" }).value;
    expect(second).toBe("둘째");
    expect(applyDictation(second, end(second), spans, { take: 1, phase: "polished", text: "첫째." })).toBeNull();
    expect(applied(second, end(second), spans, { take: 2, phase: "polished", text: "둘째." }).value).toBe("둘째.");
  });
});

describe("createVoiceEngine", () => {
  class FakeStream {
    stopped = false;
    private readonly track = { readyState: "live", stop: () => { this.stopped = true; this.track.readyState = "ended"; } };
    getTracks() { return [this.track]; }
    getAudioTracks() { return [this.track]; }
  }
  class FakeRecorder {
    static made: FakeRecorder[] = [];
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstart: (() => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(readonly stream: FakeStream) { FakeRecorder.made.push(this); }
    start() { this.state = "recording"; this.onstart?.(); }
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["audio"]) }); this.onstop?.(); }
  }
  class FakeSpeech {
    static made: FakeSpeech[] = [];
    lang = "";
    continuous = false;
    interimResults = false;
    onaudiostart: (() => void) | null = null;
    onresult = null;
    onerror = null;
    onend: (() => void) | null = null;
    constructor() { FakeSpeech.made.push(this); }
    start() { this.onaudiostart?.(); }
    stop() { this.onend?.(); }
    abort() { this.onend?.(); }
  }

  /** the connection of a Claude pane's take: what the page sent, and the server's events as the test gives them */
  class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static made: FakeSocket[] = [];
    readyState = FakeSocket.CONNECTING;
    binaryType = "";
    sent: unknown[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((message: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) { FakeSocket.made.push(this); }
    send(data: unknown) { this.sent.push(data); }
    close() { if (this.readyState === FakeSocket.CLOSED) return; this.readyState = FakeSocket.CLOSED; this.onclose?.(); }
    open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
    event(event: object) { this.onmessage?.({ data: JSON.stringify(event) }); }
    /** the control frames the page sent, parsed */
    frames() { return this.sent.filter((data): data is string => typeof data === "string").map((data) => JSON.parse(data) as Record<string, unknown>); }
  }
  const node = () => ({ connect: () => undefined, disconnect: () => undefined });
  class FakeAudioContext {
    state = "running";
    sampleRate = 48_000;
    destination = {};
    createAnalyser() { return { ...node(), fftSize: 0, getFloatTimeDomainData: () => undefined }; }
    createDelay() { return { ...node(), delayTime: { value: 0 } }; }
    createMediaStreamDestination() { return { stream: new FakeStream() }; }
    createMediaStreamSource() { return node(); }
    createScriptProcessor() { return { ...node(), onaudioprocess: null }; }
    createGain() { return { ...node(), gain: { value: 1 } }; }
    resume() { return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
  }

  const GLOBALS = ["document", "MediaRecorder", "requestAnimationFrame", "cancelAnimationFrame", "fetch", "WebSocket", "AudioContext", "window"] as const;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const define = (target: object, name: string, value: unknown) => Object.defineProperty(target, name, { configurable: true, writable: true, value });
  /** each getUserMedia call, to be answered by the test in the order it chooses */
  let micRequests: Array<(stream: FakeStream) => void> = [];
  let frames: FrameRequestCallback[] = [];
  let uploads: Array<(response: Response) => void> = [];
  let uploadedLanguages: Array<FormDataEntryValue | null> = [];

  beforeEach(() => {
    micRequests = [];
    frames = [];
    uploads = [];
    uploadedLanguages = [];
    FakeRecorder.made = [];
    FakeSpeech.made = [];
    FakeSocket.made = [];
    for (const name of GLOBALS) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    saved.set("mediaDevices", Object.getOwnPropertyDescriptor(navigator, "mediaDevices"));
    define(globalThis, "document", { hidden: false });
    define(globalThis, "MediaRecorder", FakeRecorder);
    define(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    define(globalThis, "cancelAnimationFrame", () => undefined);
    define(globalThis, "fetch", (_url: string, init: RequestInit) => {
      expect(init.body).toBeInstanceOf(FormData);
      uploadedLanguages.push((init.body as FormData).get("language"));
      return new Promise<Response>((resolve) => { uploads.push(resolve); });
    });
    define(navigator, "mediaDevices", { getUserMedia: () => new Promise<FakeStream>((resolve) => { micRequests.push(resolve); }) });
  });

  afterEach(() => {
    for (const [name, descriptor] of saved) {
      const target: object = name === "mediaDevices" ? navigator : globalThis;
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    }
    saved.clear();
  });

  function engine(locale = "en-US", provider: "server" | "browser" | "claude" = "server", polish = false) {
    const states: string[] = [];
    const texts: string[] = [];
    const results: VoiceText[] = [];
    const errors: Array<VoiceError | null> = [];
    const waiting: Array<{ state: string; resolve: () => void }> = [];
    const voice = createVoiceEngine({
      setState: (state) => {
        states.push(state);
        for (const waiter of waiting.splice(0)) if (waiter.state === state) waiter.resolve(); else waiting.push(waiter);
      },
      setElapsed: () => undefined,
      setSilent: () => undefined,
      setError: (error) => { errors.push(error); },
      options: () => ({ mode: "chat", enabled: true, polish, keywords: () => ["Claude", " /voice ", ""], onText: (result) => { texts.push(result.text); results.push(result); } }),
      engine: () => provider,
      language: () => ({ locale, ui: "en" }),
      recorder: () => ({ mimeType: "audio/webm", extension: "webm" }),
      speech: () => provider === "browser" ? FakeSpeech : null,
      claudePane: () => provider === "claude" ? "w1:p1" : null,
    });
    const reached = (state: string) => new Promise<void>((resolve) => { waiting.push({ state, resolve }); });
    return { voice, states, texts, results, errors, reached };
  }

  /** a Claude pane's take up to the finish: connected, the microphone open, Claude Code listening, the mic tapped again */
  async function claudeTake(polish: boolean, tail = true) {
    // only these takes get a WebAudio: with one, the other engines record through its delay line
    define(globalThis, "WebSocket", FakeSocket);
    define(globalThis, "AudioContext", FakeAudioContext);
    define(globalThis, "window", { location: { protocol: "https:", host: "herdr.test" } });
    const made = engine("en-US", "claude", polish);
    made.voice.press();
    const socket = FakeSocket.made[0]!;
    socket.open();
    micRequests[0]!(new FakeStream());
    await drain();
    socket.event({ type: "listening" });
    expect(made.states.at(-1)).toBe("recording");
    made.voice.press();
    expect(made.states.at(-1)).toBe("transcribing");
    // the microphone stays open for the last word before the finish goes out
    expect(socket.frames().some((frame) => frame["type"] === "finish")).toBe(false);
    if (tail) await new Promise((resolve) => setTimeout(resolve, CLAUDE_TAIL_MS + 30));
    return { ...made, socket };
  }

  /** lets the engine's own continuations after a resolved promise run; nothing here waits on time */
  const drain = async (): Promise<void> => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };

  it("passes the selected full locale to browser recognition without uploading audio", () => {
    const { voice } = engine("hu-HU", "browser");
    try {
      voice.press();
      expect(FakeSpeech.made).toHaveLength(1);
      expect(FakeSpeech.made[0]!.lang).toBe("hu-HU");
      expect(micRequests).toHaveLength(0);
      expect(uploads).toHaveLength(0);
    } finally { voice.cancel(); }
  });

  it("uploads the selected language rather than the display language", async () => {
    const { voice, reached } = engine("hu-HU");
    try {
      voice.press();
      micRequests[0]!(new FakeStream());
      await drain();
      frames.pop()!(performance.now() + 1000);
      voice.press();
      await drain();
      expect(uploadedLanguages).toEqual(["hu"]);
      const idle = reached("idle");
      uploads[0]!(new Response('{"type":"done","text":"teszt"}\n'));
      await idle;
    } finally { voice.cancel(); }
  });

  it("closes only its own stream when a cancelled microphone request answers after a newer one", async () => {
    const { voice } = engine();
    voice.press();
    voice.cancel();
    voice.press();
    expect(micRequests).toHaveLength(2);
    const stale = new FakeStream();
    const current = new FakeStream();
    micRequests[1]!(current);
    await drain();
    expect(FakeRecorder.made.map((recorder) => recorder.stream)).toEqual([current]);
    micRequests[0]!(stale);
    await drain();
    expect(stale.stopped).toBe(true);
    expect(current.stopped).toBe(false);
    voice.cancel();
  });

  it("starts no new take while an earlier one is still being transcribed", async () => {
    const { voice, states, texts, reached } = engine();
    voice.press();
    micRequests[0]!(new FakeStream());
    await drain();
    // the meter loop is what moves a take from starting to recording
    frames.pop()!(performance.now() + 1000);
    expect(states.at(-1)).toBe("recording");
    voice.press();
    expect(states.at(-1)).toBe("transcribing");
    await drain();
    expect(uploads).toHaveLength(1);

    voice.press();
    expect(states.at(-1)).toBe("transcribing");
    expect(FakeRecorder.made).toHaveLength(1);

    const idle = reached("idle");
    uploads[0]!(new Response('{"type":"done","text":"create the file"}\n'));
    await idle;
    expect(texts).toEqual(["create the file"]);
    voice.press();
    await drain();
    expect(FakeRecorder.made).toHaveLength(2);
    voice.cancel();
  });

  it("asks a Claude pane's take for its rebuilt words and puts them over the raw ones", async () => {
    const { voice, states, results, errors, socket } = await claudeTake(true);
    try {
      expect(socket.url).toBe("wss://herdr.test/api/voice/claude/stream?pane_id=w1%3Ap1");
      // what the take asks for is the first frame, before any audio
      expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: "options", polish: true, keywords: ["Claude", "/voice"] });
      expect(socket.frames().at(-1)).toEqual({ type: "finish" });

      socket.event({ type: "final", text: "Open the herder app.  And check it.", polish: true });
      expect(results).toEqual([{ text: "Open the herder app. And check it.", phase: "raw", take: 1 }]);
      // the rebuilt words are still owed: the connection stays, and no second take starts over them
      expect(states.at(-1)).toBe("transcribing");
      expect(socket.readyState).toBe(FakeSocket.OPEN);
      voice.press();
      expect(FakeSocket.made).toHaveLength(1);

      socket.event({ type: "polished", text: "Open the herdr app and check it." });
      expect(results.at(-1)).toEqual({ text: "Open the herdr app and check it.", phase: "polished", take: 1 });
      expect(states.at(-1)).toBe("idle");
      expect(socket.readyState).toBe(FakeSocket.CLOSED);
      expect(errors.filter(Boolean)).toEqual([]);
    } finally { voice.cancel(); }
  });

  it("keeps the raw words when the rebuilt ones never come, and ends at once without the promise", async () => {
    const lost = await claudeTake(true);
    try {
      lost.socket.event({ type: "final", text: "as heard", polish: true });
      // the server went away while it rebuilt: the words are in the box, nothing failed
      lost.socket.close();
      expect(lost.results).toEqual([{ text: "as heard", phase: "raw", take: 1 }]);
      expect(lost.states.at(-1)).toBe("idle");
      expect(lost.errors.filter(Boolean)).toEqual([]);
    } finally { lost.voice.cancel(); }

    FakeSocket.made = [];
    micRequests = [];
    const plain = await claudeTake(false);
    try {
      expect(JSON.parse(plain.socket.sent[0] as string)).toMatchObject({ type: "options", polish: false });
      // a server that rebuilds nothing, or was not asked to, promises nothing
      plain.socket.event({ type: "final", text: "only these words" });
      expect(plain.results).toEqual([{ text: "only these words", phase: "raw", take: 1 }]);
      expect(plain.states.at(-1)).toBe("idle");
      // a late event of that take changes nothing
      plain.socket.event({ type: "polished", text: "never asked for" });
      expect(plain.results).toHaveLength(1);
    } finally { plain.voice.cancel(); }
  });

  it("lets go of the microphone when the server ends a take over a long silence", async () => {
    define(globalThis, "WebSocket", FakeSocket);
    define(globalThis, "AudioContext", FakeAudioContext);
    define(globalThis, "window", { location: { protocol: "https:", host: "herdr.test" } });
    const { voice, states, results, errors } = engine("en-US", "claude", true);
    try {
      voice.press();
      const socket = FakeSocket.made[0]!;
      socket.open();
      micRequests[0]!(new FakeStream());
      await drain();
      socket.event({ type: "listening" });
      expect(states.at(-1)).toBe("recording");
      // nobody tapped: the words come with the server's own finish, their rebuilt form after them
      socket.event({ type: "final", text: "said before the silence", polish: true });
      expect(states.at(-1)).toBe("transcribing");
      expect(socket.frames().some((frame) => frame["type"] === "finish")).toBe(false);
      socket.event({ type: "polished", text: "Said before the silence." });
      expect(results.map((result) => result.phase)).toEqual(["raw", "polished"]);
      expect(states.at(-1)).toBe("idle");
      expect(errors.filter(Boolean)).toEqual([]);
    } finally { voice.cancel(); }
  });

  it("sends no finish for a take cancelled while its last word was still coming in", async () => {
    const { voice, states, socket } = await claudeTake(true, false);
    voice.cancel();
    await new Promise((resolve) => setTimeout(resolve, CLAUDE_TAIL_MS + 30));
    expect(socket.frames().map((frame) => frame["type"])).toEqual(["options", "cancel"]);
    expect(states.at(-1)).toBe("idle");
  });

  it("cancels the rebuild with the take", async () => {
    const { voice, states, results, socket } = await claudeTake(true);
    socket.event({ type: "final", text: "as heard", polish: true });
    voice.cancel();
    expect(socket.frames().at(-1)).toEqual({ type: "cancel" });
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    expect(states.at(-1)).toBe("idle");
    socket.event({ type: "polished", text: "too late" });
    expect(results).toHaveLength(1);
  });
});
