import { useCallback, useEffect, useRef, useState } from "react";

import type { VpsNotification, VpsNotificationFolders, VpsNotificationLevel, VpsNotifications } from "../../shared/vps.ts";
import type { Translate } from "./i18n.ts";
import { VpsError, vpsRefusal } from "./vps.ts";

/**
 * Notifications (components/VpsNotifications.tsx): the reports the server's `cabinet` program
 * writes (the 12:00 a.m. run, folders moved later, a health message), the number of them not
 * looked at yet, and the words for when each was written. Server side: server/vps-notifications.ts.
 * Not the alerts of lib/notifications.ts, which are this device's own pop-ups about panes.
 */

/** how often the open app asks while the page is visible; a hidden page asks nothing */
export const NOTIFICATIONS_POLL_MS = 60_000;

/** What the number on the button reads: nothing at zero, "9+" above nine. */
export function badgeText(unread: number): string | null {
  if (!Number.isFinite(unread) || unread < 1) return null;
  return unread > 9 ? "9+" : String(Math.floor(unread));
}

/** The calendar day a moment falls on in a time zone (the device's own when none is named), as a day count. */
function dayNumber(ms: number, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(ms);
  const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
}

/**
 * When a report was written, as one reads it the morning after: "Today 12:01 AM",
 * "Yesterday 2:43 AM", then the date ("Nov 10, 2:43 AM"), with its year once that is not this
 * one. `ts` is unix seconds. The day is the calendar day on this device, in its own time zone;
 * `timeZone` is for the tests.
 */
export function whenLabel(ts: number, now: number, locale: string, t: Translate, timeZone?: string): string {
  const ms = ts * 1000;
  if (!Number.isFinite(ms)) return "";
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(ms);
  const days = dayNumber(now, timeZone) - dayNumber(ms, timeZone);
  if (days === 0) return t("Today {time}", { time });
  if (days === 1) return t("Yesterday {time}", { time });
  const year = (moment: number): string => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(moment);
  return new Intl.DateTimeFormat(locale, { timeZone, ...(year(ms) === year(now) ? {} : { year: "numeric" }), month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(ms);
}

/** The level in a word, for the mark's name and beside the time of one that needs a look. */
export function levelWord(level: VpsNotificationLevel, t: Translate): string {
  switch (level) {
    case "ok": return t("OK");
    case "warning": return t("Warning");
    case "critical": return t("Critical");
    default: return t("Info");
  }
}

/** The button's name: what it opens, and how many are new. */
export function inboxLabel(unread: number, t: Translate): string {
  if (unread < 1) return t("Notifications");
  return unread === 1 ? t("Notifications: 1 new") : t("Notifications: {count} new", { count: unread });
}

/** Whether a report was written after the list was last opened. */
export function isUnread(item: Pick<VpsNotification, "ts">, readTs: number): boolean {
  return item.ts > readTs;
}

export interface FolderGroup {
  id: "moved" | "returned" | "waiting";
  folders: VpsNotificationFolders;
}

/** The lists of folders a report can be opened to show, in the order they are read; empty when it names none. */
export function folderGroups(item: Pick<VpsNotification, "moved" | "returned" | "waiting">): FolderGroup[] {
  const groups: FolderGroup[] = [];
  if (item.moved && item.moved.items.length > 0) groups.push({ id: "moved", folders: item.moved });
  if (item.returned && item.returned.items.length > 0) groups.push({ id: "returned", folders: item.returned });
  if (item.waiting && item.waiting.items.length > 0) groups.push({ id: "waiting", folders: item.waiting });
  return groups;
}

/** How many folders a report's details name, over all its lists. */
export function folderTotal(groups: readonly FolderGroup[]): number {
  return groups.reduce((sum, group) => sum + Math.max(group.folders.total, group.folders.items.length), 0);
}

interface Answer {
  etag: string | null;
  body: VpsNotifications;
}

/** The list; an answer the page already holds comes back as a 304 without a body, and is that answer. */
async function fetchNotifications(known: Answer | null): Promise<Answer> {
  const response = await fetch("/api/vps/notifications", { cache: "no-store", ...(known?.etag ? { headers: { "if-none-match": known.etag } } : {}) });
  if (response.status === 304 && known) return known;
  if (!response.ok) throw await vpsRefusal(response);
  return { etag: response.headers.get("etag"), body: (await response.json()) as VpsNotifications };
}

/** Marks everything in the feed read. Carries nothing: the server decides what "everything" is. */
async function postRead(): Promise<Answer> {
  const response = await fetch("/api/vps/notifications/read", { method: "POST", headers: { "content-type": "application/json", "x-herdr-vps": "1" }, body: "{}" });
  if (!response.ok) throw await vpsRefusal(response);
  return { etag: response.headers.get("etag"), body: (await response.json()) as VpsNotifications };
}

export interface VpsInbox {
  /** null until the first answer, and for good where the server offers no notifications */
  data: VpsNotifications | null;
  /** the server has a cabinet and this device may read its reports: the button is drawn */
  available: boolean;
  unread: number;
  refresh(): void;
  /** Everything in the list is read, here and on every other device at its next ask. */
  markRead(): void;
}

/**
 * The reports and their unread number. Asked for when the app opens, about once a minute while
 * the page is visible and when it becomes visible again; a hidden page asks nothing. The number
 * is the server's, so it is the same on every device. A server without notifications (an older
 * build, no VPS status, the demo) or a device that can only watch is asked once and never again.
 */
export function useVpsNotifications(enabled: boolean): VpsInbox {
  const [data, setData] = useState<VpsNotifications | null>(null);
  const [gone, setGone] = useState(false);
  const known = useRef<Answer | null>(null);
  const inFlight = useRef(false);
  /** counts the answers adopted: one that comes back after a newer one was adopted is dropped */
  const turn = useRef(0);

  const adopt = useCallback((answer: Answer) => {
    turn.current += 1;
    known.current = answer;
    setData(answer.body);
  }, []);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    const asked = turn.current;
    fetchNotifications(known.current)
      .then((answer) => { if (turn.current === asked && answer !== known.current) adopt(answer); })
      .catch((reason: unknown) => {
        if (reason instanceof VpsError && (reason.status === 404 || reason.status === 403)) { setGone(true); setData(null); }
        // anything else (the network, a restart): the last answer stands until the next ask
      })
      .finally(() => { inFlight.current = false; });
  }, [adopt]);

  const marking = useRef(false);
  const markRead = useCallback(() => {
    if (marking.current) return;
    marking.current = true;
    postRead()
      .then(adopt)
      .catch(() => { /* not marked: the number stays, and the next opening tries again */ })
      .finally(() => { marking.current = false; });
  }, [adopt]);

  useEffect(() => {
    if (!enabled || gone) return;
    const ask = (): void => { if (document.visibilityState === "visible") refresh(); };
    ask();
    const timer = window.setInterval(ask, NOTIFICATIONS_POLL_MS);
    document.addEventListener("visibilitychange", ask);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", ask);
    };
  }, [enabled, gone, refresh]);

  return { data, available: data?.available === true, unread: data?.unread ?? 0, refresh, markRead };
}
