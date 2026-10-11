/**
 * The command that opens an agent's own model or reasoning picker from the chat (Composer.tsx's
 * model label), or null for an agent the chat cannot answer a picker for. The picker comes back as
 * a prompt card, and the server answers it for this session only (server/prompt.ts: Claude Code's
 * `/model` list and `/effort` slider, Codex's `/model` lists, never the key that saves a default).
 * Codex picks its level inside the `/model` lists, so its level opens the same lists.
 */
export type PickerKind = "model" | "effort";

export function pickerCommand(agent: string | null | undefined, kind: PickerKind): string | null {
  if (agent === "claude") return kind === "model" ? "/model" : "/effort";
  if (agent === "codex") return "/model";
  return null;
}

/** Only an agent at rest takes the command: working, it would queue it; asking, a card is already up. */
export function pickerReady(status: string | null | undefined): boolean {
  return status !== "working" && status !== "blocked";
}
