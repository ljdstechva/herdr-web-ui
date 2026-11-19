/**
 * Claude Code's own dictation for a Claude pane's mic (server/claude-voice.ts).
 *
 * WebSocket /api/voice/claude/stream?pane_id=<id>: the browser sends 16 kHz mono 16-bit PCM in
 * binary frames and `{"type":"finish"}` or `{"type":"cancel"}`; the server answers with
 * ClaudeVoiceEvents, ending with `final` or `error`, and closes.
 */

export const CLAUDE_VOICE_SAMPLE_RATE = 16_000;

export type ClaudeVoiceErrorCode =
  | "unavailable" // this server does not carry Claude voice
  | "recorder_missing" // ~/.local/bin/arecord is not the stand-in (scripts/claude-voice/install.sh)
  | "not_claude" // the pane runs no Claude Code
  | "agent_blocked" // a question, approval or list waits in the pane
  | "input_draft" // the message box holds text
  | "busy" // another dictation runs in this pane
  | "not_listening" // the Space did not start a recording (voice mode off in that session)
  | "stopped" // Claude Code stopped listening by itself
  | "failed";

export type ClaudeVoiceEvent =
  | { type: "listening" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; code: ClaudeVoiceErrorCode; message: string };

/**
 * GET /api/voice/claude: whether a Claude pane's mic can use Claude Code's own dictation.
 * `voice` is what ~/.claude/settings.json says (`/voice tap` writes it); a session can differ.
 */
export interface ClaudeVoiceStatus {
  available: boolean;
  recorder: boolean;
  voice: { enabled: boolean; mode: "hold" | "tap" | null };
  reason: Extract<ClaudeVoiceErrorCode, "unavailable" | "recorder_missing"> | null;
}
