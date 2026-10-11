/**
 * Codex's Fast mode (its `priority` service tier), as the chat's model label shows and toggles it.
 *
 * Codex has no command for it: Fast mode is the keymap action `tui.keymap.global.toggle_fast_mode`
 * ("Turn Fast mode on or off."), which ships unbound (Codex 0.162). The chat can therefore toggle
 * it only on a PC whose Codex config binds that action to a key, which is the key sent here; `/keymap`
 * in Codex binds one. Whether it is on is read, not remembered: from the session's own record
 * (conversation-metadata.ts, `thread_settings_applied`) and, since a session has no record before
 * its first turn, from the status line Codex draws under its input box (`GPT-6-Astra max fast · …`).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The tiers Codex records for Fast mode: its config says `fast`, its session record `priority`. */
export function isFastTier(tier: unknown): boolean {
  return tier === "priority" || tier === "fast";
}

const EFFORT = "none|minimal|low|medium|high|xhigh|max|ultra";
/** the status line's first item: the model, its reasoning level, and `fast` while Fast mode is on */
const STATUS_RE = new RegExp(`^\\s*\\S+ (?:${EFFORT})( fast)?(?:\\s+·|\\s*…?\\s*$)`, "i");
/** How many of the screen's last lines may hold the status line (the input box, the line, a hint row). */
const STATUS_LINES = 8;

/**
 * Whether Fast mode is on, by the status line under Codex's input box: true or false when that
 * line is on the screen as Codex draws it by default, null when it is not (a picker over it, a
 * status line the user configured otherwise): then the screen says nothing either way.
 */
export function codexFastOnScreen(screen: string): boolean | null {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/, "")).filter((line) => line !== "");
  for (const line of lines.slice(-STATUS_LINES).reverse()) {
    const status = STATUS_RE.exec(line);
    if (status !== null) return status[1] !== undefined;
  }
  return null;
}

const MODIFIERS = new Set(["ctrl", "alt", "shift"]);
const PLAIN_KEY = /^(?:f(?:[1-9]|1[0-2])|[a-z0-9])$/;

/**
 * A key as herdr's `pane.send_keys` names it, from one as Codex's keymap writes it (`f9`,
 * `ctrl-t`, `alt-shift-f`): null for a chord of two keys or a key this does not vouch for.
 */
export function herdrKeyFor(binding: string): string | null {
  const parts = binding.trim().toLowerCase().split("-");
  const key = parts.pop() ?? "";
  if (!PLAIN_KEY.test(key) || !parts.every((part) => MODIFIERS.has(part)) || new Set(parts).size !== parts.length) return null;
  return [...parts, key].join("+");
}

/** The first key Codex's config binds to its Fast mode toggle, as written there; null when it binds none. */
export function codexFastBinding(configToml: string): string | null {
  let config: unknown;
  try { config = Bun.TOML.parse(configToml); } catch { return null; }
  let value: unknown = config;
  for (const name of ["tui", "keymap", "global", "toggle_fast_mode"]) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    value = (value as Record<string, unknown>)[name];
  }
  const first = Array.isArray(value) ? value.find((item) => typeof item === "string" && herdrKeyFor(item) !== null) : value;
  return typeof first === "string" && first.trim() !== "" ? first.trim() : null;
}

/** The key to send for the toggle on this PC, as herdr names it; null when Codex binds none it can send. */
export async function codexFastKey(codexHome: string): Promise<string | null> {
  const text = await readFile(join(codexHome, "config.toml"), "utf8").catch(() => null);
  const binding = text === null ? null : codexFastBinding(text);
  return binding === null ? null : herdrKeyFor(binding);
}
