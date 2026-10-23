import { useEffect, useRef, type RefObject } from "react";

/** A point of a scroll area's visible part, in CSS px from its top-left corner. */
export interface ZoomAnchor {
  x: number;
  y: number;
}

export function clampZoom(zoom: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, zoom));
}

/** Where to scroll after the content grew by `ratio`, so that what was under `anchor` stays under it. */
export function anchoredScroll(left: number, top: number, anchor: ZoomAnchor, ratio: number): { left: number; top: number } {
  return { left: Math.max(0, (left + anchor.x) * ratio - anchor.x), top: Math.max(0, (top + anchor.y) * ratio - anchor.y) };
}

/** The step of one zoom button press, and of a key press. */
export const ZOOM_STEP = 1.25;
/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 30;
/** A touch that moved further than this was a scroll, not a tap. */
const TAP_SLOP_PX = 10;

/**
 * Pinch and Ctrl+wheel zoom over a scroll area whose content is drawn at `zoom`.
 *
 * While two fingers move, the content is only scaled with a transform around the point between
 * them (no layout, no redraw); when they lift, `onZoom` gets the new zoom and the point to keep in
 * place, and the caller draws at it. One finger still scrolls as the browser does: the area's
 * `touch-action: pan-x pan-y` keeps the browser from zooming the whole page instead, which also
 * turns off its double-tap zoom: a double tap zooms to `limits.tap` around the tapped point, and
 * back to fit when already zoomed in.
 */
export function useZoomGestures(
  area: RefObject<HTMLElement | null>,
  content: RefObject<HTMLElement | null>,
  zoom: number,
  limits: { min: number; max: number; tap: number },
  onZoom: (next: number, anchor: ZoomAnchor) => void,
): void {
  // the listeners stay attached across zooms and read the latest values from here
  const latest = useRef({ zoom, limits, onZoom });
  latest.current = { zoom, limits, onZoom };

  useEffect(() => {
    const element = area.current;
    if (element === null) return;
    let pinch: { distance: number; anchor: ZoomAnchor; ratio: number } | null = null;
    // the finger down now, and the last tap, for a double tap
    let touch: { x: number; y: number; moved: boolean } | null = null;
    let lastTap: { at: number; x: number; y: number } | null = null;
    const local = (x: number, y: number): ZoomAnchor => {
      const rect = element.getBoundingClientRect();
      return { x: x - rect.left, y: y - rect.top };
    };
    const spread = (touches: TouchList) => Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY);
    const reset = () => {
      const target = content.current;
      if (target) { target.style.transform = ""; target.style.transformOrigin = ""; }
    };
    const onStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        touch = { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY, moved: false };
        return;
      }
      touch = null;
      lastTap = null;
      if (event.touches.length !== 2) return;
      const [a, b] = [event.touches[0]!, event.touches[1]!];
      const anchor = local((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      pinch = { distance: Math.max(1, spread(event.touches)), anchor, ratio: 1 };
      const target = content.current;
      // the content's own coordinates: it starts at the scroll area's top-left corner
      if (target) target.style.transformOrigin = `${element.scrollLeft + anchor.x}px ${element.scrollTop + anchor.y}px`;
    };
    const onMove = (event: TouchEvent) => {
      if (touch !== null && event.touches.length === 1 && Math.hypot(event.touches[0]!.clientX - touch.x, event.touches[0]!.clientY - touch.y) > TAP_SLOP_PX) touch.moved = true;
      if (pinch === null || event.touches.length !== 2) return;
      event.preventDefault();
      const { zoom: current, limits: { min, max } } = latest.current;
      pinch.ratio = clampZoom(current * spread(event.touches) / pinch.distance, min, max) / current;
      const target = content.current;
      if (target) target.style.transform = `scale(${pinch.ratio})`;
    };
    const onEnd = (event: TouchEvent) => {
      if (pinch === null && touch !== null && event.touches.length === 0) {
        const tap = touch;
        touch = null;
        if (tap.moved) { lastTap = null; return; }
        const previous = lastTap;
        lastTap = { at: event.timeStamp, x: tap.x, y: tap.y };
        if (previous === null || event.timeStamp - previous.at > DOUBLE_TAP_MS || Math.hypot(tap.x - previous.x, tap.y - previous.y) > DOUBLE_TAP_PX) return;
        lastTap = null;
        // the second tap's click would land on what is under it (a cell, a link) as well
        event.preventDefault();
        const { zoom: current, limits: { tap: target }, onZoom: commit } = latest.current;
        commit(current > 1.05 ? 1 : target, local(tap.x, tap.y));
        return;
      }
      if (pinch === null || event.touches.length >= 2) return;
      const { anchor, ratio } = pinch;
      pinch = null;
      reset();
      if (Math.abs(ratio - 1) > 0.01) latest.current.onZoom(latest.current.zoom * ratio, anchor);
    };
    const onWheel = (event: WheelEvent) => {
      // a trackpad's pinch arrives as a wheel with ctrlKey; a mouse wheel scrolls unless Ctrl/⌘ is held
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const { zoom: current, limits: { min, max }, onZoom: commit } = latest.current;
      const next = clampZoom(current * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.002)), min, max);
      if (next !== current) commit(next, local(event.clientX, event.clientY));
    };
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd);
    element.addEventListener("touchcancel", onEnd);
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onEnd);
      element.removeEventListener("wheel", onWheel);
      reset();
    };
  }, [area, content]);
}
