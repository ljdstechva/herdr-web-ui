import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_VPS_THRESHOLDS, type VpsDisk, type VpsIssue } from "../shared/vps.ts";
import { parseDockerSize, parseJournalUsage, VpsDoctor } from "./vps-doctor.ts";
import { CPU_WINDOW_MS, evaluateIssues, levelOf, parseConfig, parseKernelOom, REMIND_MS, shouldAlert, vpsAlertMessage, vpsResolvedMessage, VpsMonitor, type MemInfo, type ProcessRow, type VpsReader } from "./vps.ts";

const GB = 1024 ** 3;

function disk(usedPercent: number, mount = "/"): VpsDisk {
  const total = 100 * GB;
  const used = (usedPercent / 100) * total;
  return { mount, device: "/dev/sda1", fs_type: "ext4", total_bytes: total, used_bytes: used, available_bytes: total - used, used_percent: usedPercent };
}

const calm = {
  memory: { total_bytes: 8 * GB, available_bytes: 4 * GB, used_percent: 50 },
  swap: { total_bytes: 4 * GB, used_bytes: 0, used_percent: 0 },
  cpu: { cores: 2, usage_percent: 10, average_percent: 10, load: [0.1, 0.1, 0.1] as [number, number, number] },
  cpuJudged: true,
};

it("holds a level within the hysteresis band and lets it go below", () => {
  expect(levelOf(84, 85, 93, undefined)).toBeNull();
  expect(levelOf(85, 85, 93, undefined)).toBe("warning");
  expect(levelOf(93, 85, 93, undefined)).toBe("critical");
  // a critical disk that dips just under the line stays critical; further down it is a warning
  expect(levelOf(91.5, 85, 93, "critical")).toBe("critical");
  expect(levelOf(90, 85, 93, "critical")).toBe("warning");
  // a warning on the line does not flap off and on
  expect(levelOf(84, 85, 93, "warning")).toBe("warning");
  expect(levelOf(82.9, 85, 93, "warning")).toBeNull();
});

it("names a full disk, short memory, busy swap and a busy CPU as issues", () => {
  const issues = evaluateIssues({
    ...calm,
    disks: [disk(92), disk(20, "/boot")],
    memory: { total_bytes: 8 * GB, available_bytes: 0.4 * GB, used_percent: 95 },
    swap: { total_bytes: 4 * GB, used_bytes: 3 * GB, used_percent: 75 },
    cpu: { ...calm.cpu, average_percent: 97 },
  }, DEFAULT_VPS_THRESHOLDS, new Map(), 1000);
  expect(issues.map((issue) => [issue.id, issue.severity])).toEqual([
    ["cpu", "critical"], ["memory", "critical"], ["disk:/", "warning"], ["swap", "warning"],
  ]);
  expect(issues.find((issue) => issue.id === "disk:/")?.title).toBe("Disk / is 92% full");
});

it("keeps when an issue began and does not judge the CPU before a full window", () => {
  const first = evaluateIssues({ ...calm, disks: [disk(90)] }, DEFAULT_VPS_THRESHOLDS, new Map(), 1000);
  const later = evaluateIssues({ ...calm, disks: [disk(91)] }, DEFAULT_VPS_THRESHOLDS, new Map(first.map((issue) => [issue.id, issue])), 5000);
  expect(later[0]?.since).toBe(1000);
  const young = evaluateIssues({ ...calm, disks: [], cpu: { ...calm.cpu, average_percent: 99 }, cpuJudged: false }, DEFAULT_VPS_THRESHOLDS, new Map(), 1000);
  expect(young).toEqual([]);
});

it("tells an issue when it is new, worse, or untold for the reminder time", () => {
  const issue: VpsIssue = { id: "disk:/", kind: "disk", severity: "warning", title: "", detail: "", since: 0 };
  expect(shouldAlert(issue, undefined, 0)).toBe(true);
  expect(shouldAlert(issue, { severity: "warning", at: 0 }, 1000)).toBe(false);
  expect(shouldAlert({ ...issue, severity: "critical" }, { severity: "warning", at: 0 }, 1000)).toBe(true);
  expect(shouldAlert(issue, { severity: "warning", at: 0 }, REMIND_MS)).toBe(true);
});

it("keeps thresholds between 1 and 100, a warning never above its critical", () => {
  expect(parseConfig(undefined)).toEqual({ alerts: true, thresholds: DEFAULT_VPS_THRESHOLDS });
  const parsed = parseConfig({ alerts: false, thresholds: { disk_warning: 99, disk_critical: 90, cpu_warning: -5, memory_critical: "x", swap_warning: 250 } });
  expect(parsed.alerts).toBe(false);
  expect(parsed.thresholds.disk_warning).toBe(90);
  expect(parsed.thresholds.disk_critical).toBe(90);
  expect(parsed.thresholds.cpu_warning).toBe(1);
  expect(parsed.thresholds.memory_critical).toBe(DEFAULT_VPS_THRESHOLDS.memory_critical);
  expect(parsed.thresholds.swap_warning).toBe(DEFAULT_VPS_THRESHOLDS.swap_critical);
});

it("gives each issue its own notification slot, tagged for the VPS dialog", () => {
  const message = vpsAlertMessage({ id: "disk:/", kind: "disk", severity: "critical", title: "Disk / is 95% full", detail: "5 GB free of 100 GB", since: 0 }, "srv");
  expect(message).toEqual({ pane_id: null, title: "srv: Disk / is 95% full", body: "5 GB free of 100 GB. Open VPS status in herdr web ui to run the Doctor.", tag: "herdr-vps-disk:/" });
});

it("reads the sizes docker and journalctl print", () => {
  expect(parseDockerSize("502.4MB")).toBe(502_400_000);
  expect(parseDockerSize("1.5GB")).toBe(1_500_000_000);
  expect(parseDockerSize("0B")).toBe(0);
  expect(parseDockerSize("nonsense")).toBe(0);
  expect(parseJournalUsage("Archived and active journals take up 169.7M in the file system.")).toBe(Math.round(169.7 * 1024 ** 2));
  expect(parseJournalUsage("")).toBe(0);
});

/** A PC whose numbers the test sets. */
class FakeReader implements VpsReader {
  usedDisk = 50;
  memory: MemInfo = { total_bytes: 8 * GB, available_bytes: 4 * GB, swap_total_bytes: 0, swap_free_bytes: 0 };
  ticks = 0;
  supported(): boolean { return true; }
  cpuTimes() { this.ticks += 100; return { total: this.ticks, idle: this.ticks / 2 }; }
  cores(): number { return 2; }
  memInfo(): MemInfo { return this.memory; }
  load(): [number, number, number] { return [0, 0, 0]; }
  uptime(): number { return 100; }
  disks(): VpsDisk[] { return [disk(this.usedDisk)]; }
  processes(): ProcessRow[] { return [{ pid: 10, ppid: 1, uid: 1000, name: "worker", ticks: this.ticks, start_ticks: 5, rss_bytes: GB }]; }
  command(): string { return "worker --run"; }
  userName(): string { return "me"; }
  ownUid(): number { return 1000; }
}

it("alerts once per issue, again when it gets worse, and remembers across a restart", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vps-"));
  let now = 0;
  const reader = new FakeReader();
  const alerts: string[] = [];
  const monitor = new VpsMonitor({ stateDir, reader, now: () => now });
  monitor.onAlert = (issue) => { alerts.push(`${issue.id}:${issue.severity}`); };
  monitor.sample();
  expect(alerts).toEqual([]);
  reader.usedDisk = 88;
  now += 15_000; monitor.sample();
  now += 15_000; monitor.sample();
  expect(alerts).toEqual(["disk:/:warning"]);
  reader.usedDisk = 95;
  now += 15_000; monitor.sample();
  expect(alerts).toEqual(["disk:/:warning", "disk:/:critical"]);
  // back to a warning is not news
  reader.usedDisk = 89;
  now += 15_000; monitor.sample();
  expect(alerts.length).toBe(2);
  expect(JSON.parse(readFileSync(join(stateDir, "vps-alerts.json"), "utf8"))["disk:/"].severity).toBe("critical");

  // a new server (an app update) does not repeat a standing alert
  const restarted = new VpsMonitor({ stateDir, reader, now: () => now });
  const after: string[] = [];
  restarted.onAlert = (issue) => { after.push(issue.id); };
  restarted.sample();
  expect(after).toEqual([]);

  // gone, then back: news again
  reader.usedDisk = 50;
  now += 15_000; restarted.sample();
  reader.usedDisk = 90;
  now += 15_000; restarted.sample();
  expect(after).toEqual(["disk:/"]);
});

it("keeps an alert nobody could hear as news until a device subscribes", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vps-"));
  let now = 0;
  const reader = new FakeReader();
  reader.usedDisk = 90;
  const monitor = new VpsMonitor({ stateDir, reader, now: () => now });
  let subscribed = false;
  const heard: string[] = [];
  monitor.onAlert = (issue) => { if (!subscribed) return false; heard.push(issue.id); return true; };
  monitor.sample();
  now += 15_000; monitor.sample();
  expect(heard).toEqual([]);
  subscribed = true;
  now += 15_000; monitor.sample();
  now += 15_000; monitor.sample();
  expect(heard).toEqual(["disk:/"]);
});

it("sends nothing while alerts are off, and judges the CPU only after a full window", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vps-"));
  let now = 0;
  const reader = new FakeReader();
  const monitor = new VpsMonitor({ stateDir, reader, now: () => now });
  const alerts: string[] = [];
  monitor.onAlert = (issue) => { alerts.push(issue.id); };
  monitor.setConfig({ alerts: false });
  reader.usedDisk = 99;
  now += 15_000; monitor.sample();
  expect(alerts).toEqual([]);
  expect(monitor.status().issues.map((issue) => issue.id)).toEqual(["disk:/"]);
  // half the ticks are idle in the fake: 50% busy, no CPU issue at any age
  now += CPU_WINDOW_MS; monitor.sample();
  expect(monitor.status().cpu.average_percent).toBe(50);
  expect(monitor.status().issues.some((issue) => issue.id === "cpu")).toBe(false);
});

it("writes the Doctor's brief with the numbers, the ask-first rules and the owner's notes", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vps-"));
  const reader = new FakeReader();
  reader.usedDisk = 94;
  const monitor = new VpsMonitor({ stateDir, reader });
  const doctor = new VpsDoctor({ monitor, stateDir, home: stateDir, launchAgent: async () => ({ agent_started: true }) });
  const status = monitor.sample();
  const brief = doctor.brief(status, status.issues[0] ?? null, "keep the client folders", true);
  expect(brief).toContain("**Disk / is 94% full** (critical)");
  expect(brief).toContain("keep the client folders");
  expect(brief).toContain("Ask the user which to do and wait for the answer.");
  expect(brief).toContain("sudo works without a password here");
});

it("judges inodes with disk thresholds and keeps hysteresis and unknown measurements", () => {
  const input = { ...calm, disks: [{ ...disk(20), files: 100, ffree: 5 }] };
  const first = evaluateIssues(input, DEFAULT_VPS_THRESHOLDS, new Map(), 1);
  expect(first).toMatchObject([{ id: "inodes:/", kind: "disk", severity: "critical" }]);
  const previous = new Map(first.map((issue) => [issue.id, issue]));
  expect(evaluateIssues({ ...input, disks: [{ ...disk(20), files: 100, ffree: 8 }] }, DEFAULT_VPS_THRESHOLDS, previous, 2)[0]?.severity).toBe("critical");
  expect(evaluateIssues({ ...calm, disks: [disk(20)] }, DEFAULT_VPS_THRESHOLDS, previous, 3)).toEqual(first);
  expect(evaluateIssues({ ...calm, disks: [{ ...disk(20), files: 100, ffree: 50 }] }, DEFAULT_VPS_THRESHOLDS, previous, 4)).toEqual([]);
});

it("parses recent kernel OOM kills without treating missing or unreadable journals as healthy", () => {
  const now = Date.now();
  const row = (message: string, time = now) => JSON.stringify({ MESSAGE: message, __REALTIME_TIMESTAMP: String(time * 1000) });
  expect(parseKernelOom(row("Out of memory: Killed process 123 (fixture)"), now)).toBe(1);
  expect(parseKernelOom(row("Memory cgroup out of memory: Killed process 124 (fixture)", now - 86_400_000), now)).toBe(0);
  expect(parseKernelOom(row("kernel fixture"), now)).toBe(0);
  expect(parseKernelOom("", now)).toBeNull();
  expect(parseKernelOom("not json", now)).toBeNull();
});

it("retries a throwing alert callback and ignores malformed persisted entries", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vps-"));
  writeFileSync(join(stateDir, "vps-alerts.json"), JSON.stringify({ null: null, array: [], wrong: { severity: "critical", at: "bad" } }));
  const reader = new FakeReader(); reader.usedDisk = 95;
  const monitor = new VpsMonitor({ stateDir, reader });
  let calls = 0;
  monitor.onAlert = () => { calls++; if (calls === 1) throw new Error("fixture notification failure"); return true; };
  monitor.sample(); monitor.sample(); monitor.sample();
  expect(calls).toBe(2);
});

it("resolves once with the original tag after valid recovery, including restart and no-subscriber retry", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vps-"));
  const reader = new FakeReader(); reader.usedDisk = 95;
  const first = new VpsMonitor({ stateDir, reader });
  first.onAlert = () => true; first.sample();
  const monitor = new VpsMonitor({ stateDir, reader });
  let subscribed = false;
  const resolved: string[] = [];
  monitor.onAlert = () => true;
  monitor.onResolved = (id) => { if (!subscribed) return false; resolved.push(id); return true; };
  const readDisks = reader.disks.bind(reader);
  reader.disks = () => [];
  monitor.sample(); expect(resolved).toEqual([]);
  reader.disks = readDisks;
  reader.usedDisk = 89; monitor.sample(); // downgrade is not recovery
  reader.usedDisk = 94; monitor.sample();
  reader.usedDisk = 50; monitor.sample();
  expect(resolved).toEqual([]);
  subscribed = true;
  monitor.sample(); monitor.sample();
  expect(resolved).toEqual(["disk:/"]);
  expect(vpsResolvedMessage("disk:/", "srv").tag).toBe("herdr-vps-disk:/");
  const restarted = new VpsMonitor({ stateDir, reader });
  restarted.onResolved = (id) => { resolved.push(id); return true; }; restarted.sample();
  expect(resolved).toHaveLength(1);
});

it("does not resolve unheard or disabled alerts, or replay an issue on enabling alerts", () => {
  for (const disabled of [true, false]) {
    const stateDir = mkdtempSync(join(tmpdir(), "vps-"));
    const reader = new FakeReader();
    const monitor = new VpsMonitor({ stateDir, reader });
    const resolved: string[] = []; const alerts: string[] = [];
    monitor.onAlert = (issue) => { if (!disabled) return false; alerts.push(issue.id); return true; };
    monitor.onResolved = (id) => { resolved.push(id); return true; };
    if (disabled) monitor.setConfig({ alerts: false });
    reader.usedDisk = 95; monitor.sample();
    if (disabled) monitor.setConfig({ alerts: true });
    expect(alerts).toEqual([]);
    reader.usedDisk = 50; monitor.sample();
    expect(resolved).toEqual([]);
  }
});

it("samples OOM evidence asynchronously and never recovers on a failed read", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vps-"));
  const reader: VpsReader = new FakeReader();
  let now = 0; let count: number | null = 2; let reads = 0;
  reader.oomKills = async () => { reads++; return count; };
  const monitor = new VpsMonitor({ stateDir, reader, now: () => now });
  const resolved: string[] = [];
  monitor.onAlert = () => true;
  monitor.onResolved = (id) => { resolved.push(id); return true; };
  await monitor.refreshOom();
  expect(monitor.sample().issues).toMatchObject([{ id: "memory:oom", kind: "memory" }]);
  monitor.sample(); expect(reads).toBe(1);
  count = null; now += 60_000; await monitor.refreshOom(); monitor.sample();
  expect(resolved).toEqual([]);
  expect(monitor.status().oom_kills).toBeNull();
  count = 0; now += 60_000; await monitor.refreshOom(); monitor.sample(); monitor.sample();
  expect(resolved).toEqual(["memory:oom"]);
  monitor.stop();
});

it("holds memory and CPU alerts on missing measurements and retries a throwing recovery", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vps-"));
  const reader = new FakeReader();
  reader.memory.available_bytes = 0;
  const monitor = new VpsMonitor({ stateDir, reader });
  monitor.onAlert = () => true;
  let attempts = 0;
  monitor.onResolved = () => { attempts++; if (attempts === 1) throw new Error("fixture recovery failure"); return true; };
  monitor.sample();
  reader.memory.total_bytes = 0;
  expect(monitor.sample().issues.map((issue) => issue.id)).toEqual(["memory"]);
  expect(attempts).toBe(0);
  reader.memory = { total_bytes: 8 * GB, available_bytes: 4 * GB, swap_total_bytes: 0, swap_free_bytes: 0 };
  monitor.sample(); monitor.sample(); monitor.sample(); expect(attempts).toBe(2);
  const previous = new Map<string, VpsIssue>([["cpu", { id: "cpu", kind: "cpu", severity: "critical", title: "CPU", detail: "busy", since: 1 }]]);
  expect(evaluateIssues({ ...calm, cpuJudged: false, disks: [] }, DEFAULT_VPS_THRESHOLDS, previous, 2)).toEqual([...previous.values()]);
});

it("reads the journal once under concurrent samples and aborts it on stop", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vps-"));
  const reader: VpsReader = new FakeReader();
  let calls = 0; let cancelled = false;
  reader.oomKills = (signal) => new Promise((resolve) => {
    calls++;
    const done = () => { cancelled = true; resolve(null); };
    if (signal!.aborted) done(); else signal!.addEventListener("abort", done, { once: true });
  });
  const monitor = new VpsMonitor({ stateDir, reader });
  const first = monitor.refreshOom();
  expect(monitor.refreshOom()).toBe(first);
  monitor.sample(); monitor.sample(); monitor.stop(); await first;
  expect(calls).toBe(1); expect(cancelled).toBe(true);
  expect(monitor.status().oom_kills).toBeNull();
});
