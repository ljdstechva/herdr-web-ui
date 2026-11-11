import { useCallback, useEffect, useRef, useState } from "react";

import type { CabinetFolder, CabinetPreview, CabinetResult, CabinetRun, CabinetStatus } from "../../shared/vps.ts";
import { fetchCabinetStatus, formatBytes, VpsError } from "./vps.ts";

/**
 * "Move unused files to Drive" (components/CabinetTidy.tsx): the words for a dry run and a run
 * of the server's `cabinet tidy`, and the reader of its state. Server side: server/cabinet.ts.
 */

/** how often a run under way is asked about; nothing is asked while none runs */
const RUN_POLL_MS = 2500;
/** The work folder and its alias: every folder cabinet names is inside it, so it is not repeated. */
const WORK_ROOTS = ["/opt/workstation/", "/opt/workspace/"];

/** A path as the owner knows it: inside the work folder, without the work folder in front. */
export function workRelative(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const root = WORK_ROOTS.find((prefix) => trimmed.startsWith(prefix));
  return root ? trimmed.slice(root.length) : trimmed;
}

function middle(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/**
 * A path cut to `max` characters for a narrow screen: the first folder and the last ones stay,
 * the middle becomes "…". A path that fits is returned as it is.
 */
export function shortPath(path: string, max = 48): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  const first = parts[0]!;
  const last = parts.at(-1)!;
  if (parts.length < 3) return middle(path, max);
  if (`${first}/…/${last}`.length > max) {
    // the last name alone is the most telling part: it keeps what room there is
    const room = max - first.length - 3;
    return room >= 8 ? `${first}/…/${middle(last, room)}` : middle(`…/${last}`, max);
  }
  let tail = last;
  // as many of the folders before the last as still fit
  for (let index = parts.length - 2; index > 0; index -= 1) {
    const next = `${parts[index]!}/${tail}`;
    if (`${first}/…/${next}`.length > max) break;
    tail = next;
  }
  return `${first}/…/${tail}`;
}

/** A folder for a row: its own name, and where it is inside the work folder (empty at the top). */
export function folderLabel(path: string): { name: string; where: string } {
  const relative = workRelative(path);
  const at = relative.lastIndexOf("/");
  if (at <= 0) return { name: middle(relative.slice(at + 1) || relative, 48), where: at === 0 ? "/" : "" };
  return { name: middle(relative.slice(at + 1), 48), where: shortPath(relative.slice(0, at), 60) };
}

export function folderCount(count: number): string {
  return count === 1 ? "1 folder" : `${count.toLocaleString("en-US")} folders`;
}

/** Free space as cabinet reports it (GiB, one decimal); "–" when it does not. */
export function formatFree(gb: number | null): string {
  return gb === null ? "–" : `${gb.toFixed(1)} GB`;
}

/** "68 folders, 4.6 GB would move." */
export function previewLine(preview: Pick<CabinetPreview, "folders" | "bytes">): string {
  return `${folderCount(preview.folders)}, ${formatBytes(preview.bytes)} would move.`;
}

/** "Moved 3 folders, 118 MB." */
export function resultLine(result: Pick<CabinetResult, "moved" | "bytes">): string {
  return result.moved === 0 ? "Nothing was moved." : `Moved ${folderCount(result.moved)}, ${formatBytes(result.bytes)}.`;
}

/** "Free: 37.1 GB → 41.2 GB"; null when cabinet did not measure both. */
export function freeLine(result: Pick<CabinetResult, "free_before_gb" | "free_after_gb">): string | null {
  if (result.free_before_gb === null || result.free_after_gb === null) return null;
  return `Free: ${formatFree(result.free_before_gb)} → ${formatFree(result.free_after_gb)}`;
}

/** What else the run cleaned, as the nightly run does; null when it cleaned nothing else. */
export function alsoLine(result: Pick<CabinetResult, "scratch_folders" | "scratch_bytes" | "browser_files">): string | null {
  const parts: string[] = [];
  if (result.scratch_folders > 0) parts.push(`cleared ${result.scratch_folders === 1 ? "1 old scratch folder" : `${result.scratch_folders.toLocaleString("en-US")} old scratch folders`} (${formatBytes(result.scratch_bytes)})`);
  if (result.browser_files > 0) parts.push(`packed ${result.browser_files === 1 ? "1 old browser file" : `${result.browser_files.toLocaleString("en-US")} old browser files`} to Drive`);
  return parts.length > 0 ? `Also ${parts.join(" and ")}.` : null;
}

/** The largest few folders, and how many more there are than shown. */
export function largestFolders(preview: Pick<CabinetPreview, "folders" | "items">, limit = 5): { shown: CabinetFolder[]; more: number } {
  const shown = [...preview.items].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
  return { shown, more: Math.max(0, preview.folders - shown.length) };
}

/** "45 s", "1 min 35 s", "1 h 2 min" */
export function elapsedLabel(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return whole % 60 === 0 ? `${minutes} min` : `${minutes} min ${whole % 60} s`;
  return minutes % 60 === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** How long ago, for "Last run …": "just now", "5 min ago", "3 h ago", "2 days ago". */
export function agoLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/** One line about a run that ended, for the entry and under a new check; null while it runs. `now` is the server's clock. */
export function lastRunLine(run: CabinetRun, now: number): string | null {
  if (run.state === "running") return null;
  const ago = agoLabel(now - (run.finished_at ?? run.started_at));
  if (run.state === "busy") return `Last try ${ago}: another cabinet job was running, nothing was changed.`;
  if (run.state === "failed" || run.result === null) return `Last try ${ago}: it did not finish.`;
  const { result } = run;
  const moved = result.moved === 0 ? "nothing was moved" : `moved ${folderCount(result.moved)}, ${formatBytes(result.bytes)}`;
  const failed = result.failed > 0 ? `, ${result.failed} could not be moved` : "";
  return `Last run ${ago}: ${moved}${failed}.`;
}

/** A refusal in the owner's words; the server's own sentence where there is no better one. */
export function cabinetProblem(code: string | null, message: string): string {
  switch (code) {
    case "cabinet_busy": return "Another cabinet job is running right now (for example the hourly copy to Drive). Nothing was changed. Try again in a few minutes.";
    case "preview_running": return "The check is still running. Try again in a moment.";
    case "preview_timeout": return "The check took too long and was stopped. Nothing was changed. Try again.";
    case "cabinet_missing": return "This server has no cabinet program, so nothing can be moved from here.";
    case "read_only": return "This device can only watch. Use a device that can type to move files.";
    case "bad_output":
    case "preview_failed": return `The check did not work: ${message}`;
    default: return message;
  }
}

export interface CabinetState {
  /** null until the first answer; stays null where the server offers no cabinet */
  status: CabinetStatus | null;
  /** the server's clock now, from the last answer: what a run's `started_at` is counted against */
  serverNow(): number;
  refresh(): Promise<CabinetStatus | null>;
  /** an answer that came with another request (the start's 202) */
  adopt(status: CabinetStatus): void;
}

/**
 * The run under way or the last one. Read once when the dialog opens, when the page comes back,
 * and every few seconds only while a run is under way: a run goes on with the page closed, and
 * the page that opens next finds it here.
 */
export function useCabinet(): CabinetState {
  const [status, setStatus] = useState<CabinetStatus | null>(null);
  const skew = useRef(0);
  const inFlight = useRef<Promise<CabinetStatus | null> | null>(null);
  const gone = useRef(false);

  const adopt = useCallback((next: CabinetStatus) => {
    skew.current = next.now - Date.now();
    setStatus(next);
  }, []);

  const refresh = useCallback((): Promise<CabinetStatus | null> => {
    if (gone.current) return Promise.resolve(null);
    inFlight.current ??= fetchCabinetStatus()
      .then((next) => { adopt(next); return next; })
      .catch((reason: unknown) => {
        // an older server, one without VPS status, or a device that can only watch: nothing is offered, and nothing is asked again
        if (reason instanceof VpsError && (reason.status === 404 || reason.status === 403)) gone.current = true;
        return null;
      })
      .finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, [adopt]);

  const running = status?.run?.state === "running";
  useEffect(() => {
    void refresh();
    const onVisible = (): void => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, RUN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, refresh]);

  const serverNow = useCallback(() => Date.now() + skew.current, []);
  return { status, serverNow, refresh, adopt };
}
