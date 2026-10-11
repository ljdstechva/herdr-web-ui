import { afterEach, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile, utimes, rename, symlink, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { SCAN_TTL_MS, VpsDoctor, type DoctorContext } from "./vps-doctor.ts";
import { VpsMonitor, type VpsReader } from "./vps.ts";
import type { run } from "./vps-command.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

async function fixture(extra: Partial<DoctorContext> = {}) {
  const dir = await mkdtemp("/tmp/vps-doctor-"); dirs.push(dir);
  const reader: VpsReader = {
    supported: () => true, cpuTimes: () => ({ total: 100, idle: 90 }), cores: () => 1,
    memInfo: () => ({ total_bytes: 100, available_bytes: 90, swap_total_bytes: 0, swap_free_bytes: 0 }),
    load: () => [0, 0, 0], uptime: () => 1, disks: () => [], processes: () => [], command: () => null,
    userName: () => "fixture", ownUid: () => process.getuid!(),
  };
  const monitor = new VpsMonitor({ stateDir: dir, reader });
  const command: typeof run = async () => ({ code: 0, stdout: "", stderr: "" });
  const doctor = new VpsDoctor({ monitor, stateDir: dir, home: dir, codexHome: join(dir, ".codex"), systemRoot: join(dir, "system"), command, launchAgent: async () => { throw new Error("No agents in tests"); }, ...extra });
  const sessions = join(dir, ".codex", "sessions"); await mkdir(sessions, { recursive: true });
  const file = join(sessions, "old.jsonl"); await writeFile(file, "fixture history"); await utimes(file, 1, 1);
  return { dir, doctor, file, sessions, reader, monitor };
}

it("joins equivalent scans, conflicts on another age and on scan/clean overlap", async () => {
  const entered = deferred(); const release = deferred();
  const { doctor } = await fixture({ command: async () => { entered.resolve(); await release.promise; return { code: 0, stdout: "", stderr: "" }; } });
  const first = doctor.scanDisk(30);
  expect(doctor.scanDisk(30)).toBe(first);
  await entered.promise;
  await expect(doctor.scanDisk(60)).rejects.toMatchObject({ code: "doctor_busy" });
  await expect(doctor.cleanDisk("unknown", ["x"])).rejects.toMatchObject({ code: "doctor_busy" });
  release.resolve();
  const scan = await first;
  expect(scan.older_than_days).toBe(30);
  expect(scan.candidates.find((item) => item.id === "codex-history")?.bytes).toBe(15);
});

it("claims plans before awaiting, joins duplicate cleans, and expires plans without another scan", async () => {
  let now = Date.now();
  const { doctor, file } = await fixture({ now: () => now });
  const scan = await doctor.scanDisk(30);
  const clean = doctor.cleanDisk(scan.scan_id, ["codex-history", "codex-history"]);
  expect(doctor.cleanDisk(scan.scan_id, ["codex-history"])).toBe(clean);
  await expect(doctor.cleanDisk(scan.scan_id, ["another"])).rejects.toMatchObject({ code: "doctor_busy" });
  await expect(doctor.scanDisk(30)).rejects.toMatchObject({ code: "doctor_busy" });
  expect((await clean).results).toMatchObject([{ id: "codex-history", ok: true }]);
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(file, "new content");
  expect((await doctor.cleanDisk(scan.scan_id, ["codex-history"])).results[0]?.ok).toBe(false);
  expect((await lstat(file)).size).toBe(11);
  const next = await doctor.scanDisk(30);
  now += SCAN_TTL_MS;
  await expect(doctor.cleanDisk(next.scan_id, ["codex-history"])).rejects.toMatchObject({ code: "scan_expired" });
});

for (const change of ["leaf-link", "parent-link", "replaced-root", "modified", "missing"] as const) {
  it(`keeps a planned history file after ${change}`, async () => {
    const { doctor, file, sessions, dir } = await fixture();
    const scan = await doctor.scanDisk(30);
    const outside = join(dir, "kept"); await writeFile(outside, "keep");
    if (change === "leaf-link") { await rm(file); await symlink(outside, file); }
    if (change === "parent-link") { await rename(sessions, `${sessions}-moved`); await symlink(`${sessions}-moved`, sessions); }
    if (change === "replaced-root") { await rename(sessions, `${sessions}-moved`); await mkdir(sessions); await writeFile(file, "replacement"); }
    if (change === "modified") await writeFile(file, "replacement");
    if (change === "missing") await rm(file);
    expect((await doctor.cleanDisk(scan.scan_id, ["codex-history"])).results[0]?.ok).toBe(false);
    expect((await lstat(outside)).size).toBe(4);
    if (change !== "missing") expect(await lstat(file)).toBeDefined();
  });
}

it("checks nested content before deleting a whole cache and can clean an unchanged tree", async () => {
  const { doctor, dir } = await fixture();
  const cache = join(dir, ".cache", "pip"); await mkdir(join(cache, "nested"), { recursive: true });
  const file = join(cache, "nested", "item"); await writeFile(file, "old");
  const scan = await doctor.scanDisk(30);
  await writeFile(file, "changed");
  expect((await doctor.cleanDisk(scan.scan_id, ["package-caches"])).results[0]?.ok).toBe(false);
  const next = await doctor.scanDisk(30);
  expect((await doctor.cleanDisk(next.scan_id, ["package-caches"])).results[0]?.ok).toBe(true);
  await expect(lstat(cache)).rejects.toMatchObject({ code: "ENOENT" });
});

it("holds the flight until deadline cancellation has settled and retains only previous completed plans", async () => {
  let block = false; const aborted = deferred(); const reaped = deferred();
  const { doctor } = await fixture({ scanTimeoutMs: 100, command: async (_argv, _timeout, signal) => {
    if (block) {
      await new Promise<void>((done) => { if (signal!.aborted) done(); else signal!.addEventListener("abort", () => done(), { once: true }); });
      aborted.resolve(); await reaped.promise;
      return { code: null, stdout: "999\tpartial", stderr: "", timedOut: true };
    }
    return { code: 0, stdout: "", stderr: "" };
  } });
  const good = await doctor.scanDisk(30);
  block = true;
  const timed = doctor.scanDisk(60);
  const rejection = timed.then(() => null, (error: unknown) => error);
  await aborted.promise;
  expect(doctor.scanDisk(60)).toBe(timed);
  await expect(doctor.cleanDisk(good.scan_id, ["codex-history"])).rejects.toMatchObject({ code: "doctor_busy" });
  reaped.resolve(); expect(await rejection).toMatchObject({ code: "scan_timeout" });
  block = false;
  expect((await doctor.cleanDisk(good.scan_id, ["codex-history"])).results[0]?.ok).toBe(true);
});

it("bounds the Claude history loop and rejects a partial plan", async () => {
  const { doctor, dir } = await fixture({ scanEntryLimit: 20 });
  const project = join(dir, ".claude", "projects", "fixture"); await mkdir(project, { recursive: true });
  for (let i = 0; i < 40; i++) { const file = join(project, `${i}.jsonl`); await writeFile(file, "x"); await utimes(file, 1, 1); }
  await expect(doctor.scanDisk(30)).rejects.toMatchObject({ code: "scan_limit" });
});

it("revalidates privileged file plans and never issues rm for a replacement", async () => {
  const calls: string[][] = [];
  let large = "";
  const { doctor, reader, file } = await fixture({ command: async (argv) => { calls.push(argv); return { code: 0, stdout: argv.includes("find") ? `300000000\t${large}\n` : "", stderr: "" }; } });
  // Ensure the fake system find has a root; no host directories or real commands are used.
  const dir = dirs.at(-1)!; await mkdir(join(dir, "system", "tmp"), { recursive: true });
  reader.ownUid = () => -1; large = file;
  const scan = await doctor.scanDisk(30);
  expect(scan.candidates.find((item) => item.id === "file:0")?.root).toBe(true);
  await rename(file, `${file}.kept`); await writeFile(file, "replacement");
  expect((await doctor.cleanDisk(scan.scan_id, ["file:0"])).results[0]?.ok).toBe(false);
  expect(calls.some((argv) => argv.includes("rm"))).toBe(false);
});
