/**
 * The browser's half of Claude voice (shared/claude-voice.ts): a Claude pane's mic streams the
 * microphone as 16 kHz mono 16-bit PCM to the server, where Claude Code's own voice mode
 * transcribes it; the words come back to the composer. The engine itself lives in voice.ts.
 */
import { CLAUDE_VOICE_SAMPLE_RATE, type ClaudeVoiceErrorCode, type ClaudeVoiceStatus } from "../../shared/claude-voice.ts";

/**
 * Turns the microphone's float samples at `inputRate` into 16 kHz 16-bit samples, chunk after
 * chunk: each output sample is the mean of the input it stands for (a box filter, enough for
 * speech), and what a chunk leaves over is carried into the next.
 */
export function createPcm16Resampler(inputRate: number): (input: Float32Array) => Int16Array {
  const ratio = inputRate / CLAUDE_VOICE_SAMPLE_RATE;
  let carry = new Float32Array(0);
  let offset = 0;
  return (input) => {
    const data = new Float32Array(carry.length + input.length);
    data.set(carry);
    data.set(input, carry.length);
    const out = new Int16Array(Math.max(0, Math.floor((data.length - offset) / ratio) + 1));
    let count = 0;
    let position = offset;
    while (position + ratio <= data.length) {
      const start = Math.floor(position);
      const end = Math.max(start + 1, Math.floor(position + ratio));
      let sum = 0;
      for (let index = start; index < end; index += 1) sum += data[index]!;
      const value = Math.max(-1, Math.min(1, sum / (end - start)));
      out[count] = value < 0 ? Math.round(value * 0x8000) : Math.round(value * 0x7fff);
      count += 1;
      position += ratio;
    }
    const kept = Math.floor(position);
    carry = data.slice(kept);
    offset = position - kept;
    return out.slice(0, count);
  };
}

export function claudeVoiceUrl(paneId: string, location: Pick<Location, "protocol" | "host"> = window.location): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/voice/claude/stream?pane_id=${encodeURIComponent(paneId)}`;
}

let statusPromise: Promise<ClaudeVoiceStatus | null> | null = null;
let statusAt = 0;
/** how long an answer of GET /api/voice/claude is kept: the server's setup changes rarely */
const STATUS_TTL_MS = 60_000;

/** GET /api/voice/claude, shared by every composer; null when the server cannot say. */
export function loadClaudeVoiceStatus(refresh = false): Promise<ClaudeVoiceStatus | null> {
  if (!statusPromise || refresh || Date.now() - statusAt > STATUS_TTL_MS) {
    statusAt = Date.now();
    statusPromise = fetch("/api/voice/claude", { credentials: "same-origin" })
      .then((response) => response.ok ? response.json() as Promise<ClaudeVoiceStatus> : null)
      .catch(() => null);
  }
  return statusPromise;
}

/** The dictation error the composer explains, for a server's code. */
export function claudeVoiceError(code: ClaudeVoiceErrorCode | string): "claude_setup" | "claude_blocked" | "claude_draft" | "claude_busy" | "claude_not_listening" | "claude_stopped" | "provider" {
  switch (code) {
    case "unavailable":
    case "recorder_missing": return "claude_setup";
    case "agent_blocked": return "claude_blocked";
    case "input_draft": return "claude_draft";
    case "busy": return "claude_busy";
    case "not_listening": return "claude_not_listening";
    case "stopped": return "claude_stopped";
    default: return "provider";
  }
}
