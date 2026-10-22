/**
 * Agent presets: extra choices for New workspace that start one of herdr's agent kinds with
 * arguments of their own, read from `agent-presets.json` in the state directory:
 *
 *   [{ "kind": "claude-gpt", "label": "Claude Code (GPT)", "agent": "claude",
 *      "args": ["--settings", "/home/me/.local/share/ccr-home/claude-gpt.settings.json"] }]
 *
 * The client lists a preset like any kind and sends its `kind` back; the server starts `agent`
 * with `args` (before any the client sent). herdr then detects the agent as `agent`, so the pane
 * is that agent's everywhere else (chat, cards, transcripts). The file is the owner's own: an
 * entry that does not check out is skipped, never half used, and the file is read on each use,
 * so an edit takes effect without a restart.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind } from "../shared/protocol.ts";

export interface AgentPreset {
  kind: string;
  label: string;
  agent: string;
  args: string[];
}

const KIND = /^[a-z][a-z0-9-]{1,31}$/;
const MAX_PRESETS = 16;
const MAX_ARGS = 16;
const MAX_ARG = 1024;

/** The valid presets in `stateDir/agent-presets.json`; none when the file is absent or unreadable. */
export function loadAgentPresets(stateDir: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): AgentPreset[] {
  let parsed: unknown;
  try { parsed = JSON.parse(read(join(stateDir, "agent-presets.json"))); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const presets: AgentPreset[] = [];
  for (const entry of parsed.slice(0, MAX_PRESETS)) {
    if (entry === null || typeof entry !== "object") continue;
    const { kind, label, agent, args } = entry as Record<string, unknown>;
    if (typeof kind !== "string" || !KIND.test(kind) || typeof agent !== "string" || !KIND.test(agent) || kind === agent) continue;
    if (typeof label !== "string" || label.trim() === "" || label.length > 60) continue;
    if (!Array.isArray(args) || args.length > MAX_ARGS || !args.every((arg) => typeof arg === "string" && arg.length <= MAX_ARG && !arg.includes("\0"))) continue;
    if (presets.some((preset) => preset.kind === kind)) continue;
    presets.push({ kind, label: label.trim(), agent, args: [...args] });
  }
  return presets;
}

/** The list New workspace offers: herdr's kinds, then each preset whose agent is among them and whose kind is not. */
export function withPresets(kinds: AgentKind[], presets: AgentPreset[]): AgentKind[] {
  const known = new Set(kinds.map((kind) => kind.kind));
  const extra = presets.filter((preset) => known.has(preset.agent) && !known.has(preset.kind)).map((preset) => ({ kind: preset.kind, label: preset.label, mark: preset.agent }));
  return [...kinds, ...extra].sort((left, right) => left.label.localeCompare(right.label) || left.kind.localeCompare(right.kind));
}

/** What to start for a requested kind and arguments: a preset's agent with its arguments first, else as asked. */
export function resolvePreset(kind: string, args: string[] | undefined, presets: AgentPreset[]): { kind: string; args: string[] | undefined } {
  const preset = presets.find((candidate) => candidate.kind === kind);
  return preset ? { kind: preset.agent, args: [...preset.args, ...(args ?? [])] } : { kind, args };
}
