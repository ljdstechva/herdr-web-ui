import { describe, expect, it } from "bun:test";

import type { VpsNotificationFolders } from "../../shared/vps.ts";
import { translate, type Translate } from "./i18n.ts";
import { badgeText, folderGroups, folderTotal, inboxLabel, isUnread, levelWord, whenLabel } from "./vpsNotifications.ts";

const en: Translate = (key, vars) => translate("en", key, vars);
const ko: Translate = (key, vars) => translate("ko", key, vars);

/** A moment on Manila's clock (UTC+8, no daylight time) as unix seconds. */
function manila(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute) / 1000;
}

/** Newer runtimes put a narrow no-break space before AM/PM: the label is compared as it reads. */
function label(ts: number, now: number, locale = "en-US", t: Translate = en, timeZone = "Asia/Manila"): string {
  return whenLabel(ts, now * 1000, locale, t, timeZone).replace(/[  ]/g, " ");
}

describe("the number on the button", () => {
  it("is not drawn at zero", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(-2)).toBeNull();
    expect(badgeText(Number.NaN)).toBeNull();
    expect(badgeText(0.4)).toBeNull();
  });

  it("is the count up to nine and 9+ above it", () => {
    expect(badgeText(1)).toBe("1");
    expect(badgeText(2)).toBe("2");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(10)).toBe("9+");
    expect(badgeText(300)).toBe("9+");
  });

  it("is said in words on the button's name", () => {
    expect(inboxLabel(0, en)).toBe("Notifications");
    expect(inboxLabel(1, en)).toBe("Notifications: 1 new");
    expect(inboxLabel(12, en)).toBe("Notifications: 12 new");
    expect(inboxLabel(3, ko)).toBe("알림함: 새 알림 3개");
  });
});

describe("when a report was written", () => {
  const now = manila(2026, 11, 12, 7, 30);

  it("reads Today and Yesterday by the calendar day, not by the hours gone", () => {
    expect(label(manila(2026, 11, 12, 0, 1), now)).toBe("Today 12:01 AM");
    expect(label(manila(2026, 11, 12, 7, 29), now)).toBe("Today 7:29 AM");
    // seven and a half hours ago, and still the day before
    expect(label(manila(2026, 11, 11, 23, 59), now)).toBe("Yesterday 11:59 PM");
    expect(label(manila(2026, 11, 11, 2, 43), now)).toBe("Yesterday 2:43 AM");
    // looked at just after midnight: the run of a minute ago is today's, last evening is yesterday
    const midnight = manila(2026, 11, 12, 0, 5);
    expect(label(manila(2026, 11, 12, 0, 1), midnight)).toBe("Today 12:01 AM");
    expect(label(manila(2026, 11, 11, 18, 0), midnight)).toBe("Yesterday 6:00 PM");
  });

  it("gives the date for anything older, with the year once it is another one", () => {
    expect(label(manila(2026, 11, 10, 2, 43), now)).toBe("Nov 10, 2:43 AM");
    expect(label(manila(2026, 1, 3, 0, 1), now)).toBe("Jan 3, 12:01 AM");
    expect(label(manila(2025, 12, 31, 0, 1), now)).toBe("Dec 31, 2025, 12:01 AM");
    // across the turn of a month and of a year
    expect(label(manila(2026, 10, 31, 23, 0), manila(2026, 11, 1, 6, 0))).toBe("Yesterday 11:00 PM");
    expect(label(manila(2025, 12, 31, 23, 0), manila(2026, 1, 1, 6, 0))).toBe("Yesterday 11:00 PM");
    // a clock that runs ahead writes a report dated tomorrow: its date, never "Today"
    expect(label(manila(2026, 11, 13, 0, 1), now)).toBe("Nov 13, 12:01 AM");
  });

  it("is the day on this device's clock: the same moment is another day in another zone", () => {
    const run = manila(2026, 11, 12, 0, 1); // 16:01 UTC on the 11th
    expect(label(run, now, "en-US", en, "Asia/Manila")).toBe("Today 12:01 AM");
    expect(label(run, now, "en-US", en, "UTC")).toBe("Today 4:01 PM");
    expect(label(run, now, "en-US", en, "America/Los_Angeles")).toBe("Today 8:01 AM");
    // 01:30 in Manila is still the evening before in London
    const early = manila(2026, 11, 12, 1, 30);
    expect(label(early, manila(2026, 11, 12, 9, 0), "en-US", en, "Europe/London")).toBe("Yesterday 5:30 PM");
  });

  it("follows the app's language and the locale's clock", () => {
    expect(label(manila(2026, 11, 12, 0, 1), now, "ko-KR", ko)).toBe("오늘 오전 12:01");
    expect(label(manila(2026, 11, 11, 14, 5), now, "en-GB", en)).toBe("Yesterday 14:05");
    expect(label(manila(2026, 11, 10, 14, 5), now, "en-GB", en)).toBe("10 Nov, 14:05");
  });

  it("says nothing for a time that is not one", () => {
    expect(whenLabel(Number.NaN, now * 1000, "en-US", en, "Asia/Manila")).toBe("");
    expect(whenLabel(Number.POSITIVE_INFINITY, now * 1000, "en-US", en, "Asia/Manila")).toBe("");
  });
});

describe("a report", () => {
  it("is new when it was written after the list was last opened", () => {
    expect(isUnread({ ts: 300.5 }, 300)).toBe(true);
    expect(isUnread({ ts: 300 }, 300)).toBe(false);
    expect(isUnread({ ts: 100 }, 300)).toBe(false);
    expect(isUnread({ ts: 1 }, 0)).toBe(true);
  });

  it("names its level in a word, and an unknown one as information", () => {
    expect(levelWord("ok", en)).toBe("OK");
    expect(levelWord("warning", en)).toBe("Warning");
    expect(levelWord("critical", en)).toBe("Critical");
    expect(levelWord("info", en)).toBe("Info");
    expect(levelWord("fatal" as "info", en)).toBe("Info");
    expect(levelWord("critical", ko)).toBe("심각");
  });

  it("opens to the folders it names, in the order they are read", () => {
    const list = (count: number, total = count): VpsNotificationFolders => ({ total, items: Array.from({ length: count }, (_, index) => ({ path: `/opt/workstation/f${index}`, bytes: index, why: "" })) });
    expect(folderGroups({ moved: null, returned: null, waiting: null })).toEqual([]);
    // a list the report counts but does not name has nothing to open
    expect(folderGroups({ moved: { total: 12, items: [] }, returned: null, waiting: { total: 3, items: [] } })).toEqual([]);
    const groups = folderGroups({ moved: list(2), returned: list(1, 5), waiting: list(3) });
    expect(groups.map((group) => group.id)).toEqual(["moved", "returned", "waiting"]);
    // the report's own count where it names fewer than it counted
    expect(folderTotal(groups)).toBe(2 + 5 + 3);
    expect(folderGroups({ moved: null, returned: list(4), waiting: null }).map((group) => group.id)).toEqual(["returned"]);
    expect(folderTotal([])).toBe(0);
  });
});
