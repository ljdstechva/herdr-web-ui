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

/** How an image of `natural` size is drawn to fit `room` at zoom 1: whole, and never past its own pixels. */
export function imageFit(natural: { width: number; height: number }, room: { width: number; height: number }): number {
  if (natural.width <= 0 || natural.height <= 0 || room.width <= 0 || room.height <= 0) return 1;
  return Math.min(1, room.width / natural.width, room.height / natural.height);
}

/** How far an image fitted at `fit` zooms: four times, or until each of its pixels is two of the screen's (at most ten times). */
export function imageZoomMax(fit: number): number {
  return Math.min(10, Math.max(4, 2 / fit));
}

/** The point of an image under `anchor` (a point of the view at this scroll), as a part of the image's width and height. */
export function imagePoint(image: { left: number; top: number; width: number; height: number }, left: number, top: number, anchor: ZoomAnchor): ZoomAnchor {
  return { x: (left + anchor.x - image.left) / Math.max(1, image.width), y: (top + anchor.y - image.top) / Math.max(1, image.height) };
}

/** Where to scroll so that `point` of the image (laid out anew at `image`) is under `anchor` again. */
export function scrollToPoint(image: { left: number; top: number; width: number; height: number }, point: ZoomAnchor, anchor: ZoomAnchor): { left: number; top: number } {
  return { left: Math.max(0, image.left + point.x * image.width - anchor.x), top: Math.max(0, image.top + point.y * image.height - anchor.y) };
}

/** A flicked image glides on and slows as a phone's own scroll does: its speed halves about every 225 ms. */
const GLIDE_MS = 325;

/** How far something moving at `speed` (px/ms) glides in the next `ms`, and how fast it then goes. */
export function glide(speed: number, ms: number): { speed: number; distance: number } {
  const factor = Math.exp(-ms / GLIDE_MS);
  return { speed: speed * factor, distance: speed * GLIDE_MS * (1 - factor) };
}

/** A finger's speed (px/ms) as it lifts at `now`, from where it was over the last 100 ms; one that rested first has none. */
export function flickSpeed(trail: { at: number; x: number; y: number }[], now: number): ZoomAnchor {
  const recent = trail.filter((point) => now - point.at <= 100);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (first === undefined || last === undefined || now - last.at > 50 || last.at - first.at < 1) return { x: 0, y: 0 };
  return { x: (last.x - first.x) / (last.at - first.at), y: (last.y - first.y) / (last.at - first.at) };
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
