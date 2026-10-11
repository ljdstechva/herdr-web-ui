/*
 * A touch screen's tabs follow the finger: a sideways stroke over the pane opens the tab beside
 * the open one, as a tap on its name in the strip does. The pane moves a little with the finger
 * and the name of the tab it is going to stands at the edge it comes from, so the stroke says
 * what it will do before the finger lifts; let go short of TAB_SWIPE_PX and nothing changes.
 *
 * The stroke is the tabs' only when nothing under it wants it: a mostly vertical one scrolls the
 * transcript or the terminal as before, one that starts at the screen's edge is the drawer's
 * (lib/edgeSwipe.ts) or the system's Back, and one over a text field, a selection, a divider or
 * the key bar stays with that. So does one over anything that can still scroll the way the
 * finger asks (a code block, a table, the strip's own overflow, a grid panned at another
 * screen's size): it scrolls. Once that is at its end, a stroke the same way is the tabs' again,
 * as scrolling passes from an inner list to the page.
 */
import { EDGE_PX } from "./edgeSwipe.ts";

/** How far a finger travels sideways before letting go opens the tab beside. */
export const TAB_SWIPE_PX = 64;
/** A quick stroke opens it from this far already. */
export const TAB_FLICK_PX = 28;
/** ...when it averaged at least this many pixels a millisecond. */
export const TAB_FLICK_SPEED = 0.45;
/** Movement below this is not a direction yet. */
const SLOP_PX = 10;
/** How much of the finger's travel the pane follows toward a tab, and where there is none that way. */
const FOLLOW = 0.4;
const RESIST = 0.12;

export type TabStroke = "pending" | "sideways" | "other";

/** What a stroke that has moved (dx, dy) is: sideways only when clearly more across than along. */
export function tabStroke(dx: number, dy: number): TabStroke {
  if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return "pending";
  return Math.abs(dx) > Math.abs(dy) * 1.5 ? "sideways" : "other";
}

/**
 * The tab a stroke opens when the finger lifts: 1 the one after (the finger went left, as a
 * page is turned), -1 the one before, 0 neither.
 */
export function tabSwipeStep(dx: number, elapsedMs: number): -1 | 0 | 1 {
  const far = Math.abs(dx) >= TAB_SWIPE_PX;
  const flicked = Math.abs(dx) >= TAB_FLICK_PX && elapsedMs > 0 && Math.abs(dx) / elapsedMs >= TAB_FLICK_SPEED;
  if (!far && !flicked) return 0;
  return dx < 0 ? 1 : -1;
}

/** How far the pane is drawn from its place for a finger `dx` from where it came down. */
export function tabSwipeOffset(dx: number, hasTab: boolean): number {
  return Math.round(dx * (hasTab ? FOLLOW : RESIST));
}

/** A dialog, the palette or a sheet is up: a stroke there is theirs. */
const MODAL = "[aria-modal='true'], dialog[open]";
/** Things a finger drags for their own sake. */
const DRAGGED = "[role='separator'], [role='slider'], input, textarea, select, [contenteditable='true'], .key-bar, .terminal-viewport-tools, .voice-pill, .voice-mic";

/** What lies between the finger and the surface and scrolls sideways. */
function sidewaysScrollers(target: EventTarget | null, surface: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (let node = target as HTMLElement | null; node && node !== surface.parentElement; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth + 1) continue;
    const overflow = getComputedStyle(node).overflowX;
    if (overflow === "auto" || overflow === "scroll") found.push(node);
  }
  return found;
}

/**
 * Can a box `width` wide, scrolled `left` of `full`, still move for a finger going `dx`? A finger
 * going left asks for what lies to the right, and the other way round.
 */
export function scrollsFor(dx: number, left: number, width: number, full: number): boolean {
  return dx < 0 ? left + width < full - 1 : left > 0;
}

function selecting(): boolean {
  const selection = document.getSelection?.() ?? null;
  return selection !== null && !selection.isCollapsed;
}

export interface TabSwipeOptions {
  /** false while the tabs are not the finger's to move: the drawer is open, there is no strip */
  enabled: () => boolean;
  /** the name of the tab that way, or null at the row's end */
  beside: (step: -1 | 1) => string | null;
  /** opens it */
  open: (step: -1 | 1) => void;
}

/**
 * Follows strokes on `surface` (the pane's column) and moves `host`'s canvas with them. The
 * hint is one element this keeps in `host`, drawn by TabStrip.css from the attributes set here:
 * nothing is rendered per move, so the pane keeps up with the finger. Returns the cleanup.
 */
export function watchTabSwipe(surface: HTMLElement, host: HTMLElement, options: TabSwipeOptions): () => void {
  let start: { x: number; y: number; at: number; scrollers: HTMLElement[] } | null = null;
  let tracking = false;
  let hint: HTMLElement | null = null;
  let settle = 0;

  const draw = (dx: number): void => {
    const step: -1 | 1 = dx < 0 ? 1 : -1;
    const name = options.beside(step);
    host.dataset["tabSwipe"] = name === null ? "end" : Math.abs(dx) >= TAB_SWIPE_PX ? "armed" : "tracking";
    host.style.setProperty("--tab-swipe-x", `${tabSwipeOffset(dx, name !== null)}px`);
    if (hint === null) {
      hint = document.createElement("div");
      hint.className = "tab-swipe-hint";
      hint.setAttribute("aria-hidden", "true");
      host.append(hint);
    }
    hint.dataset["side"] = step === 1 ? "end" : "start";
    hint.hidden = name === null;
    if (name !== null && hint.textContent !== name) hint.textContent = name;
    // how far along the stroke is, for the hint to come in with it
    host.style.setProperty("--tab-swipe-progress", String(Math.min(1, Math.abs(dx) / TAB_SWIPE_PX)));
  };

  const clear = (): void => {
    window.clearTimeout(settle);
    delete host.dataset["tabSwipe"];
    host.style.removeProperty("--tab-swipe-x");
    host.style.removeProperty("--tab-swipe-progress");
    hint?.remove();
    hint = null;
  };

  /** The pane goes back to its place, or the next tab's comes in from the side it was pulled from. */
  const finish = (step: -1 | 0 | 1): void => {
    hint?.remove();
    hint = null;
    host.style.removeProperty("--tab-swipe-progress");
    if (step === 0) {
      host.dataset["tabSwipe"] = "back";
      host.style.setProperty("--tab-swipe-x", "0px");
    } else {
      host.dataset["tabSwipe"] = step === 1 ? "enter-end" : "enter-start";
      host.style.removeProperty("--tab-swipe-x");
      options.open(step);
    }
    window.clearTimeout(settle);
    // longer than either animation (TabStrip.css): the attribute only ever outlives them
    settle = window.setTimeout(clear, 260);
  };

  const onStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    tracking = false;
    start = null;
    if (event.touches.length !== 1 || !touch || !options.enabled()) return;
    if (document.querySelector(MODAL) !== null || selecting()) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.(DRAGGED)) return;
    // the screen's edges are the drawer's and the system's Back gesture
    if (touch.clientX < EDGE_PX || touch.clientX > window.innerWidth - EDGE_PX) return;
    start = { x: touch.clientX, y: touch.clientY, at: event.timeStamp, scrollers: sidewaysScrollers(target, surface) };
  };

  const onMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (start === null || !touch) return;
    if (event.touches.length !== 1) { cancel(); return; }
    const dx = touch.clientX - start.x;
    if (!tracking) {
      // a selection begun mid-stroke is the finger's
      if (selecting()) { start = null; return; }
      const stroke = tabStroke(dx, touch.clientY - start.y);
      if (stroke === "pending") return;
      if (stroke === "other") { start = null; return; }
      // something under the finger still scrolls that way: the stroke scrolls it
      if (start.scrollers.some((node) => scrollsFor(dx, node.scrollLeft, node.clientWidth, node.scrollWidth))) { start = null; return; }
      tracking = true;
      window.clearTimeout(settle);
    }
    // the stroke is the tabs': nothing under it scrolls, and the terminal sends no wheel for it
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    draw(dx);
  };

  const onEnd = (event: TouchEvent): void => {
    const began = start;
    const wasTracking = tracking;
    start = null;
    tracking = false;
    if (!wasTracking || began === null) return;
    const touch = event.changedTouches[0];
    const dx = touch ? touch.clientX - began.x : 0;
    const step = event.type === "touchcancel" ? 0 : tabSwipeStep(dx, event.timeStamp - began.at);
    finish(step !== 0 && options.beside(step) !== null ? step : 0);
  };

  const cancel = (): void => {
    const wasTracking = tracking;
    start = null;
    tracking = false;
    if (wasTracking) finish(0);
  };

  surface.addEventListener("touchstart", onStart, { capture: true, passive: true });
  surface.addEventListener("touchmove", onMove, { capture: true, passive: false });
  surface.addEventListener("touchend", onEnd, { capture: true, passive: true });
  surface.addEventListener("touchcancel", onEnd, { capture: true, passive: true });
  return () => {
    surface.removeEventListener("touchstart", onStart, { capture: true });
    surface.removeEventListener("touchmove", onMove, { capture: true });
    surface.removeEventListener("touchend", onEnd, { capture: true });
    surface.removeEventListener("touchcancel", onEnd, { capture: true });
    clear();
  };
}
