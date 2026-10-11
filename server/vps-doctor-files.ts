import { lstat, opendir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

export class ScanStopped extends Error {
  constructor(readonly code: "scan_timeout" | "scan_limit") {
    super(code === "scan_timeout" ? "The disk scan timed out. No cleanup plan was saved." : "The disk scan reached its file limit. No cleanup plan was saved.");
  }
}

/** Shared by all commands and walks in one scan. Await work before closing it, never race it. */
export class ScanBudget {
  readonly controller = new AbortController();
  readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private entries = 0;
  constructor(ms = 240_000, private readonly limit = 200_000) {
    this.deadline = performance.now() + ms;
    this.timer = setTimeout(() => this.controller.abort(), Math.max(0, ms));
  }
  check(): void {
    if (this.controller.signal.aborted || performance.now() >= this.deadline) throw new ScanStopped("scan_timeout");
  }
  visit(): void { this.check(); if (++this.entries > this.limit) throw new ScanStopped("scan_limit"); }
  remaining(): number { this.check(); return Math.max(1, this.deadline - performance.now()); }
  close(): void { clearTimeout(this.timer); }
}

export async function* directory(path: string, work: ScanBudget): AsyncGenerator<string> {
  work.check();
  let dir;
  try { dir = await opendir(path); } catch { work.check(); return; }
  for await (const entry of dir) { work.visit(); yield join(path, entry.name); }
  work.check();
}

export async function isDirectory(path: string): Promise<boolean> {
  try { return (await lstat(path)).isDirectory(); } catch { return false; }
}

/** Counts every visited entry, not just matching files, and never follows symlinks. */
export async function oldFiles(root: string, cutoff: number, work: ScanBudget, keep: (path: string, stat: Stats) => boolean = () => true): Promise<{ paths: string[]; bytes: number }> {
  const paths: string[] = [];
  let bytes = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    work.check();
    if (!(await isDirectory(dir))) return;
    if (depth > 12) throw new ScanStopped("scan_limit");
    for await (const path of directory(dir, work)) {
      let stats;
      try { stats = await lstat(path); } catch { continue; }
      work.check();
      if (!keep(path, stats)) continue;
      if (stats.isDirectory()) await walk(path, depth + 1);
      else if (stats.isFile() && stats.mtimeMs < cutoff) { paths.push(path); bytes += stats.size; }
    }
  };
  await walk(root, 0);
  return { paths, bytes };
}

export interface FileIdentity {
  path: string;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  size: number;
  mtime: number;
  ctime: number;
  directory: boolean;
}

function identity(path: string, stat: Stats): FileIdentity {
  return { path, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, directory: stat.isDirectory() };
}

function same(a: FileIdentity, b: FileIdentity, content: boolean): boolean {
  return a.path === b.path && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid
    && (!content || (a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime));
}

export interface PathPlan {
  path: string;
  /** This exact directory, or the parent of this exact file; never a scan-wide prefix. */
  root: string;
  ancestors: FileIdentity[];
  entries: FileIdentity[];
}

/** A manifest also catches writes/new descendants that do not change a top-level directory's mtime. */
export async function capturePath(path: string, work: ScanBudget, cutoff?: number): Promise<PathPlan | null> {
  if (!isAbsolute(path) || normalize(path) !== path) return null;
  work.check();
  try {
    const ancestors: FileIdentity[] = [];
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      work.check();
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      ancestors.push(identity(parent, stat));
      if (parent === dirname(parent)) break;
    }
    if (await realpath(dirname(path)) !== dirname(path)) return null;
    const entries: FileIdentity[] = [];
    const walk = async (entry: string, depth: number): Promise<boolean> => {
      work.visit();
      if (depth > 12) throw new ScanStopped("scan_limit");
      const stat = await lstat(entry);
      if ((!stat.isFile() && !stat.isDirectory()) || stat.isSymbolicLink() || (cutoff !== undefined && stat.mtimeMs >= cutoff)) return false;
      const before = identity(entry, stat);
      entries.push(before);
      if (stat.isDirectory()) {
        // Unlike advisory enumeration, a deletion manifest must fail closed on unreadable entries.
        const dir = await opendir(entry);
        for await (const child of dir) if (!await walk(join(entry, child.name), depth + 1)) return false;
        if (!same(before, identity(entry, await lstat(entry)), true)) return false;
      }
      return true;
    };
    if (!await walk(path, 0)) return null;
    work.check();
    return { path, root: entries[0]!.directory ? path : dirname(path), ancestors, entries };
  } catch (error) { if (error instanceof ScanStopped) throw error; return null; }
}

/** Re-check the full parent chain as well as canonical containment immediately before each delete. */
export async function validateEntry(plan: PathPlan, entry: FileIdentity, directories: ReadonlyMap<string, FileIdentity>, content = true): Promise<boolean> {
  try {
    for (let path = dirname(entry.path); ; path = dirname(path)) {
      const parent = directories.get(path);
      if (!parent) return false;
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !same(parent, identity(parent.path, stat), false)) return false;
      if (path === dirname(path)) break;
    }
    const canonical = await realpath(dirname(entry.path));
    const allowed = entry.path === plan.root ? dirname(plan.root) : plan.root;
    if (canonical !== dirname(entry.path) || (canonical !== allowed && !canonical.startsWith(`${allowed}/`))) return false;
    const stat = await lstat(entry.path);
    return !stat.isSymbolicLink() && same(entry, identity(entry.path, stat), content);
  } catch { return false; }
}

export async function validatePath(plan: PathPlan, work: ScanBudget): Promise<boolean> {
  const current = await capturePath(plan.path, work);
  const expected = new Map(plan.entries.map((entry) => [entry.path, entry]));
  return current !== null && current.root === plan.root && current.ancestors.length === plan.ancestors.length
    && current.ancestors.every((entry, i) => same(entry, plan.ancestors[i]!, false))
    && current.entries.length === plan.entries.length && current.entries.every((entry) => { const prior = expected.get(entry.path); return prior !== undefined && same(entry, prior, true); });
}
