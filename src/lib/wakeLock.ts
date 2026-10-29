import { useEffect } from "react";
import type { ScreenAwake } from "./settings.ts";
import { usePageVisible } from "./visibility.ts";

/** How long the screen stays on after the last touch, key or scroll in "5 minutes" (Settings → Phone). */
export const SCREEN_AWAKE_IDLE_MS = 5 * 60_000;

/** What counts as using the app: a touch, a key, typing (an Android keyboard sends `input`, not always keys), a scroll anywhere. */
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "input", "wheel", "touchmove", "scroll"] as const;

/**
 * A request may finish after the pane closes or the tab hides; release that late lock too.
 * `onLost`: the browser refused the lock or let it go on its own (power saving, a system dialog),
 * never called for a release asked for here.
 */
export function holdScreenWakeLock(wakeLock: Pick<WakeLock, "request">, onLost?: () => void): () => void {
  let cancelled = false;
  let sentinel: WakeLockSentinel | null = null;
  const release = (lock: WakeLockSentinel) => { void lock.release().catch(() => undefined); };
  void wakeLock.request("screen").then((lock) => {
    if (cancelled) { release(lock); return; }
    sentinel = lock;
    lock.addEventListener?.("release", () => { if (!cancelled) { sentinel = null; onLost?.(); } });
  }).catch(() => {
    // Power saving, browser policy or permission may refuse it. The next touch asks again.
    if (!cancelled) onLost?.();
  });
  return () => {
    cancelled = true;
    if (sentinel) { release(sentinel); sentinel = null; }
  };
}

export interface KeepAwakeOptions {
  wakeLock: Pick<WakeLock, "request">;
  /** where the activity is heard (the window); listened to in the capture phase, so a scroll inside any box counts */
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  /** how long after the last activity the lock is let go; Infinity holds it for as long as this runs */
  idleMs: number;
  now: () => number;
  /** run `run` after `ms`; returns its cancel */
  schedule: (run: () => void, ms: number) => () => void;
}

/**
 * Holds the screen on from now until `idleMs` after the last activity on `target`, then lets the
 * phone's own screen timeout take over; the next activity holds it again. A lock the browser drops
 * on its own is asked for again at the next activity, never in a loop. One timer at a time: an
 * activity only moves the time the timer checks when it fires, so a scroll costs no timer work.
 */
export function keepAwakeWhileActive({ wakeLock, target, idleMs, now, schedule }: KeepAwakeOptions): () => void {
  let stopLock: (() => void) | null = null;
  let cancelTimer: (() => void) | null = null;
  let last = now();
  const hold = () => {
    const mine: () => void = holdScreenWakeLock(wakeLock, () => { if (stopLock === mine) stopLock = null; });
    stopLock = mine;
  };
  const expire = () => {
    cancelTimer = null;
    const left = last + idleMs - now();
    if (left > 0) { cancelTimer = schedule(expire, left); return; }
    stopLock?.();
    stopLock = null;
  };
  const activity = () => {
    last = now();
    if (stopLock === null) hold();
    if (cancelTimer === null && Number.isFinite(idleMs)) cancelTimer = schedule(expire, idleMs);
  };
  const options = { capture: true, passive: true } as const;
  for (const type of ACTIVITY_EVENTS) target.addEventListener(type, activity, options);
  // opening the app, or coming back to it, is using it
  activity();
  return () => {
    for (const type of ACTIVITY_EVENTS) target.removeEventListener(type, activity, options);
    cancelTimer?.();
    cancelTimer = null;
    stopLock?.();
    stopLock = null;
  };
}

/** Whether this browser can keep the screen on at all: the Screen Wake Lock API, which needs HTTPS or localhost. */
export function screenWakeLockSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && typeof navigator !== "undefined" && !!navigator.wakeLock;
}

export function useScreenWakeLock(mode: ScreenAwake, active: boolean): void {
  const visible = usePageVisible();
  useEffect(() => {
    if (mode === "off" || !active || !visible || !screenWakeLockSupported()) return;
    return keepAwakeWhileActive({
      wakeLock: navigator.wakeLock,
      target: window,
      idleMs: mode === "idle" ? SCREEN_AWAKE_IDLE_MS : Number.POSITIVE_INFINITY,
      now: Date.now,
      schedule: (run, ms) => { const id = window.setTimeout(run, ms); return () => window.clearTimeout(id); },
    });
  }, [mode, active, visible]);
}
