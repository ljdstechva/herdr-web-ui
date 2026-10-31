import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

/**
 * Which Claude Code task output files a process holds open now. A command Claude Code runs, in
 * the foreground or the background, writes to `…/tasks/<task id>.output` for as long as it runs,
 * so a held file is a command still running, and its holder's process tree says whose it is.
 * Read from /proc (Linux; elsewhere nothing is known, and callers keep their own answer), this
 * user's processes only, at most once per HELD_MS.
 */
const HELD_MS = 2000;
const OUTPUT = /\/tasks\/([A-Za-z0-9_-]+)\.output$/;

export interface HeldOutputs {
  /** false where /proc cannot be read: nothing below is known */
  known: boolean;
  /** each held output file: its path, task id and the process holding it */
  files: { path: string; id: string; pid: number }[];
  /** each process's parent */
  parents: Map<number, number>;
}

let cached: { at: number; value: HeldOutputs } | null = null;

export function heldOutputs(now = Date.now(), proc = "/proc"): HeldOutputs {
  if (cached !== null && proc === "/proc" && now - cached.at < HELD_MS) return cached.value;
  const value: HeldOutputs = { known: false, files: [], parents: new Map() };
  let pids: string[];
  try { pids = readdirSync(proc).filter((name) => /^\d+$/.test(name)); value.known = true; } catch { pids = []; }
  for (const name of pids) {
    const pid = Number(name);
    try {
      // "pid (comm) state ppid …": comm may hold spaces and parentheses, so the last ")" ends it
      const stat = readFileSync(`${proc}/${name}/stat`, "utf8");
      value.parents.set(pid, Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch { continue; }
    let fds: string[];
    try { fds = readdirSync(`${proc}/${name}/fd`); } catch { continue; }
    for (const fd of fds) {
      let target: string;
      try { target = readlinkSync(`${proc}/${name}/fd/${fd}`); } catch { continue; }
      const match = OUTPUT.exec(target);
      if (match && !value.files.some((file) => file.path === target && file.pid === pid)) value.files.push({ path: target, id: match[1]!, pid });
    }
  }
  if (proc === "/proc") cached = { at: now, value };
  return value;
}

/** Whether `pid` is `root` or runs under it. */
export function descends(pid: number, root: number, parents: ReadonlyMap<number, number>): boolean {
  for (let at: number | undefined = pid, steps = 0; at !== undefined && at > 1 && steps < 64; at = parents.get(at), steps += 1) if (at === root) return true;
  return false;
}

/** The task ids whose output some process holds: commands still running. Null when that cannot be known here. */
export function runningTaskIds(held = heldOutputs()): Set<string> | null {
  return held.known ? new Set(held.files.map((file) => file.id)) : null;
}

/**
 * The output file of the command the Claude process `pid` runs in the foreground now: a file
 * held by a process under it that is no background command's (`background`: their ids). When
 * several are, the one written last. Null when none is, or /proc cannot be read.
 */
export function foregroundOutput(pid: number, background: ReadonlySet<string>, held = heldOutputs(), mtime: (path: string) => number): string | null {
  const mine = held.files.filter((file) => !background.has(file.id) && file.pid !== pid && descends(file.pid, pid, held.parents));
  let best: { path: string; at: number } | null = null;
  for (const file of mine) { const at = mtime(file.path); if (best === null || at > best.at) best = { path: file.path, at }; }
  return best === null ? null : best.path;
}

export const taskIdOf = (path: string): string => basename(path).replace(/\.output$/, "");
