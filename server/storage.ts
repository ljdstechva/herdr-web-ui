import { lstatSync, mkdirSync, readdirSync, realpathSync, statfsSync, statSync, type Stats } from "node:fs";
import { basename, join } from "node:path";

import type { FolderCreated, StorageUsage } from "../shared/protocol.ts";
import { folderName, folderNameProblem } from "../shared/storage.ts";
import { resolveFilePath } from "./file-view.ts";

/**
 * How much storage a folder or a file takes, and making a folder: what the Files browser asks
 * beyond a listing.
 *
 * A folder is walked on the server's own thread in short turns, the event loop let in between
 * them: `lstat` through the thread pool counted a seventh as fast here, and a walk that held
 * the thread whole would stall every terminal for as long as a large folder takes. Links are
 * not followed (a link into a parent would never end) and a volume mounted inside the folder
 * is left out, as `du -x` leaves it: a cloud drive mounted in the work folder is neither on
 * this disk nor quick to read.
 */

/** One turn of a walk on the thread before the event loop gets its turn. */
const TURN_MS = 8;
/** Stats between two looks at the clock. */
const CLOCK_EVERY = 256;

export interface UsageLimits {
  /** a walk still going after this long answers what it has, as `partial` */
  deadlineMs: number;
  /** and one that counted this many entries */
  maxEntries: number;
}
/**
 * 30 s: a home folder of 400,000 files took 20 s the first time it was read from the disk (3 s
 * the next), and at 12 s it answered less than half of what it holds.
 */
export const USAGE_LIMITS: UsageLimits = { deadlineMs: 30_000, maxEntries: 2_000_000 };

/** A folder asked again within this long (back to the parent, a second device) is not walked again. */
const KEPT_MS = 15_000;
const KEPT_MAX = 24;
const kept = new Map<string, { expires: number; usage: StorageUsage }>();
/** One walk per folder at a time, shared by everyone asking; it stops when none of them waits any more. */
const walks = new Map<string, { promise: Promise<StorageUsage | null>; waiters: number }>();

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Bytes a stat holds on disk; a system that does not count blocks (Windows) is given the length. */
function onDisk(stat: Stats): number {
  return typeof stat.blocks === "number" ? stat.blocks * 512 : stat.size;
}

function volumeOf(path: string): StorageUsage["volume"] {
  try {
    const volume = statfsSync(path);
    const total = volume.blocks * volume.bsize;
    // what this user can still write, which is less than what is unallocated where root keeps a reserve
    return total > 0 ? { total, free: volume.bavail * volume.bsize } : null;
  } catch {
    return null;
  }
}

/** The walk itself; null when everyone who asked left before it ended. */
async function walk(root: string, rootStat: Stats, limits: UsageLimits, abandoned: () => boolean): Promise<StorageUsage | null> {
  // the caller counts itself in before the first look at `abandoned`
  await turn();
  if (abandoned()) return null;
  // no prototype: a folder may be named `__proto__`
  const children: Record<string, { size: number; files: number }> = Object.create(null);
  const linked = new Set<string>();
  let size = 0;
  let disk = 0;
  let files = 0;
  let folders = 0;
  let seen = 0;
  let partial = false;
  const started = performance.now();
  let turnStarted = started;
  const stack: { dir: string; child: { size: number; files: number } | null }[] = [{ dir: root, child: null }];
  walking: while (stack.length > 0) {
    const { dir, child } = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      // a folder this user cannot read holds something the numbers leave out
      partial = true;
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      let stat: Stats;
      try { stat = lstatSync(path); } catch { continue; }
      seen += 1;
      if (stat.isDirectory()) {
        folders += 1;
        disk += onDisk(stat);
        // another volume mounted here: not this folder's storage
        if (stat.dev === rootStat.dev) stack.push({ dir: path, child: child ?? (children[name] = { size: 0, files: 0 }) });
      } else {
        // a file with several names takes its blocks once, under whichever name comes first
        const again = stat.nlink > 1 && linked.has(`${stat.dev}:${stat.ino}`);
        if (stat.nlink > 1 && !again) linked.add(`${stat.dev}:${stat.ino}`);
        if (!again) disk += onDisk(stat);
        // a link, a socket or a pipe holds a block at most and carries nothing to download
        if (stat.isFile()) {
          files += 1;
          size += stat.size;
          if (child !== null) { child.files += 1; child.size += stat.size; }
        }
      }
      if (seen >= limits.maxEntries) { partial = true; break walking; }
      if (seen % CLOCK_EVERY === 0 && performance.now() - turnStarted > TURN_MS) {
        if (abandoned()) return null;
        if (performance.now() - started > limits.deadlineMs) { partial = true; break walking; }
        await turn();
        turnStarted = performance.now();
      }
    }
  }
  return { path: root, name: basename(root) || root, kind: "folder", size, disk: disk + onDisk(rootStat), files, folders, modified: rootStat.mtime.toISOString(), partial, children, volume: volumeOf(root) };
}

/**
 * The storage `input` takes (absolute or `~/…`), or null when nothing readable is there or the
 * request that asked ended first. `signal` is the request's: a walk nobody waits for stops.
 */
export async function storageUsage(input: string, signal?: AbortSignal, limits: UsageLimits = USAGE_LIMITS): Promise<StorageUsage | null> {
  const asked = resolveFilePath(input, null);
  if (asked === null) return null;
  let path: string;
  let stat: Stats;
  try {
    path = realpathSync(asked);
    stat = statSync(path);
  } catch {
    return null;
  }
  if (stat.isFile()) return { path, name: basename(path), kind: "file", size: stat.size, disk: onDisk(stat), files: 1, folders: 0, modified: stat.mtime.toISOString(), partial: false, volume: volumeOf(path) };
  if (!stat.isDirectory()) return null;
  const hit = kept.get(path);
  if (hit !== undefined && hit.expires > Date.now()) return hit.usage;
  let flight = walks.get(path);
  if (flight === undefined) {
    const made: { promise: Promise<StorageUsage | null>; waiters: number } = { waiters: 0, promise: Promise.resolve(null) };
    made.promise = walk(path, stat, limits, () => made.waiters === 0).then((usage) => {
      if (usage !== null) {
        kept.delete(path);
        kept.set(path, { expires: Date.now() + KEPT_MS, usage });
        if (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
      }
      return usage;
    }).finally(() => { if (walks.get(path) === made) walks.delete(path); });
    walks.set(path, made);
    flight = made;
  }
  const joined = flight;
  joined.waiters += 1;
  let left = false;
  const leave = (): void => { if (!left) { left = true; joined.waiters -= 1; } };
  if (signal?.aborted) leave();
  signal?.addEventListener("abort", leave, { once: true });
  try {
    return await joined.promise;
  } finally {
    signal?.removeEventListener("abort", leave);
    leave();
  }
}

/** Sizes read before a change to the tree are no longer its sizes. */
export function forgetStorageUsage(): void {
  kept.clear();
}

export type FolderCreation = { created: FolderCreated } | { refused: "invalid_name" | "not_found" | "exists" | "not_allowed" };

/**
 * Makes the folder `name` inside the folder `parent` (absolute or `~/…`). One level, never a
 * path: the name is checked by shared/storage.ts, and a name that differs from a neighbour's
 * only by case is refused as taken, since a mirror of the folder on Windows or macOS could not
 * hold both.
 */
export function createFolder(parent: string, name: unknown): FolderCreation {
  if (typeof name !== "string" || folderNameProblem(name) !== null) return { refused: "invalid_name" };
  const directory = resolveFilePath(parent, null);
  if (directory === null) return { refused: "not_found" };
  let siblings: string[];
  try {
    if (!statSync(directory).isDirectory()) return { refused: "not_found" };
    siblings = readdirSync(directory);
  } catch {
    return { refused: "not_found" };
  }
  const made = folderName(name);
  if (siblings.some((sibling) => sibling.toLowerCase() === made.toLowerCase())) return { refused: "exists" };
  const path = join(directory, made);
  try {
    mkdirSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { refused: "exists" };
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return { refused: "not_allowed" };
    if (code === "ENOENT" || code === "ENOTDIR") return { refused: "not_found" };
    throw error;
  }
  forgetStorageUsage();
  return { created: { path, name: made } };
}
