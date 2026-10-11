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

/**
 * What a tap on the model name offers. Claude Code has a picker for each, so the tap asks which
 * (a menu: the level's own label often steps out of a phone's narrow row, Composer.css
 * data-model="no-effort"); Codex has one list for both, which the tap opens at once.
 */
export function pickerChoices(agent: string | null | undefined): PickerKind[] {
  if (agent === "claude") return ["model", "effort"];
  if (agent === "codex") return ["model"];
  return [];
}

/** Only an agent at rest takes the command: working, it would queue it; asking, a card is already up. */
export function pickerReady(status: string | null | undefined): boolean {
  return status !== "working" && status !== "blocked";
}
