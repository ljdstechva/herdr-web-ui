import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VpsNotification } from "../shared/vps.ts";
import { CabinetReports, MAX_NOTIFICATIONS, parseFeed, parseReport } from "./vps-notifications.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A report as cabinet writes one; `over` replaces fields. */
function report(id: string, ts: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: "alert", level: "info", ts, title: `Report ${id}`, lines: [`Line of ${id}.`], data: {}, ...over };
}

/** The night run of the task's own example, shortened. */
const NIGHTLY = {
  id: "nightly-1794416504", kind: "nightly", level: "ok", ts: 1794416504.0,
  title: "Night run done: backup complete, 12 folders wait",
  lines: [
    "Backup: 6,572 new or changed files (919.2 MB) copied to Drive in 60 min; 416 older versions kept.",
    "Freed 22.9 MB. Free on the VPS now: 48.9 GB of 96 GB (49% used).",
  ],
  data: {
    backup: { ok: true, ran: true, files: 6572, bytes: 963800000, failed: [] },
    moved: { folders: 1, bytes: 123, items: [{ path: "/opt/workstation/03 Agency/work/a", bytes: 123, files: 4 }], waiting: 12, busy: [{ path: "/opt/workstation/11 Reels/work/reel-7", bytes: 88, why: "a session is working in it" }], failed: 0, fails: [] },
    returned: { folders: 5, bytes: 58300000, items: [{ path: "/opt/workstation/11 Reels/.tmp/otter-b", bytes: 31485958 }] },
    scratch: { folders: 1, bytes: 12677120 }, caches: null, check: null, problems: [], freed_bytes: 24030328, free_after_gb: 48.9,
  },
};

/** A feed file and a state folder of the test's own; `bin` is a path that holds no program unless the test writes one. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-vps-notifications-"));
  roots.push(root);
  const feed = join(root, "reports.jsonl");
  const stateDir = join(root, "state");
  const bin = join(root, "cabinet");
  /** replaced whole by a rename, as cabinet does it */
  const write = (lines: (Record<string, unknown> | string)[]): void => {
    const temporary = `${feed}.tmp`;
    writeFileSync(temporary, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
    renameSync(temporary, feed);
  };
  const make = (): CabinetReports => new CabinetReports({ stateDir, feed, bin });
  return { root, feed, stateDir, bin, write, make, reports: make() };
}

describe("a report line", () => {
  it("is read with its folders, as the page lists them", () => {
    expect(parseReport(NIGHTLY)).toEqual({
      id: "nightly-1794416504", kind: "nightly", level: "ok", ts: 1794416504,
      title: "Night run done: backup complete, 12 folders wait",
      lines: NIGHTLY.lines,
      moved: { total: 1, items: [{ path: "/opt/workstation/03 Agency/work/a", bytes: 123, why: "" }] },
      // the program's own count where it names fewer than it counted
      returned: { total: 5, items: [{ path: "/opt/workstation/11 Reels/.tmp/otter-b", bytes: 31485958, why: "" }] },
      waiting: { total: 12, items: [{ path: "/opt/workstation/11 Reels/work/reel-7", bytes: 88, why: "a session is working in it" }] },
    });
  });

  it("never needs its data: every field of it may be missing or null", () => {
    const bare = { id: "a", kind: "alert", level: "warning", ts: 10, title: "Drive is not mounted", lines: ["Check it."] };
    const none: VpsNotification = { id: "a", kind: "alert", level: "warning", ts: 10, title: "Drive is not mounted", lines: ["Check it."], moved: null, returned: null, waiting: null };
    expect(parseReport(bare)).toEqual(none);
    for (const data of [null, {}, [], "text", 7, { moved: null, returned: null }, { moved: { items: null, busy: null }, returned: { items: "none" } }, { moved: { items: [], busy: [] }, returned: { items: [] } }, { moved: 3, returned: [] }]) {
      expect(parseReport({ ...bare, data })).toEqual(none);
    }
    // a folder without a path is not one; a size that is not a number is unknown
    expect(parseReport({ ...bare, data: { moved: { items: [{ bytes: 5 }, null, "x", { path: "  " }, { path: "/opt/workstation/b", bytes: "big" }] } } })?.moved)
      .toEqual({ total: 1, items: [{ path: "/opt/workstation/b", bytes: null, why: "" }] });
  });

  it("is shown as information when its level is not one this app knows, and keeps a kind it does not know", () => {
    expect(parseReport(report("a", 5, { level: "fatal", kind: "weekly" }))).toMatchObject({ level: "info", kind: "weekly" });
    expect(parseReport(report("a", 5, { level: undefined, kind: undefined }))).toMatchObject({ level: "info", kind: "alert" });
    for (const level of ["ok", "warning", "critical", "info"]) expect(parseReport(report("a", 5, { level }))?.level).toBe(level as "ok");
  });

  it("is skipped when it has no time or nothing to show", () => {
    expect(parseReport(report("a", 5))).not.toBeNull();
    for (const ts of [undefined, null, "1794416504", Number.NaN, 0, -3]) expect(parseReport(report("a", 5, { ts }))).toBeNull();
    expect(parseReport(report("a", 5, { title: "", lines: [] }))).toBeNull();
    expect(parseReport(report("a", 5, { title: undefined, lines: undefined }))).toBeNull();
    for (const value of [null, [], "report", 4]) expect(parseReport(value)).toBeNull();
    // without a title its first line is the title; without an id its kind and time name it
    expect(parseReport(report("a", 5, { id: undefined, title: " ", lines: ["First.", 7, "", "Second."] }))).toMatchObject({ id: "alert-5", title: "First.", lines: ["Second."] });
  });

  it("is bounded: long text is cut and a long list of folders is counted, not carried", () => {
    const items = Array.from({ length: 200 }, (_, index) => ({ path: `/opt/workstation/batch-${index}`, bytes: index }));
    const parsed = parseReport(report("a", 5, { title: "t".repeat(5000), lines: Array.from({ length: 80 }, () => "l".repeat(5000)), data: { moved: { folders: 200, items } } }))!;
    expect(parsed.title.length).toBe(300);
    expect(parsed.lines.length).toBe(20);
    expect(parsed.lines[0]!.length).toBe(600);
    expect(parsed.moved).toMatchObject({ total: 200 });
    expect(parsed.moved!.items.length).toBe(60);
  });
});

describe("a feed", () => {
  it("is read newest first, skipping every line that is not a report", () => {
    const text = [
      JSON.stringify(report("old", 100)),
      "not json at all",
      "{\"id\": \"cut\", \"ts\": 150, \"title\": \"cut sh",
      "",
      "[1, 2, 3]",
      "\"a string\"",
      JSON.stringify({ id: "no-time", title: "No time" }),
      `  ${JSON.stringify(report("new", 300))}  `,
      JSON.stringify(report("middle", 200)),
    ].join("\n");
    expect(parseFeed(text).map((item) => item.id)).toEqual(["new", "middle", "old"]);
    expect(parseFeed("")).toEqual([]);
    expect(parseFeed("\n\n")).toEqual([]);
  });

  it("puts the later of two lines first when they share a second, and keeps one report per id", () => {
    expect(parseFeed([report("first", 100), report("second", 100)].map((line) => JSON.stringify(line)).join("\n")).map((item) => item.id)).toEqual(["second", "first"]);
    const twice = parseFeed([report("same", 100, { title: "Before" }), report("other", 150), report("same", 200, { title: "After" })].map((line) => JSON.stringify(line)).join("\n"));
    expect(twice.map((item) => `${item.id}:${item.title}`)).toEqual(["same:After", "other:Report other"]);
  });
});

describe("cabinet's reports", () => {
  it("are an empty list while the feed is not written yet, offered only where there is a cabinet", () => {
    const f = fixture();
    expect(f.reports.list()).toEqual({ available: false, items: [], unread: 0, read_ts: 0 });
    // marking an empty list read writes nothing
    expect(f.reports.markRead()).toEqual({ available: false, items: [], unread: 0, read_ts: 0 });
    expect(existsSync(f.stateDir)).toBe(false);

    // the program is there, its first report is not: the list is offered, and empty
    writeFileSync(f.bin, "#!/bin/sh\nexit 0\n");
    chmodSync(f.bin, 0o755);
    expect(f.reports.list()).toEqual({ available: true, items: [], unread: 0, read_ts: 0 });
    // a file that cannot be run is no program
    chmodSync(f.bin, 0o644);
    expect(f.reports.list().available).toBe(false);

    // a feed alone is reason enough
    f.write([report("a", 100)]);
    expect(f.reports.list()).toMatchObject({ available: true, unread: 1 });
  });

  it("skip a bad line and still give the reports around it", () => {
    const f = fixture();
    f.write([report("a", 100), "{ this is not json", report("b", 200), "{\"id\":\"c\",\"ts\":\"soon\",\"title\":\"x\"}"]);
    const list = f.reports.list();
    expect(list.items.map((item) => item.id)).toEqual(["b", "a"]);
    expect(list.unread).toBe(2);
    // a feed that holds nothing readable is an empty list, not a failure
    f.write(["garbage", "more garbage"]);
    expect(f.reports.list()).toEqual({ available: true, items: [], unread: 0, read_ts: 0 });
  });

  it("count as unread what is newer than the last opening, and nothing after it is marked read", () => {
    const f = fixture();
    f.write([report("a", 100), report("b", 200.5), report("c", 300)]);
    expect(f.reports.list()).toMatchObject({ unread: 3, read_ts: 0 });

    const read = f.reports.markRead();
    expect(read).toMatchObject({ unread: 0, read_ts: 300 });
    expect(read.items.map((item) => item.id)).toEqual(["c", "b", "a"]);
    expect(f.reports.list()).toMatchObject({ unread: 0, read_ts: 300 });
    // the read time is the newest report's own time, in a private file under the state folder
    const state = join(f.stateDir, "vps-notifications.json");
    expect(JSON.parse(readFileSync(state, "utf8"))).toEqual({ read_ts: 300 });
    expect(statSync(state).mode & 0o777).toBe(0o600);
    expect(statSync(f.stateDir).mode & 0o777).toBe(0o700);

    // a report that arrives later is new; one written with an older time is not
    f.write([report("a", 100), report("b", 200.5), report("c", 300), report("late", 250), report("d", 300.2), report("e", 400)]);
    expect(f.reports.list()).toMatchObject({ unread: 2, read_ts: 300 });
    expect(f.reports.markRead()).toMatchObject({ unread: 0, read_ts: 400 });
    // marking read again, or after the feed lost its newest lines, never moves the time back
    f.write([report("a", 100)]);
    expect(f.reports.markRead()).toMatchObject({ unread: 0, read_ts: 400 });
    expect(JSON.parse(readFileSync(state, "utf8"))).toEqual({ read_ts: 400 });
  });

  it("keep what was read across a restart, and for another server on the same state folder", () => {
    const f = fixture();
    f.write([report("a", 100), report("b", 200)]);
    const other = f.make();
    expect(other.list().unread).toBe(2);
    f.reports.markRead();
    // the one that did not mark it sees the file change
    expect(other.list()).toMatchObject({ unread: 0, read_ts: 200 });
    expect(f.make().list()).toMatchObject({ unread: 0, read_ts: 200 });
    // a state file that cannot be read is no reading at all: the reports are new again, and nothing fails
    writeFileSync(join(f.stateDir, "vps-notifications.json"), "{ not json");
    expect(f.make().list()).toMatchObject({ unread: 2, read_ts: 0 });
  });

  it("send the newest 50 and count the unread over the whole feed", () => {
    const f = fixture();
    f.write(Array.from({ length: 120 }, (_, index) => report(`r${index + 1}`, 1000 + index)));
    const list = f.reports.list();
    expect(MAX_NOTIFICATIONS).toBe(50);
    expect(list.items.length).toBe(50);
    expect(list.items[0]!.id).toBe("r120");
    expect(list.items[49]!.id).toBe("r71");
    expect(list.unread).toBe(120);
    expect(f.reports.markRead()).toMatchObject({ unread: 0, read_ts: 1119 });
  });

  it("read the file again only when it was replaced", () => {
    const f = fixture();
    f.write([report("a", 100)]);
    const first = f.reports.list();
    // the same parsed reports serve the next ask
    expect(f.reports.list().items[0]).toBe(first.items[0]!);
    f.write([report("a", 100), report("b", 200)]);
    expect(f.reports.list().items.map((item) => item.id)).toEqual(["b", "a"]);
    rmSync(f.feed);
    expect(f.reports.list().items).toEqual([]);
  });
});
