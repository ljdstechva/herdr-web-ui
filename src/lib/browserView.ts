/**
 * Browser view, the parts without a DOM: the /api/browsers calls, what a touch on the remote
 * screen means, and what typing into the phone's keyboard sends. components/BrowserView.tsx
 * draws it; shared/browser-view.ts has the routes.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { BrowserInfo, BrowserLayoutRequest, BrowserList } from "../../shared/browser-view.ts";

/** how often the open app asks whether a browser is open, and how often the open view does */
const POLL_MS = 15_000;
const POLL_OPEN_MS = 3_000;

export class BrowserViewError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) {
    super(message);
    this.name = "BrowserViewError";
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let code: string | null = null;
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? null;
      message = body.error?.message ?? message;
    } catch {
      /* not the JSON envelope */
    }
    throw new BrowserViewError(response.status, code, message);
  }
  return (await response.json()) as T;
}

export const fetchBrowsers = async (): Promise<BrowserInfo[]> => (await call<BrowserList>("/api/browsers")).browsers;

export const setBrowserLayout = (id: string, request: BrowserLayoutRequest): Promise<BrowserInfo> =>
  call(`/api/browsers/${encodeURIComponent(id)}/layout`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-browser": "1" }, body: JSON.stringify(request) });

export function browserStreamUrl(id: string, location: Pick<Location, "protocol" | "host"> = window.location): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/browsers/${encodeURIComponent(id)}/stream`;
}

/**
 * The browsers open on the server, asked again every few seconds while the app is in view.
 * `unavailable` is for good: the server cannot offer the view (404), or this device may only
 * watch (403).
 */
export function useBrowsers(open: boolean): { browsers: BrowserInfo[]; unavailable: boolean; refresh: () => void } {
  const [browsers, setBrowsers] = useState<BrowserInfo[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    fetchBrowsers()
      .then(setBrowsers)
      .catch((reason: unknown) => {
        if (reason instanceof BrowserViewError && (reason.status === 404 || reason.status === 403)) setUnavailable(true);
        // any other failure (the server restarting) keeps the last answer: the next ask corrects it
      })
      .finally(() => { inFlight.current = false; });
  }, []);

  useEffect(() => {
    if (unavailable) return;
    refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, open ? POLL_OPEN_MS : POLL_MS);
    const onVisible = (): void => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, unavailable, open]);

  return { browsers, unavailable, refresh };
}

// ---------------------------------------------------------------------------------------------
// touch

export type PointerButton = "left" | "right";

export type PointerAction =
  | { type: "move"; x: number; y: number }
  | { type: "down" | "up"; x: number; y: number; button: PointerButton }
  /** wheel notches at a point: `dy` 1 scrolls the page down, `dx` 1 scrolls it right */
  | { type: "scroll"; x: number; y: number; dx: number; dy: number };

/** a finger held this long without moving is a right click */
export const HOLD_MS = 500;
/** a finger that travelled less than this has not moved */
const SLOP_PX = 10;
/** a second tap this soon and this near the first is its double click, and drags if it moves */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
/** finger travel per wheel notch: a notch scrolls Chromium about 100px, so the page runs a little ahead of the finger rather than waiting for it */
const SCROLL_STEP_PX = 72;

type TouchState =
  | { kind: "idle" }
  | { kind: "pressed"; x: number; y: number; second: boolean }
  | { kind: "scrolling"; x: number; y: number; lastX: number; lastY: number; restX: number; restY: number }
  | { kind: "dragging"; x: number; y: number }
  /** nothing more comes of this touch: its right click is sent, or more fingers joined */
  | { kind: "spent" };

/**
 * One finger on the remote screen, as mouse actions: a tap clicks, a hold right-clicks, a stroke
 * scrolls the page under it, and a tap followed by a stroke drags with the button down (a
 * slider, a selection). The caller owns the clock: it calls `hold()` when `HOLD_MS` passed
 * since `start()` and neither `end()` nor `cancel()` came.
 */
export class TouchGestures {
  private state: TouchState = { kind: "idle" };
  private lastTap: { x: number; y: number; at: number } | null = null;

  constructor(private readonly emit: (action: PointerAction) => void) {}

  /** true while a hold may still become a right click */
  get waiting(): boolean {
    return this.state.kind === "pressed" && !this.state.second;
  }

  start(x: number, y: number, fingers: number, now: number): void {
    if (this.state.kind === "dragging") this.emit({ type: "up", x: this.state.x, y: this.state.y, button: "left" });
    if (fingers !== 1) {
      this.state = { kind: "spent" };
      return;
    }
    const tap = this.lastTap;
    const near = tap !== null && now - tap.at <= DOUBLE_TAP_MS && Math.hypot(x - tap.x, y - tap.y) <= DOUBLE_TAP_PX ? tap : null;
    // the second tap lands where the first did, so the browser reads the pair as a double click
    const at = near ? { x: near.x, y: near.y } : { x, y };
    this.state = { kind: "pressed", ...at, second: near !== null };
    this.emit({ type: "move", ...at });
  }

  move(x: number, y: number): void {
    const state = this.state;
    if (state.kind === "pressed") {
      if (Math.hypot(x - state.x, y - state.y) < SLOP_PX) return;
      if (state.second) {
        this.emit({ type: "down", x: state.x, y: state.y, button: "left" });
        this.emit({ type: "move", x, y });
        this.state = { kind: "dragging", x, y };
      } else {
        this.state = { kind: "scrolling", x: state.x, y: state.y, lastX: state.x, lastY: state.y, restX: 0, restY: 0 };
        this.move(x, y);
      }
    } else if (state.kind === "scrolling") {
      // the page follows the finger: a finger going up asks for what is below
      const travelX = state.restX + (state.lastX - x);
      const travelY = state.restY + (state.lastY - y);
      const dx = Math.trunc(travelX / SCROLL_STEP_PX);
      const dy = Math.trunc(travelY / SCROLL_STEP_PX);
      this.state = { ...state, lastX: x, lastY: y, restX: travelX - dx * SCROLL_STEP_PX, restY: travelY - dy * SCROLL_STEP_PX };
      if (dx !== 0 || dy !== 0) this.emit({ type: "scroll", x: state.x, y: state.y, dx, dy });
    } else if (state.kind === "dragging") {
      this.state = { kind: "dragging", x, y };
      this.emit({ type: "move", x, y });
    }
  }

  hold(): void {
    const state = this.state;
    if (state.kind !== "pressed" || state.second) return;
    this.emit({ type: "down", x: state.x, y: state.y, button: "right" });
    this.emit({ type: "up", x: state.x, y: state.y, button: "right" });
    this.state = { kind: "spent" };
    this.lastTap = null;
  }

  end(now: number): void {
    const state = this.state;
    this.state = { kind: "idle" };
    if (state.kind === "pressed") {
      this.emit({ type: "down", x: state.x, y: state.y, button: "left" });
      this.emit({ type: "up", x: state.x, y: state.y, button: "left" });
      this.lastTap = state.second ? null : { x: state.x, y: state.y, at: now };
    } else if (state.kind === "dragging") {
      this.emit({ type: "up", x: state.x, y: state.y, button: "left" });
      this.lastTap = null;
    } else {
      this.lastTap = null;
    }
  }

  /** The touch was taken away (a system gesture): nothing is clicked, a held button is let go. */
  cancel(): void {
    if (this.state.kind === "dragging") this.emit({ type: "up", x: this.state.x, y: this.state.y, button: "left" });
    this.state = { kind: "idle" };
    this.lastTap = null;
  }
}

/** RFB pointer button bits */
export const BUTTON_MASK: Readonly<Record<PointerButton, number>> = { left: 1, right: 4 };
const WHEEL_MASK = { up: 8, down: 16, left: 32, right: 64 } as const;

/** The button masks one scroll action sends, a press and a release per notch, most at once bounded. */
export function wheelMasks(dx: number, dy: number, limit = 12): number[] {
  const masks: number[] = [];
  const add = (count: number, mask: number): void => {
    for (let index = 0; index < Math.min(Math.abs(count), limit); index += 1) masks.push(mask, 0);
  };
  add(dy, dy > 0 ? WHEEL_MASK.down : WHEEL_MASK.up);
  add(dx, dx > 0 ? WHEEL_MASK.right : WHEEL_MASK.left);
  return masks;
}

// ---------------------------------------------------------------------------------------------
// typing

/** X11 keysyms of the keys that are not text */
export const KEYSYM = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Page_Up: 0xff55,
  Page_Down: 0xff56,
  End: 0xff57,
  Delete: 0xffff,
} as const;

/** `KeyboardEvent.key` of the keys a phone keyboard (or one plugged into it) sends as keys rather than text */
export const NAMED_KEYS: Readonly<Record<string, number>> = {
  Enter: KEYSYM.Return,
  Backspace: KEYSYM.BackSpace,
  Tab: KEYSYM.Tab,
  Escape: KEYSYM.Escape,
  Delete: KEYSYM.Delete,
  Home: KEYSYM.Home,
  End: KEYSYM.End,
  PageUp: KEYSYM.Page_Up,
  PageDown: KEYSYM.Page_Down,
  ArrowLeft: KEYSYM.Left,
  ArrowUp: KEYSYM.Up,
  ArrowRight: KEYSYM.Right,
  ArrowDown: KEYSYM.Down,
};

/**
 * The text a phone's keyboard edits stands in for the remote field: it is kept filled so a
 * backspace always has something to delete (an empty field sends no event for it).
 */
export const KEYBOARD_FILL = "_".repeat(24);

/** The keysym that types one character: Latin-1 is its own, a line break is Return, the rest is X11's Unicode range. */
export function keysymOf(character: string): number {
  if (character === "\n" || character === "\r") return KEYSYM.Return;
  if (character === "\t") return KEYSYM.Tab;
  const point = character.codePointAt(0) ?? 0;
  if ((point >= 0x20 && point <= 0x7e) || (point >= 0xa0 && point <= 0xff)) return point;
  return 0x01000000 + point;
}

/**
 * What changed between two values of the keyboard's text, as the remote field has to hear it:
 * how many characters to delete from the end, then what to type. A keyboard that corrects a
 * word rewrites its tail, which is the same answer.
 */
export function typedSince(before: string, after: string): { backspaces: number; text: string[] } {
  const was = Array.from(before);
  const is = Array.from(after);
  let same = 0;
  while (same < was.length && same < is.length && was[same] === is[same]) same += 1;
  return { backspaces: was.length - same, text: is.slice(same) };
}

/** The keysyms `typedSince` comes to, in the order to press them. */
export function typedKeysyms(before: string, after: string): number[] {
  const { backspaces, text } = typedSince(before, after);
  return [...Array<number>(backspaces).fill(KEYSYM.BackSpace), ...text.map(keysymOf)];
}
