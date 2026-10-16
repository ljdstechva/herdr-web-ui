import { afterEach, describe, expect, it } from "bun:test";
import type { AgentStatus } from "../../shared/protocol.ts";
import { alertStatus, alertsAllow, dismissReadNotifications, shouldNotifyStatus } from "./notifications.ts";
import { paneNotificationTag } from "../../shared/notify-policy.ts";

describe("read system notifications", () => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  afterEach(() => {
    if (saved) Object.defineProperty(navigator, "serviceWorker", saved);
    else Reflect.deleteProperty(navigator, "serviceWorker");
  });
  function fixture(beforeList: () => Promise<void> = async () => {}) {
    const closed: string[] = [];
    const tags = [paneNotificationTag("a"), paneNotificationTag("b"), paneNotificationTag("a", "remote"), "herdr-vps-cpu", "herdr-vps-memory", "herdr-test"];
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
      getRegistration: async () => ({ getNotifications: async () => {
        await beforeList();
        return tags.map((tag) => ({ tag, close: () => closed.push(tag) }));
      } }),
    } });
    return closed;
  }
  it("closes only the opened pane on its own PC", async () => {
    const closed = fixture();
    await dismissReadNotifications({ paneId: "a", machineId: "local" }, () => true);
    expect(closed).toEqual([paneNotificationTag("a")]);
  });
  it("keeps the local pane unread when the same ID is opened on a remote PC", async () => {
    const closed = fixture();
    await dismissReadNotifications({ paneId: "a", machineId: "remote" }, () => true);
    expect(closed).toEqual([paneNotificationTag("a", "remote")]);
  });
  it("reading VPS status clears its alerts without dismissing pane or test alerts", async () => {
    const closed = fixture();
    await dismissReadNotifications("vps", () => true);
    expect(closed).toEqual(["herdr-vps-cpu", "herdr-vps-memory"]);
  });
  it("opening the app clears its generic test confirmation, preserving unread destinations", async () => {
    const closed = fixture();
    await dismissReadNotifications("app", () => true);
    expect(closed).toEqual(["herdr-test"]);
  });
  it("does not read a hidden, locked or obscured target", async () => {
    const closed = fixture();
    await dismissReadNotifications({ paneId: "a", machineId: "local" }, () => false);
    expect(closed).toEqual([]);
  });
  it("rechecks visibility/selection after an asynchronous notification lookup", async () => {
    let reading = true;
    const closed = fixture(async () => { reading = false; });
    await dismissReadNotifications({ paneId: "a", machineId: "local" }, () => reading);
    expect(closed).toEqual([]);
  });
  it("supports browsers without service workers or notification enumeration", async () => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    await dismissReadNotifications("vps", () => true);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => ({}) } });
    await dismissReadNotifications("vps", () => true);
  });
  it("surfaces browser failures to the caller", async () => {
    fixture(async () => { throw new Error("notification lookup failed"); });
    await expect(dismissReadNotifications("vps", () => true)).rejects.toThrow("notification lookup failed");
  });
});

describe("alertStatus", () => {
  it("takes a pane at rest that waits on its turn's background work for working, and leaves the rest as they are", () => {
    expect(["done", "idle", "unknown"].map((status) => alertStatus(status, true))).toEqual(["working", "working", "working"]);
    expect(alertStatus("blocked", true)).toBe("blocked");
    expect(alertStatus("done", false)).toBe("done");
    expect(alertStatus("done", undefined)).toBe("done");
    // a wait that ends with no new turn is a finish
    expect(shouldNotifyStatus(alertStatus("done", true), alertStatus("done", false))).toBe(true);
  });
});

describe("shouldNotifyStatus", () => {
  it("notifies when a known pane becomes blocked", () => {
    expect(shouldNotifyStatus("working", "blocked")).toBe(true);
  });

  it("notifies when a known pane becomes done", () => {
    expect(shouldNotifyStatus("blocked", "done")).toBe(true);
  });

  it("does not notify for the busy baseline states", () => {
    expect(shouldNotifyStatus("idle", "working")).toBe(false);
    expect(shouldNotifyStatus("working", "idle")).toBe(false);
  });

  it("does not notify when the status does not change", () => {
    expect(shouldNotifyStatus("blocked", "blocked")).toBe(false);
  });

  it("does not notify on first sight of a pane", () => {
    // the app just opened or the pane is new: not news
    expect(shouldNotifyStatus(undefined, "blocked")).toBe(false);
  });

  it("carries unknown future statuses through without notifying", () => {
    expect(shouldNotifyStatus("working", "teleporting" as AgentStatus)).toBe(false);
  });
});

describe("alertsAllow", () => {
  it("lets through what the device chose, and nothing that is not an alert", () => {
    expect(alertsAllow({ input: true, done: "off" }, "blocked")).toBe(true);
    expect(alertsAllow({ input: false, done: "always" }, "blocked")).toBe(false);
    expect(alertsAllow({ input: false, done: "long" }, "done")).toBe(true);
    expect(alertsAllow({ input: true, done: "off" }, "done")).toBe(false);
    expect(alertsAllow({ input: true, done: "always" }, "working")).toBe(false);
  });
});
