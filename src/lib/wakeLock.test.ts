import { describe, expect, it } from "bun:test";
import { holdScreenWakeLock, keepAwakeWhileActive, SCREEN_AWAKE_IDLE_MS } from "./wakeLock.ts";

function pendingLock() {
  let resolve!: (lock: WakeLockSentinel) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<WakeLockSentinel>((yes, no) => { resolve = yes; reject = no; });
  const requested: WakeLockType[] = [];
  let releases = 0;
  const sentinel = { release: async () => { releases++; } } as unknown as WakeLockSentinel;
  const stop = holdScreenWakeLock({ request: (type = "screen") => { requested.push(type); return promise; } });
  return { stop, resolve: () => resolve(sentinel), reject, requested, releases: () => releases };
}

describe("screen wake lock", () => {
  it("releases an acquired screen lock when viewing ends", async () => {
    const lock = pendingLock();
    expect(lock.requested).toEqual(["screen"]);
    lock.resolve();
    await Promise.resolve();
    expect(lock.releases()).toBe(0);
    lock.stop();
    lock.stop();
    expect(lock.releases()).toBe(1);
  });

  it("releases a late request after disabling or hiding the pane", async () => {
    const lock = pendingLock();
    lock.stop();
    lock.resolve();
    await Promise.resolve();
    expect(lock.releases()).toBe(1);
  });

  it("a late old request cannot release the replacement lock on return", async () => {
    const old = pendingLock();
    old.stop();
    const current = pendingLock();
    current.resolve();
    old.resolve();
    await Promise.resolve();
    expect(old.releases()).toBe(1);
    expect(current.releases()).toBe(0);
    current.stop();
    expect(current.releases()).toBe(1);
  });

  it("accepts browser refusal without retrying in a loop", async () => {
    const lock = pendingLock();
    lock.reject(new Error("NotAllowedError"));
    await Promise.resolve();
    await Promise.resolve();
    lock.stop();
    expect(lock.requested).toEqual(["screen"]);
    expect(lock.releases()).toBe(0);
  });
});

/** A wake lock whose requests resolve at once with sentinels the test can drop the way a browser does. */
function fakeWakeLock() {
  const held: { released: boolean; drop: () => void }[] = [];
  let requests = 0;
  let refuse = false;
  const wakeLock = {
    request: async () => {
      requests++;
      if (refuse) throw new Error("NotAllowedError");
      const target = new EventTarget();
      const entry = { released: false, drop: () => { entry.released = true; target.dispatchEvent(new Event("release")); } };
      held.push(entry);
      return Object.assign(target, { release: async () => { entry.released = true; } }) as unknown as WakeLockSentinel;
    },
  };
  return { wakeLock, held: () => held.filter((entry) => !entry.released).length, requests: () => requests, refuse: (value: boolean) => { refuse = value; }, drop: () => held.find((entry) => !entry.released)?.drop() };
}

/** A clock and a timer queue the test moves by hand. */
function fakeTime() {
  let now = 0;
  let timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    schedule: (run: () => void, ms: number) => { const timer = { at: now + ms, run }; timers.push(timer); return () => { timers = timers.filter((other) => other !== timer); }; },
    pending: () => timers.length,
    advance: (ms: number) => {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((timer) => timer !== next);
        now = next.at;
        next.run();
      }
      now = end;
    },
  };
}

const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

describe("screen kept on while the app is used", () => {
  it("holds the screen from the start, lets it go 5 minutes after the last activity, and holds it again at the next touch", async () => {
    const lock = fakeWakeLock(); const time = fakeTime(); const target = new EventTarget();
    const stop = keepAwakeWhileActive({ wakeLock: lock.wakeLock, target, idleMs: SCREEN_AWAKE_IDLE_MS, now: time.now, schedule: time.schedule });
    await settle();
    expect(lock.held()).toBe(1);
    // a touch at 4 minutes moves the end to 9 minutes; a scroll inside a box counts as well
    time.advance(4 * 60_000);
    target.dispatchEvent(new Event("pointerdown"));
    time.advance(4 * 60_000);
    target.dispatchEvent(new Event("scroll"));
    expect(time.pending()).toBe(1);
    time.advance(4 * 60_000 + 59_000);
    expect(lock.held()).toBe(1);
    time.advance(1_000);
    expect(lock.held()).toBe(0);
    expect(time.pending()).toBe(0);
    // the phone's own timeout has it now; a touch holds it again, with one request, not one per event
    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("input"));
    await settle();
    expect(lock.held()).toBe(1);
    expect(lock.requests()).toBe(2);
    stop();
    await settle();
    expect(lock.held()).toBe(0);
    expect(time.pending()).toBe(0);
    // nothing listens after stop
    target.dispatchEvent(new Event("pointerdown"));
    await settle();
    expect(lock.requests()).toBe(2);
  });

  it("asks again at the next touch for a lock the browser dropped or refused, never in a loop", async () => {
    const lock = fakeWakeLock(); const time = fakeTime(); const target = new EventTarget();
    const stop = keepAwakeWhileActive({ wakeLock: lock.wakeLock, target, idleMs: SCREEN_AWAKE_IDLE_MS, now: time.now, schedule: time.schedule });
    await settle();
    lock.drop();
    await settle();
    expect(lock.held()).toBe(0);
    expect(lock.requests()).toBe(1);
    lock.refuse(true);
    target.dispatchEvent(new Event("keydown"));
    await settle();
    expect(lock.requests()).toBe(2);
    expect(lock.held()).toBe(0);
    lock.refuse(false);
    target.dispatchEvent(new Event("touchmove"));
    await settle();
    expect(lock.requests()).toBe(3);
    expect(lock.held()).toBe(1);
    stop();
  });

  it("holds the screen for as long as it runs when no idle limit is set", async () => {
    const lock = fakeWakeLock(); const time = fakeTime(); const target = new EventTarget();
    const stop = keepAwakeWhileActive({ wakeLock: lock.wakeLock, target, idleMs: Number.POSITIVE_INFINITY, now: time.now, schedule: time.schedule });
    await settle();
    expect(time.pending()).toBe(0);
    time.advance(3 * 60 * 60_000);
    expect(lock.held()).toBe(1);
    stop();
    await settle();
    expect(lock.held()).toBe(0);
  });
});
