import { describe, expect, test } from "bun:test";
import { claudeVoiceError, claudeVoiceUrl, createPcm16Resampler } from "./claudeVoice.ts";

describe("the microphone at 16 kHz", () => {
  test("48 kHz in chunks of any size gives a third as many samples, the level kept", () => {
    const resample = createPcm16Resampler(48_000);
    let total = 0;
    const values: number[] = [];
    for (const size of [4096, 4096, 1000, 7]) {
      const out = resample(new Float32Array(size).fill(0.5));
      total += out.length;
      values.push(...out);
    }
    expect(Math.abs(total - Math.floor((4096 * 2 + 1007) / 3))).toBeLessThanOrEqual(1);
    expect(values.every((value) => value === Math.round(0.5 * 0x7fff))).toBe(true);
  });

  test("44.1 kHz keeps time, and the samples stay within 16 bits", () => {
    const resample = createPcm16Resampler(44_100);
    let total = 0;
    for (let index = 0; index < 100; index += 1) {
      const input = new Float32Array(441).map((_, at) => (at % 2 === 0 ? 2 : -2));
      const out = resample(input);
      total += out.length;
      for (const value of out) expect(value >= -0x8000 && value <= 0x7fff).toBe(true);
    }
    // one second of input, at most one sample short
    expect(16_000 - total).toBeLessThanOrEqual(1);
  });

  test("16 kHz passes through", () => {
    const out = createPcm16Resampler(16_000)(Float32Array.from([0, 1, -1, 0.25]));
    expect([...out]).toEqual([0, 0x7fff, -0x8000, Math.round(0.25 * 0x7fff)]);
  });
});

describe("Claude voice's address and errors", () => {
  test("wss behind https, the pane in the query", () => {
    expect(claudeVoiceUrl("w9X:p1", { protocol: "https:", host: "pc.tail.ts.net" })).toBe("wss://pc.tail.ts.net/api/voice/claude/stream?pane_id=w9X%3Ap1");
    expect(claudeVoiceUrl("w1:p2", { protocol: "http:", host: "127.0.0.1:7317" })).toBe("ws://127.0.0.1:7317/api/voice/claude/stream?pane_id=w1%3Ap2");
  });

  test("each server code has its own note", () => {
    expect(claudeVoiceError("input_draft")).toBe("claude_draft");
    expect(claudeVoiceError("not_listening")).toBe("claude_not_listening");
    expect(claudeVoiceError("recorder_missing")).toBe("claude_setup");
    expect(claudeVoiceError("something new")).toBe("provider");
  });
});
