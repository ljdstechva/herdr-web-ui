/*
 * The workspace drawer follows a phone's finger: a swipe in from its edge opens it, as the
 * menu button does, and a swipe back toward that edge closes it again. Only at the drawer's
 * width (<=768px, styles.css) and only for a mostly horizontal stroke, so the terminal's
 * one-finger scrolling and the transcript's vertical scrolling keep working. On a phone
 * (RIGHT_DRAWER_QUERY) the drawer and its menu button sit on the right, under the thumb of
 * the hand most people hold a phone in; on a tablet they stay on the left.
 */

/** A stroke has to start this close to the drawer's edge to open it. */
export const EDGE_PX = 24;
/** How far a finger travels sideways before the drawer opens or closes. */
export const SWIPE_PX = 56;
/** Movement below this is not a direction yet. */
const SLOP_PX = 10;
/** Where the drawer comes in from the right and the app's bar sits at the bottom (styles.css "phone"). */
export const RIGHT_DRAWER_QUERY = "(max-width: 640px)";

export type SwipeVerdict = "open" | "close" | "claim" | "pending" | "ignore";
export type DrawerSide = "left" | "right";

/**
 * What a stroke from (startX) that has moved (dx, dy) means, for a drawer on `side` of a
 * screen `width` wide. "claim" is a recognised swipe still short of SWIPE_PX: the caller
 * keeps it from scrolling what lies under it.
 */
export function swipeVerdict(drawerOpen: boolean, startX: number, dx: number, dy: number, side: DrawerSide = "left", width = 0): SwipeVerdict {
  const fromEdge = side === "left" ? startX : width - startX;
  if (!drawerOpen && fromEdge > EDGE_PX) return "ignore";
  if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return "pending";
  if (Math.abs(dy) >= Math.abs(dx)) return "ignore";
  // away from the drawer's edge, toward the middle of the screen
  const inward = side === "left" ? dx : -dx;
  if (!drawerOpen && inward > 0) return inward >= SWIPE_PX ? "open" : "claim";
  if (drawerOpen && inward < 0) return -inward >= SWIPE_PX ? "close" : "claim";
  return "ignore";
}

/** A dialog, the palette or a sheet is up: a swipe there is theirs, not the drawer's under them. */
const MODAL = "[aria-modal='true'], dialog[open]";

/**
 * Something under the finger can scroll the way an opening stroke moves it, a code block or a
 * table: the stroke scrolls it. From the left that is one scrolled aside (a swipe right scrolls
 * it back); from the right, one with more to show on its right.
 */
function scrolledAside(target: EventTarget | null, side: DrawerSide = "left"): boolean {
  for (let node = target as HTMLElement | null; node; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth) continue;
    if (side === "left" ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1) return true;
  }
  return false;
}

/** A finger on a text field edits its text: a sideways stroke there moves the caret or the selection. */
function editable(target: EventTarget | null): boolean {
  for (let node = target as HTMLElement | null; node; node = node.parentElement) {
    if (node.isContentEditable === true || /^(?:INPUT|TEXTAREA|SELECT)$/.test(node.tagName ?? "")) return true;
  }
  return false;
}

/** Text is selected (the transcript's, a long press in the gutter): a stroke drags its handles. */
function selecting(): boolean {
  const selection = document.getSelection?.() ?? null;
  return selection !== null && !selection.isCollapsed;
}

/** Listens on the whole document; returns the cleanup. */
export function watchDrawerSwipe(isOpen: () => boolean, setOpen: (open: boolean) => void): () => void {
  const narrow = window.matchMedia("(max-width: 768px)");
  const phone = window.matchMedia(RIGHT_DRAWER_QUERY);
  let start: { x: number; y: number; open: boolean; side: DrawerSide; width: number } | null = null;
  // a recognised swipe owns the stroke until the finger lifts, after the drawer moved too
  let claimed = false;
  let done = false;
  const onStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    const open = isOpen();
    const side: DrawerSide = phone.matches ? "right" : "left";
    start = event.touches.length === 1 && touch && narrow.matches && document.querySelector(MODAL) === null && (open || !scrolledAside(event.target, side))
      && !editable(event.target) && !selecting()
      ? { x: touch.clientX, y: touch.clientY, open, side, width: window.innerWidth } : null;
    claimed = false;
    done = false;
  };
  const onMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (start === null || !touch) return;
    // the screen turned wide mid-stroke: there is no drawer to swipe any more
    if (!narrow.matches) { onEnd(); return; }
    // a selection begun mid-stroke is the finger's: until the drawer moved, the stroke goes back
    if (!done && selecting()) { onEnd(); return; }
    const verdict = done ? "claim" : swipeVerdict(start.open, start.x, touch.clientX - start.x, touch.clientY - start.y, start.side, start.width);
    // a stroke that was already the drawer's stays so when it comes back near where it started;
    // one that never was waits for a direction. Until the drawer moves, a stroke that turns to
    // scrolling goes back to the page, so the terminal's one-finger scroll is not held up
    if (!claimed && verdict === "pending") return;
    if (verdict === "ignore") { onEnd(); return; }
    claimed = true;
    // a recognised swipe belongs to the drawer, not to the terminal or list under the finger
    event.preventDefault();
    event.stopPropagation();
    if (!done && (verdict === "open" || verdict === "close")) {
      setOpen(verdict === "open");
      done = true;
    }
  };
  const onEnd = (): void => { start = null; claimed = false; done = false; };
  document.addEventListener("touchstart", onStart, { capture: true, passive: true });
  document.addEventListener("touchmove", onMove, { capture: true, passive: false });
  document.addEventListener("touchend", onEnd, { capture: true, passive: true });
  document.addEventListener("touchcancel", onEnd, { capture: true, passive: true });
  return () => {
    document.removeEventListener("touchstart", onStart, { capture: true });
    document.removeEventListener("touchmove", onMove, { capture: true });
    document.removeEventListener("touchend", onEnd, { capture: true });
    document.removeEventListener("touchcancel", onEnd, { capture: true });
  };
}
