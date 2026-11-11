/** What the Files browser works out from a listing and the sizes that follow it; nothing here touches the page. */
import type { DirectoryListing, StorageUsage } from "../../shared/protocol.ts";

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/**
 * A size as a person reads it, up to terabytes: "812 B", "14 KB", "3.4 MB", "15.9 GB". Binary
 * steps under the usual names, as a file manager shows them; one decimal under 10 of a unit,
 * where it still tells two folders apart.
 */
export function formatSize(bytes: number): string {
  const whole = Math.max(0, Math.round(bytes));
  if (whole < 1024) return `${whole} B`;
  let value = whole / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1; }
  // a rounding that reaches 1024 belongs to the next unit: "1 MB", not "1024 KB"
  if (Math.round(value) >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit += 1; }
  const shown = unit > 0 && (value < 10 || (unit >= 2 && value < 100)) ? Math.round(value * 10) / 10 : Math.round(value);
  return `${shown} ${UNITS[unit]}`;
}

export type RowOrder = "name" | "size";

export interface BrowserRow {
  name: string;
  folder: boolean;
  /** bytes inside; null while a folder is being measured, and for one the walk leaves out (a link, another volume) */
  size: number | null;
  /** files inside a folder, when measured */
  files: number | null;
  /** its part of the largest row here, 0 to 100: the bar behind the row */
  share: number;
}

/**
 * The rows of one folder: its folders with the sizes the walk found, then its files. By name,
 * folders come first as the listing has them; by size, the largest comes first whatever it is,
 * and what has no size yet goes last. `usage` is the walk of this same folder, or null before it
 * answers.
 */
export function browserRows(listing: DirectoryListing, usage: StorageUsage | null, order: RowOrder): BrowserRow[] {
  const measured = usage !== null && usage.path === listing.path ? usage.children ?? {} : null;
  const rows: BrowserRow[] = [
    ...listing.directories.map((name): BrowserRow => {
      const inside = measured !== null && Object.hasOwn(measured, name) ? measured[name]! : null;
      return { name, folder: true, size: inside?.size ?? null, files: inside?.files ?? null, share: 0 };
    }),
    ...(listing.files ?? []).map((file): BrowserRow => ({ name: file.name, folder: false, size: file.size, files: null, share: 0 })),
  ];
  const largest = rows.reduce((most, row) => Math.max(most, row.size ?? 0), 0);
  for (const row of rows) {
    // a row with anything in it shows at least a sliver
    row.share = largest > 0 && row.size !== null && row.size > 0 ? Math.max(1, Math.round((row.size / largest) * 100)) : 0;
  }
  if (order === "size") {
    // a stable sort: equal sizes keep the listing's name order
    rows.sort((left, right) => (right.size ?? -1) - (left.size ?? -1));
  }
  return rows;
}

/** A path inside `parent`, which may end in a separator (the root). */
export function childPath(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/** How full a volume is, 0 to 100, for its meter. */
export function volumeUsed(volume: { total: number; free: number }): number {
  if (!(volume.total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round(((volume.total - volume.free) / volume.total) * 100)));
}
