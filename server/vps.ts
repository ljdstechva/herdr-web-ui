/**
 * VPS status: the health of the PC this server runs on (CPU, memory, swap, disks, the heaviest
 * processes), the issues it has against the owner's thresholds, and an alert when one appears or
 * gets worse. The Doctor that fixes them is server/vps-doctor.ts; the routes are at the bottom.
 *
 * Linux only, read straight from /proc and statfs: nothing here starts a process while sampling.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_VPS_THRESHOLDS,
  type VpsConfig,
  type VpsDisk,
  type VpsIssue,
  type VpsProcess,
  type VpsSeverity,
  type VpsStatus,
  type VpsThresholds,
} from "../shared/vps.ts";
import type { PushPayload } from "../shared/protocol.ts";

/** how often the PC is measured */
export const SAMPLE_MS = 15_000;
/** the CPU issue is judged on this long an average, so a build or a burst is not an alarm */
export const CPU_WINDOW_MS = 5 * 60_000;
/** an issue that stays is told again after this long */
export const REMIND_MS = 12 * 60 * 60_000;
/** points under a threshold an issue must fall before it counts as gone, so a value on the line does not flap */
export const HYSTERESIS = 2;
/** Linux reports process times in USER_HZ, 100 on every architecture it runs on */
const CLK_TCK = 100;
/** processes the status names, by CPU and by memory each */
const TOP_EACH = 5;

/** filesystems that hold data; tmpfs, overlay, squashfs and the like are not disks to fill */
const DISK_TYPES = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "vfat", "exfat", "ntfs", "ntfs3", "jfs", "reiserfs"]);

export interface CpuTimes {
  total: number;
  idle: number;
}

export interface MemInfo {
  total_bytes: number;
  available_bytes: number;
  swap_total_bytes: number;
  swap_free_bytes: number;
}

/** One row of the process table, before CPU use is known (that takes two reads). */
export interface ProcessRow {
  pid: number;
  ppid: number;
  uid: number;
  name: string;
  /** user + system time so far, in clock ticks */
  ticks: number;
  start_ticks: number;
  rss_bytes: number;
}

/** Where the numbers come from; tests pass their own. */
export interface VpsReader {
  supported(): boolean;
  cpuTimes(): CpuTimes;
  cores(): number;
  memInfo(): MemInfo;
  load(): [number, number, number];
  uptime(): number;
  disks(): VpsDisk[];
  processes(): ProcessRow[];
  command(pid: number): string | null;
  userName(uid: number): string;
  ownUid(): number;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export class LinuxReader implements VpsReader {
  private users: Map<number, string> | null = null;

  supported(): boolean {
    if (process.platform !== "linux") return false;
    try { readText("/proc/stat"); return true; } catch { return false; }
  }

  cpuTimes(): CpuTimes {
    const line = readText("/proc/stat").split("\n").find((row) => row.startsWith("cpu ")) ?? "";
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal (guest time is already inside user)
    const total = fields.slice(0, 8).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
    return { total, idle };
  }

  cores(): number {
    const count = readText("/proc/stat").split("\n").filter((row) => /^cpu\d+ /.test(row)).length;
    return Math.max(1, count);
  }

  memInfo(): MemInfo {
    const text = readText("/proc/meminfo");
    const kb = (key: string): number => {
      const match = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text);
      return match ? Number(match[1]) * 1024 : 0;
    };
    return { total_bytes: kb("MemTotal"), available_bytes: kb("MemAvailable"), swap_total_bytes: kb("SwapTotal"), swap_free_bytes: kb("SwapFree") };
  }

  load(): [number, number, number] {
    const [one, five, fifteen] = readText("/proc/loadavg").trim().split(/\s+/).map(Number);
    return [one ?? 0, five ?? 0, fifteen ?? 0];
  }

  uptime(): number {
    return Math.round(Number(readText("/proc/uptime").split(/\s+/)[0] ?? 0));
  }

  disks(): VpsDisk[] {
    const seen = new Set<string>();
    const disks: VpsDisk[] = [];
    for (const line of readText("/proc/mounts").split("\n")) {
      const [device, rawMount, type] = line.split(" ");
      if (!device || !rawMount || !type || !DISK_TYPES.has(type)) continue;
      if (!device.startsWith("/dev/") && type !== "zfs") continue;
      // a device mounted twice (bind mounts) is one disk
      if (seen.has(device)) continue;
      seen.add(device);
      const mount = rawMount.replace(/\\040/g, " ");
      try {
        const stats = statfsSync(mount);
        const block = stats.bsize;
        const used = (stats.blocks - stats.bfree) * block;
        const available = stats.bavail * block;
        const total = stats.blocks * block;
        if (total <= 0) continue;
        // as df counts it: the root reserve is neither used nor available
        disks.push({ mount, device, fs_type: type, total_bytes: total, used_bytes: used, available_bytes: available, used_percent: percent(used, used + available) });
      } catch {
        /* a mount that went away between the two reads */
      }
    }
    return disks.sort((a, b) => a.mount.length - b.mount.length || a.mount.localeCompare(b.mount));
  }

  processes(): ProcessRow[] {
    const rows: ProcessRow[] = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readText(`/proc/${entry}/stat`);
        const status = readText(`/proc/${entry}/status`);
        // the name sits in parentheses and may hold spaces and parentheses itself
        const open = stat.indexOf("(");
        const close = stat.lastIndexOf(")");
        const fields = stat.slice(close + 2).split(" ");
        const uid = /^Uid:\s+(\d+)/m.exec(status);
        const rss = /^VmRSS:\s+(\d+) kB/m.exec(status);
        rows.push({
          pid: Number(entry),
          ppid: Number(fields[1]),
          uid: uid ? Number(uid[1]) : -1,
          name: stat.slice(open + 1, close),
          ticks: Number(fields[11]) + Number(fields[12]),
          start_ticks: Number(fields[19]),
          rss_bytes: rss ? Number(rss[1]) * 1024 : 0,
        });
      } catch {
        /* exited while the table was read */
      }
    }
    return rows;
  }

  command(pid: number): string | null {
    try {
      const raw = readText(`/proc/${pid}/cmdline`).replace(/\0+$/, "").replace(/\0/g, " ").trim();
      return raw.length > 400 ? `${raw.slice(0, 399)}…` : raw;
    } catch {
      return null;
    }
  }

  userName(uid: number): string {
    if (!this.users) {
      this.users = new Map();
      try {
        for (const line of readText("/etc/passwd").split("\n")) {
          const [name, , id] = line.split(":");
          if (name && id) this.users.set(Number(id), name);
        }
      } catch {
        /* no passwd: numbers it is */
      }
    }
    return this.users.get(uid) ?? String(uid);
  }

  ownUid(): number {
    return process.getuid?.() ?? -1;
  }
}

export function percent(part: number, whole: number): number {
  if (!(whole > 0)) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const RANK: Record<VpsSeverity, number> = { ok: 0, warning: 1, critical: 2 };

/** The level a value stands at: past a threshold, or still within HYSTERESIS of where it was. */
export function levelOf(value: number, warning: number, critical: number, prior: VpsSeverity | undefined): Exclude<VpsSeverity, "ok"> | null {
  if (value >= critical) return "critical";
  if (prior === "critical" && value >= critical - HYSTERESIS) return "critical";
  if (value >= warning) return "warning";
  if (prior !== undefined && prior !== "ok" && value >= warning - HYSTERESIS) return "warning";
  return null;
}

export interface IssueInput {
  disks: VpsDisk[];
  memory: VpsStatus["memory"];
  swap: VpsStatus["swap"];
  cpu: VpsStatus["cpu"];
  /** the CPU average covers a whole window: a server minutes old does not judge the CPU */
  cpuJudged: boolean;
}

/** Today's issues, given yesterday's (for hysteresis and for when each began). */
export function evaluateIssues(input: IssueInput, thresholds: VpsThresholds, previous: ReadonlyMap<string, VpsIssue>, now: number): VpsIssue[] {
  const issues: VpsIssue[] = [];
  const add = (id: string, kind: VpsIssue["kind"], value: number, warning: number, critical: number, title: string, detail: string): void => {
    const prior = previous.get(id);
    const severity = levelOf(value, warning, critical, prior?.severity);
    if (severity === null) return;
    issues.push({ id, kind, severity, title, detail, since: prior?.since ?? now });
  };
  for (const disk of input.disks) {
    add(`disk:${disk.mount}`, "disk", disk.used_percent, thresholds.disk_warning, thresholds.disk_critical,
      `Disk ${disk.mount} is ${Math.round(disk.used_percent)}% full`,
      `${formatBytes(disk.available_bytes)} free of ${formatBytes(disk.total_bytes)}`);
  }
  add("memory", "memory", input.memory.used_percent, thresholds.memory_warning, thresholds.memory_critical,
    `Memory is ${Math.round(input.memory.used_percent)}% used`,
    `${formatBytes(input.memory.available_bytes)} available of ${formatBytes(input.memory.total_bytes)}`);
  if (input.swap.total_bytes > 0) {
    add("swap", "swap", input.swap.used_percent, thresholds.swap_warning, thresholds.swap_critical,
      `Swap is ${Math.round(input.swap.used_percent)}% used`,
      `${formatBytes(input.swap.used_bytes)} of ${formatBytes(input.swap.total_bytes)} in swap: the PC is short of memory`);
  }
  if (input.cpuJudged) {
    add("cpu", "cpu", input.cpu.average_percent, thresholds.cpu_warning, thresholds.cpu_critical,
      `CPU ${Math.round(input.cpu.average_percent)}% busy for 5 minutes`,
      `load ${input.cpu.load.map((value) => value.toFixed(2)).join(" ")} on ${input.cpu.cores} core${input.cpu.cores === 1 ? "" : "s"}`);
  }
  return issues.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.id.localeCompare(b.id));
}

/** Whether this issue is news: new, worse than last told, or untold for REMIND_MS. */
export function shouldAlert(issue: VpsIssue, told: { severity: VpsSeverity; at: number } | undefined, now: number): boolean {
  if (!told) return true;
  if (RANK[issue.severity] > RANK[told.severity]) return true;
  return now - told.at >= REMIND_MS;
}

/** The push an issue sends: one notification slot per issue, so a worse one replaces the milder. */
export function vpsAlertMessage(issue: VpsIssue, host: string): PushPayload {
  return {
    pane_id: null,
    title: `${host}: ${issue.title}`,
    body: `${issue.detail}. Open VPS status in herdr web ui to run the Doctor.`,
    tag: `herdr-vps-${issue.id}`,
  };
}

function clamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value))) : fallback;
}

/** Only numbers between 1 and 100 survive, and a warning never sits above its critical. */
export function parseConfig(value: unknown): VpsConfig {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const raw = typeof record["thresholds"] === "object" && record["thresholds"] !== null ? (record["thresholds"] as Record<string, unknown>) : {};
  const thresholds = { ...DEFAULT_VPS_THRESHOLDS };
  for (const key of Object.keys(DEFAULT_VPS_THRESHOLDS) as (keyof VpsThresholds)[]) thresholds[key] = clamp(raw[key], DEFAULT_VPS_THRESHOLDS[key]);
  for (const kind of ["disk", "memory", "swap", "cpu"] as const) {
    const warning = `${kind}_warning` as const;
    const critical = `${kind}_critical` as const;
    if (thresholds[warning] > thresholds[critical]) thresholds[warning] = thresholds[critical];
  }
  return { alerts: typeof record["alerts"] === "boolean" ? record["alerts"] : true, thresholds };
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJsonPrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export interface VpsMonitorOptions {
  stateDir: string;
  reader?: VpsReader;
  now?: () => number;
  sampleMs?: number;
}

interface Previous {
  at: number;
  cpu: CpuTimes;
  /** ticks per `pid:start` */
  ticks: Map<string, number>;
}

/**
 * Measures the PC every SAMPLE_MS while started, keeps the latest VpsStatus and calls `onAlert`
 * for an issue that is news. What was told, and when, outlives a restart (stateDir/vps-alerts.json),
 * so an update of the app does not repeat a standing alert.
 */
export class VpsMonitor {
  readonly reader: VpsReader;
  private readonly configPath: string;
  private readonly alertsPath: string;
  private readonly now: () => number;
  private readonly sampleMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private previous: Previous | null = null;
  private cpuHistory: { at: number; usage: number }[] = [];
  private startedAt: number;
  private latest: VpsStatus | null = null;
  private issues = new Map<string, VpsIssue>();
  private told: Map<string, { severity: VpsSeverity; at: number }>;
  private configValue: VpsConfig;
  /** CPU use per process over the last sample, by `pid:start` */
  private processCpu = new Map<string, number>();
  /** false: nobody could hear it (no device subscribed); it stays news and is tried at the next sample */
  onAlert: ((issue: VpsIssue, status: VpsStatus) => boolean | void) | null = null;

  constructor(options: VpsMonitorOptions) {
    this.reader = options.reader ?? new LinuxReader();
    this.configPath = join(options.stateDir, "vps.json");
    this.alertsPath = join(options.stateDir, "vps-alerts.json");
    this.now = options.now ?? Date.now;
    this.sampleMs = options.sampleMs ?? SAMPLE_MS;
    this.startedAt = this.now();
    this.configValue = parseConfig(readJsonFile(this.configPath));
    this.told = new Map();
    const stored = readJsonFile(this.alertsPath);
    if (stored && typeof stored === "object") {
      for (const [id, entry] of Object.entries(stored as Record<string, { severity?: unknown; at?: unknown }>)) {
        if ((entry.severity === "warning" || entry.severity === "critical") && typeof entry.at === "number") this.told.set(id, { severity: entry.severity, at: entry.at });
      }
    }
  }

  start(): void {
    if (this.timer || !this.reader.supported()) return;
    this.sample();
    this.timer = setInterval(() => {
      try { this.sample(); } catch (error) { console.error(`vps status: ${error instanceof Error ? error.message : String(error)}`); }
    }, this.sampleMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  config(): VpsConfig {
    return this.configValue;
  }

  setConfig(value: unknown): VpsConfig {
    this.configValue = parseConfig(value);
    writeJsonPrivate(this.configPath, this.configValue);
    // the new thresholds judge the latest numbers at once
    if (this.reader.supported()) this.sample();
    return this.configValue;
  }

  /** The latest numbers; measured now when none were taken yet. */
  status(): VpsStatus {
    if (!this.latest) {
      if (!this.reader.supported()) return this.unsupported();
      this.sample();
    }
    return this.latest!;
  }

  /** CPU use of one process over the last sample, percent of one core. */
  cpuOf(pid: number, startTicks: number): number {
    return this.processCpu.get(`${pid}:${startTicks}`) ?? 0;
  }

  private unsupported(): VpsStatus {
    return {
      supported: false, hostname: osHostname(), sampled_at: this.now(), uptime_seconds: 0,
      cpu: { cores: 0, usage_percent: 0, average_percent: 0, load: [0, 0, 0] },
      memory: { total_bytes: 0, available_bytes: 0, used_percent: 0 },
      swap: { total_bytes: 0, used_bytes: 0, used_percent: 0 },
      disks: [], top: [], issues: [], severity: "ok", config: this.configValue,
    };
  }

  /** Measures once, judges the issues and tells what is news. */
  sample(): VpsStatus {
    const reader = this.reader;
    const at = this.now();
    const cpu = reader.cpuTimes();
    const rows = reader.processes();
    const ticks = new Map<string, number>();
    for (const row of rows) ticks.set(`${row.pid}:${row.start_ticks}`, row.ticks);

    let usage = 0;
    const cpuNow = new Map<string, number>();
    if (this.previous) {
      const total = cpu.total - this.previous.cpu.total;
      const idle = cpu.idle - this.previous.cpu.idle;
      usage = total > 0 ? percent(total - idle, total) : 0;
      const seconds = (at - this.previous.at) / 1000;
      if (seconds > 0) {
        for (const [key, value] of ticks) {
          const before = this.previous.ticks.get(key);
          if (before !== undefined) cpuNow.set(key, Math.round(((value - before) / CLK_TCK / seconds) * 1000) / 10);
        }
      }
      this.cpuHistory.push({ at, usage });
    }
    this.processCpu = cpuNow;
    this.previous = { at, cpu, ticks };
    this.cpuHistory = this.cpuHistory.filter((entry) => at - entry.at <= CPU_WINDOW_MS);
    const average = this.cpuHistory.length
      ? Math.round((this.cpuHistory.reduce((sum, entry) => sum + entry.usage, 0) / this.cpuHistory.length) * 10) / 10
      : usage;

    const mem = reader.memInfo();
    const memory = { total_bytes: mem.total_bytes, available_bytes: mem.available_bytes, used_percent: percent(mem.total_bytes - mem.available_bytes, mem.total_bytes) };
    const swapUsed = mem.swap_total_bytes - mem.swap_free_bytes;
    const swap = { total_bytes: mem.swap_total_bytes, used_bytes: swapUsed, used_percent: percent(swapUsed, mem.swap_total_bytes) };
    const cpuStatus = { cores: reader.cores(), usage_percent: usage, average_percent: average, load: reader.load() };
    const disks = reader.disks();

    const issues = evaluateIssues(
      { disks, memory, swap, cpu: cpuStatus, cpuJudged: at - this.startedAt >= CPU_WINDOW_MS - this.sampleMs },
      this.configValue.thresholds, this.issues, at,
    );
    this.issues = new Map(issues.map((issue) => [issue.id, issue]));

    const own = reader.ownUid();
    const pick = (row: ProcessRow): VpsProcess => ({
      pid: row.pid,
      user: reader.userName(row.uid),
      name: row.name,
      command: reader.command(row.pid) || `[${row.name}]`,
      cpu_percent: cpuNow.get(`${row.pid}:${row.start_ticks}`) ?? 0,
      rss_bytes: row.rss_bytes,
      own: row.uid === own,
      start_ticks: row.start_ticks,
    });
    // before a second read nothing has a CPU figure: the memory list alone speaks then
    const byCpu = rows.filter((row) => (cpuNow.get(`${row.pid}:${row.start_ticks}`) ?? 0) > 0)
      .sort((a, b) => (cpuNow.get(`${b.pid}:${b.start_ticks}`) ?? 0) - (cpuNow.get(`${a.pid}:${a.start_ticks}`) ?? 0)).slice(0, TOP_EACH);
    const byMemory = [...rows].sort((a, b) => b.rss_bytes - a.rss_bytes).slice(0, TOP_EACH);
    const top = [...new Map([...byCpu, ...byMemory].map((row) => [row.pid, row])).values()].map(pick);

    const severity: VpsSeverity = issues.some((issue) => issue.severity === "critical") ? "critical" : issues.length ? "warning" : "ok";
    this.latest = {
      supported: true, hostname: osHostname(), sampled_at: at, uptime_seconds: reader.uptime(),
      cpu: cpuStatus, memory, swap, disks, top, issues, severity, config: this.configValue,
    };
    this.tell(issues, at);
    return this.latest;
  }

  private tell(issues: VpsIssue[], at: number): void {
    let changed = false;
    const present = new Set(issues.map((issue) => issue.id));
    for (const id of [...this.told.keys()]) {
      if (!present.has(id)) { this.told.delete(id); changed = true; }
    }
    for (const issue of issues) {
      const told = this.told.get(issue.id);
      // a lower level keeps the record of the higher one: going back up is not news again
      if (told && RANK[issue.severity] < RANK[told.severity] && at - told.at < REMIND_MS) continue;
      if (!shouldAlert(issue, told, at)) continue;
      // with alerts off an issue still counts as told, so turning them on does not replay it
      if (this.configValue.alerts && this.onAlert && this.latest) {
        let heard = true;
        try { heard = this.onAlert(issue, this.latest) !== false; } catch (error) { console.error(`vps alert: ${error instanceof Error ? error.message : String(error)}`); }
        if (!heard) continue;
      }
      this.told.set(issue.id, { severity: issue.severity, at });
      changed = true;
    }
    if (changed) {
      try { writeJsonPrivate(this.alertsPath, Object.fromEntries(this.told)); } catch (error) { console.error(`vps alerts: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
}
