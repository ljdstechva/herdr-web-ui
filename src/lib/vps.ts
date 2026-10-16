import { useCallback, useEffect, useRef, useState } from "react";

import type {
  DiskCleanResult,
  DiskScan,
  DoctorAgentRequest,
  DoctorAgentResult,
  DoctorOptions,
  DoctorProcesses,
  ProcessAction,
  ProcessActionResult,
  VpsConfig,
  VpsIssue,
  VpsSeverity,
  VpsStatus,
} from "../../shared/vps.ts";

/** how often the open app asks for the numbers; the server measures every 15 s */
const POLL_MS = 15_000;
const SEEN_KEY = "herdr-web-ui:vps-seen";

export class VpsError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) {
    super(message);
    this.name = "VpsError";
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let code: string | null = null;
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? null;
      message = body.error?.message ?? message;
    } catch {
      /* not the JSON envelope */
    }
    throw new VpsError(response.status, code, message);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

function post<T>(url: string, body: unknown = {}): Promise<T> {
  return call<T>(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-vps": "1" }, body: JSON.stringify(body) });
}

export const fetchVpsStatus = (): Promise<VpsStatus> => call("/api/vps/status");
export const saveVpsConfig = (config: VpsConfig): Promise<VpsConfig> => post("/api/vps/config", config);
export const testVpsAlert = (): Promise<void> => post("/api/vps/alert/test");
export const fetchDoctorOptions = (): Promise<DoctorOptions> => call("/api/vps/doctor/options");
export const scanDisk = (olderThanDays: number): Promise<DiskScan> => post("/api/vps/doctor/disk/scan", { older_than_days: olderThanDays });
export const cleanDisk = (scanId: string, ids: string[]): Promise<DiskCleanResult> => post("/api/vps/doctor/disk/clean", { scan_id: scanId, ids });
export const fetchDoctorProcesses = (): Promise<DoctorProcesses> => call("/api/vps/doctor/processes");
export const processAction = (pid: number, startTicks: number, action: ProcessAction): Promise<ProcessActionResult> =>
  post("/api/vps/doctor/process", { pid, start_ticks: startTicks, action });
export const startDoctorAgent = (request: DoctorAgentRequest): Promise<DoctorAgentResult> => post("/api/vps/doctor/agent", request);

/**
 * The server's numbers while the page is visible. `unavailable`: this server has no VPS status
 * (another OS, or an older build), and nothing about it is drawn.
 */
export function useVpsStatus(): { status: VpsStatus | null; unavailable: boolean; error: string | null; refresh: () => void } {
  const [status, setStatus] = useState<VpsStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    fetchVpsStatus()
      .then((next) => { setStatus(next); setError(null); setUnavailable(!next.supported); })
      .catch((reason: unknown) => {
        if (reason instanceof VpsError && reason.status === 404) setUnavailable(true);
        else setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { inFlight.current = false; });
  }, []);

  useEffect(() => {
    if (unavailable) return;
    refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, POLL_MS);
    const onVisible = (): void => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, unavailable]);

  return { status, unavailable, error, refresh };
}

const RANK: Record<VpsSeverity, number> = { ok: 0, warning: 1, critical: 2 };

/** The level this device last showed each issue at. */
export function readSeen(): Record<string, VpsSeverity> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, VpsSeverity>) : {};
  } catch {
    return {};
  }
}

export function writeSeen(seen: Record<string, VpsSeverity>): void {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* storage blocked: shown again next time */ }
}

/** Issues this device has not shown yet, or not at this level. */
export function newsIssues(issues: readonly VpsIssue[], seen: Record<string, VpsSeverity>): VpsIssue[] {
  return issues.filter((issue) => RANK[issue.severity] > RANK[seen[issue.id] ?? "ok"]);
}

/** What stays seen: the issues still open, at the level they were shown; a gone issue is news again when it returns. */
export function markSeen(issues: readonly VpsIssue[], seen: Record<string, VpsSeverity>): Record<string, VpsSeverity> {
  const next: Record<string, VpsSeverity> = {};
  for (const issue of issues) {
    const before = seen[issue.id];
    next[issue.id] = before && RANK[before] > RANK[issue.severity] ? before : issue.severity;
  }
  return next;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** The fullest disk: the one the sidebar names. */
export function fullestDisk(status: VpsStatus): VpsStatus["disks"][number] | null {
  return [...status.disks].sort((a, b) => b.used_percent - a.used_percent)[0] ?? null;
}

/** The level a metric is at against its thresholds, for the bars. */
export function meterLevel(value: number, warning: number, critical: number): VpsSeverity {
  return value >= critical ? "critical" : value >= warning ? "warning" : "ok";
}

export const SEVERITY_WORD: Record<VpsSeverity, string> = { ok: "OK", warning: "Warning", critical: "Critical" };

/** A tap on a VPS alert opened the app (sw.js: /?vps=1), read before the app rewrites the address. */
export const OPENED_FROM_ALERT = typeof location !== "undefined" && new URLSearchParams(location.search).get("vps") === "1";
