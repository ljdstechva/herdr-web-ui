/**
 * Notifications: what the PC's `cabinet` program did, as it reports it. cabinet writes one report
 * per event to a feed file (one JSON object per line, oldest first, at most 300 lines, replaced
 * whole by a rename): the 12:00 a.m. run, a later move of the folders that waited, a health
 * message. This module only reads that file. It runs no program and changes nothing of cabinet's.
 *
 * The app asks about once a minute, so an ask costs one `stat`: the file is read and parsed again
 * only when it was replaced. A line that is not a report (not JSON, no time, nothing to show) is
 * skipped, and a file that is not there yet is an empty list.
 *
 * What is unread is decided here, not on a device: the time of the newest report there was when
 * the list was last opened is kept in one small state file, so a phone and a desktop show the
 * same number.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { VpsNotification, VpsNotificationFolders, VpsNotificationLevel, VpsNotifications } from "../shared/vps.ts";
import { cabinetProgram } from "./cabinet.ts";

export const DEFAULT_REPORTS_FEED = "/var/lib/cabinet/reports.jsonl";
/** how many reports cross the wire, newest first; the feed itself holds up to 300 */
export const MAX_NOTIFICATIONS = 50;
/** how many folders of one kind a report carries to the page, which counts the rest */
const MAX_FOLDERS = 60;
const MAX_LINES = 20;
const MAX_TITLE = 300;
const MAX_LINE = 600;
const MAX_PATH = 1024;
const MAX_WORDS = 300;
/** the feed is a few hundred short lines; of one far past that only the end is read */
const MAX_FEED_BYTES = 4 * 1024 ** 2;

const LEVELS = new Set<VpsNotificationLevel>(["ok", "warning", "critical", "info"]);

/** What /api/vps/notifications needs; tests and fixtures pass their own. */
export interface NotificationsService {
  list(): VpsNotifications;
  /** Everything in the feed now is read. Answers the list as it then is. */
  markRead(): VpsNotifications;
}

export interface CabinetReportsOptions {
  /** where the read time is kept */
  stateDir: string;
  /** cabinet's feed file; unset, HERDR_CABINET_REPORTS, else /var/lib/cabinet/reports.jsonl */
  feed?: string;
  /** the cabinet program, only looked for: with neither it nor a feed, nothing is offered; unset, HERDR_CABINET_BIN, else /usr/local/bin/cabinet */
  bin?: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function words(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** The folders of one list of a report's `data`, a bounded few of them; null when it names none. */
function folders(list: unknown, total: unknown): VpsNotificationFolders | null {
  const all = Array.isArray(list) ? list.filter(isObject).filter((item) => words(item["path"], MAX_PATH) !== "") : [];
  if (all.length === 0) return null;
  const items = all.slice(0, MAX_FOLDERS).map((item) => ({
    path: words(item["path"], MAX_PATH),
    bytes: typeof item["bytes"] === "number" && Number.isFinite(item["bytes"]) && item["bytes"] >= 0 ? item["bytes"] : null,
    why: words(item["why"], MAX_WORDS),
  }));
  // the program's own count where it is the larger: a list it cut short is still counted whole
  return { total: Math.max(all.length, count(total)), items };
}

/** One line of the feed as the wire carries it; null when it is not a report this app can show. */
export function parseReport(value: unknown): VpsNotification | null {
  if (!isObject(value)) return null;
  const ts = value["ts"];
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  const lines = Array.isArray(value["lines"])
    ? value["lines"].map((line) => words(line, MAX_LINE)).filter((line) => line !== "").slice(0, MAX_LINES)
    : [];
  // a report without a title is told by its first line
  const title = words(value["title"], MAX_TITLE) || lines.shift() || "";
  if (title === "") return null;
  const kind = words(value["kind"], 40) || "alert";
  const level = value["level"];
  const data = isObject(value["data"]) ? value["data"] : {};
  const moved = isObject(data["moved"]) ? data["moved"] : {};
  const returned = isObject(data["returned"]) ? data["returned"] : {};
  return {
    id: words(value["id"], 128) || `${kind}-${ts}`,
    kind,
    level: typeof level === "string" && LEVELS.has(level as VpsNotificationLevel) ? (level as VpsNotificationLevel) : "info",
    ts,
    title,
    lines,
    moved: folders(moved["items"], moved["folders"]),
    returned: folders(returned["items"], returned["folders"]),
    waiting: folders(moved["busy"], moved["waiting"]),
  };
}

/**
 * Every report of a feed, newest first. A line that is not valid JSON, or not a report, is
 * skipped; of two lines with one id the later stands.
 */
export function parseFeed(text: string): VpsNotification[] {
  const byId = new Map<string, { report: VpsNotification; order: number }>();
  let order = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let value: unknown;
    try { value = JSON.parse(trimmed); } catch { continue; /* a line cut short, or not ours */ }
    const report = parseReport(value);
    if (report === null) continue;
    byId.set(report.id, { report, order: order += 1 });
  }
  // the file is oldest first: of two reports written in the same second, the later line is the newer
  return [...byId.values()].sort((a, b) => b.report.ts - a.report.ts || b.order - a.order).map((entry) => entry.report);
}

/** A file's identity: another one (a rename put it there), or the same one written to, reads differently. */
function fileKey(stat: { ino: number; size: number; mtimeMs: number }): string {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

export class CabinetReports implements NotificationsService {
  private readonly feed: string;
  private readonly bin: string | undefined;
  private readonly statePath: string;
  /** the feed as last read: `key` is null while there is no file */
  private cached: { key: string | null; reports: VpsNotification[] } | null = null;
  /** the read time as last read from the state file, with that file's identity */
  private read: { key: string | null; ts: number } | null = null;

  constructor(options: CabinetReportsOptions) {
    this.feed = options.feed ?? (process.env["HERDR_CABINET_REPORTS"] || DEFAULT_REPORTS_FEED);
    this.bin = options.bin;
    this.statePath = join(options.stateDir, "vps-notifications.json");
  }

  /** Every report in the feed, newest first, and whether there is a feed at all. Read again only when the file was replaced or written to. */
  private reports(): { exists: boolean; reports: VpsNotification[] } {
    let key: string | null = null;
    try { key = fileKey(statSync(this.feed)); } catch { /* not written yet, or not ours to read: no reports */ }
    if (this.cached === null || this.cached.key !== key) {
      let reports: VpsNotification[] = [];
      if (key !== null) {
        try {
          // the open file is one file whatever is renamed over its name meanwhile: what is read is what was measured
          const fd = openSync(this.feed, "r");
          try {
            const stat = fstatSync(fd);
            key = fileKey(stat);
            const length = Math.min(stat.size, MAX_FEED_BYTES);
            const buffer = Buffer.alloc(length);
            let got = 0;
            while (got < length) {
              const read = readSync(fd, buffer, got, length - got, stat.size - length + got);
              if (read <= 0) break;
              got += read;
            }
            const text = buffer.subarray(0, got).toString("utf8");
            // a read that began mid-file began mid-line: that line is not one
            reports = parseFeed(stat.size > length ? text.slice(text.indexOf("\n") + 1) : text);
          } finally {
            closeSync(fd);
          }
        } catch {
          // gone between the look and the read: the next ask reads what replaced it
          key = null;
        }
      }
      this.cached = { key, reports };
    }
    return { exists: this.cached.key !== null, reports: this.cached.reports };
  }

  /** `ts` of the newest report that was there when the list was last opened; 0 before the first time. */
  private readTs(): number {
    let key: string | null = null;
    try { key = fileKey(statSync(this.statePath)); } catch { /* never opened */ }
    if (this.read === null || this.read.key !== key) {
      let ts = 0;
      if (key !== null) {
        try {
          const raw: unknown = JSON.parse(readFileSync(this.statePath, "utf8"));
          if (isObject(raw) && typeof raw["read_ts"] === "number" && Number.isFinite(raw["read_ts"]) && raw["read_ts"] > 0) ts = raw["read_ts"];
        } catch { /* a file that cannot be read says nothing was read: the reports show as new again */ }
      }
      this.read = { key, ts };
    }
    return this.read.ts;
  }

  private answer(readTs: number): VpsNotifications {
    const { exists, reports } = this.reports();
    return {
      available: exists || cabinetProgram(this.bin) !== null,
      items: reports.slice(0, MAX_NOTIFICATIONS),
      // counted over the whole feed, not only the reports that are sent
      unread: reports.filter((report) => report.ts > readTs).length,
      read_ts: readTs,
    };
  }

  list(): VpsNotifications {
    return this.answer(this.readTs());
  }

  markRead(): VpsNotifications {
    const before = this.readTs();
    // the newest report's own time, not this server's clock: a report written a moment from now is new
    const newest = this.reports().reports[0]?.ts ?? 0;
    if (newest <= before) return this.answer(before);
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ read_ts: newest })}\n`, { mode: 0o600 });
    renameSync(temporary, this.statePath);
    // read back from the file at the next ask, which then knows the file it came from
    this.read = null;
    return this.answer(newest);
  }
}
