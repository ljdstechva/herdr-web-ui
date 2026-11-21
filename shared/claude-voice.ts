/**
 * Claude Code's own dictation for a Claude pane's mic (server/claude-voice.ts).
 *
 * WebSocket /api/voice/claude/stream?pane_id=<id>: the browser sends 16 kHz mono 16-bit PCM in
 * binary frames, and as text frames `{"type":"options",…}` (ClaudeVoiceOptions, before the first
 * audio; a server that predates it ignores the frame), `{"type":"finish"}` or `{"type":"cancel"}`.
 * The server answers with ClaudeVoiceEvents and closes: after `error`, after a `final` that
 * promises no rebuild, or after the `polished` that follows a `final` with `polish: true`.
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

/**
 * What the browser asks of a take. `polish`: after the words, their rebuilt form (the pauses'
 * commas and full stops joined back into sentences, misheard terms set right), made by Claude
 * Code's own headless mode on the server. `keywords`: names that may have been said (the agent,
 * its commands), for that rebuild; at most CLAUDE_VOICE_KEYWORDS_MAX are read.
 */
export interface ClaudeVoiceOptions {
  polish?: boolean;
  keywords?: string[];
}

export const CLAUDE_VOICE_KEYWORDS_MAX = 50;
export const CLAUDE_VOICE_KEYWORD_MAX_CHARS = 80;

export type ClaudeVoiceEvent =
  | { type: "listening" }
  | { type: "partial"; text: string }
  /** the words as Claude Code heard them. `polish`: a `polished` event follows, the connection stays open for it */
  | { type: "final"; text: string; polish?: boolean }
  /** the rebuilt words; the same text as `final` when the rebuild failed or changed nothing */
  | { type: "polished"; text: string }
  | { type: "error"; code: ClaudeVoiceErrorCode; message: string };

/**
 * GET /api/voice/claude: whether a Claude pane's mic can use Claude Code's own dictation.
 * `voice` is what ~/.claude/settings.json says (`/voice tap` writes it); a session can differ.
 * `rebuild`: this server can rebuild the words after a dictation (absent on a server before it).
 */
export interface ClaudeVoiceStatus {
  available: boolean;
  recorder: boolean;
  voice: { enabled: boolean; mode: "hold" | "tap" | null };
  rebuild?: boolean;
  reason: Extract<ClaudeVoiceErrorCode, "unavailable" | "recorder_missing"> | null;
}
