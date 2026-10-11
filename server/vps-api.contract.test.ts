/** Run explicitly with HERDR_TEST_MODE=unit: the existing preload selects a nonexistent socket. */
import "../scripts/test-herdr.ts";
import { afterEach, expect, it } from "bun:test";
import { realpath, mkdtemp, mkdir, writeFile, utimes, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEVICE_COOKIE, forgetAuthAttempts } from "./auth.ts";
import { DeviceStore } from "./devices.ts";
import { DoctorError, SCAN_TTL_MS, VpsDoctor, type DoctorContext } from "./vps-doctor.ts";
import { VpsMonitor, type VpsReader } from "./vps.ts";
import type { VpsServices } from "./vps-api.ts";

if (process.env["HERDR_TEST_MODE"] === "unit" && process.env["HERDR_SOCKET"] !== join(tmpdir(), "herdr-web-ui-unit-tests-have-no-herdr.sock")) throw new Error("VPS contracts require the isolated test preload before importing the server");
const { createServer } = await import("./index.ts");
const fixtures: { dir: string; server: ReturnType<typeof createServer>; monitor: VpsMonitor }[] = [];
afterEach(async () => {
  for (const { dir, server, monitor } of fixtures.splice(0)) { server.stop(); monitor.stop(); await rm(dir, { recursive: true, force: true }); }
  forgetAuthAttempts();
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

async function fixture(extra: Partial<DoctorContext> = {}, absent = false) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "vps-api-")));
  const reader: VpsReader = {
    supported: () => true, cpuTimes: () => ({ total: 100, idle: 90 }), cores: () => 2,
    memInfo: () => ({ total_bytes: 100, available_bytes: 80, swap_total_bytes: 0, swap_free_bytes: 0 }),
    load: () => [0, 0, 0], uptime: () => 123, disks: () => [], processes: () => [], command: () => null,
    ownUid: () => (process.getuid?.() ?? 0), userName: () => "fixture",
  };
  let now = Date.now();
  const monitor = new VpsMonitor({ stateDir: dir, reader, now: () => now });
  const doctor = new VpsDoctor({ monitor, stateDir: dir, home: dir, codexHome: join(dir, ".codex"), systemRoot: join(dir, "system"),
    now: () => now, command: async () => ({ code: 0, stdout: "", stderr: "" }), launchAgent: async () => { throw new Error("Real agents forbidden in VPS contracts"); }, ...extra });
  const calls: unknown[] = [];
  const services: VpsServices["doctor"] = {
    options: async () => ({ engines: [], root: false }),
    processes: async () => { const status = monitor.status(); return { processes: [], memory: status.memory, cpu: status.cpu, swap: status.swap }; },
    scanDisk: (days) => doctor.scanDisk(days), cleanDisk: (scan, ids) => doctor.cleanDisk(scan, ids),
    processAction: async (...args) => { calls.push(args); return { ok: true, message: "fixture only" }; },
    startAgent: async (request) => { calls.push(request); return { pane_id: "fixture-pane", workspace_id: "fixture-workspace", agent_started: true, brief_path: join(dir, "fixture.md") }; },
  };
  const store = new DeviceStore(dir);
  const paired = store.pair(store.startPairing().code, "Fixture watcher", "watch")!;
  const cookie = `${DEVICE_COOKIE}=${paired.token}`;
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: "vps-contract-fixture", tailscaleOwner: null, tailscaleServeOnly: false,
    machines: false, codexHome: join(dir, ".codex"), ...(absent ? {} : { vps: monitor, vpsDoctor: services }) });
  fixtures.push({ dir, server, monitor });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: "Bearer vps-contract-fixture", origin: base, "content-type": "application/json", "x-herdr-vps": "1" };
  const request = (path: string, body?: unknown, override?: HeadersInit) => fetch(`${base}/api/vps${path}`, { method: body === undefined ? "GET" : "POST", headers: override ?? headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const sessions = join(dir, ".codex", "sessions"); await mkdir(sessions, { recursive: true });
  const file = join(sessions, "fixture.jsonl"); await writeFile(file, "fixture history"); await utimes(file, 1, 1);
  return { dir, server, monitor, doctor, services, file, base, headers, cookie, calls, request, advance: (ms: number) => { now += ms; } };
}

async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code, message: expect.any(String) } });
}

it("serves status, config, options and processes through createServer without herdr", async () => {
  const f = await fixture();
  const status = await f.request("/status"); expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ supported: true, uptime_seconds: 123, memory: { available_bytes: 80 }, disks: [] });
  expect(await (await f.request("/config")).json()).toMatchObject({ alerts: true });
  expect(await (await f.request("/doctor/options")).json()).toEqual({ engines: [], root: false });
  expect(await (await f.request("/doctor/processes")).json()).toMatchObject({ processes: [] });
  expect(await (await f.request("/config", { alerts: false, thresholds: { disk_warning: 99, disk_critical: 90 } })).json()).toMatchObject({ alerts: false, thresholds: { disk_warning: 90, disk_critical: 90 } });
  expect((await f.request("/alert/test", {})).status).toBe(204); // no subscriptions; no push requests
  expect((await f.request("/doctor/process", { pid: 42, start_ticks: 100, action: "terminate" })).status).toBe(200);
  expect((await f.request("/doctor/agent", { engine: "codex", note: "fixture" })).status).toBe(200);
  expect(f.calls).toEqual([[42, 100, "terminate"], { engine: "codex", model: null, effort: null, issue_id: null, note: "fixture" }]);
});

it("enforces auth, custom header, origin and watch protections before Doctor calls", async () => {
  const f = await fixture();
  await error(await f.request("/status", undefined, {}), 401, "unauthorized");
  await error(await f.request("/doctor/disk/scan", {}, { ...f.headers, "x-herdr-vps": "0" }), 403, "missing_header");
  await error(await f.request("/config", {}, { ...f.headers, origin: "https://elsewhere.invalid" }), 403, "invalid_origin");
  await error(await f.request("/config", {}, { ...f.headers, "sec-fetch-site": "cross-site" }), 403, "invalid_origin");
  const watch = { cookie: f.cookie, origin: f.base, "x-herdr-vps": "1", "content-type": "application/json" };
  expect((await f.request("/status", undefined, watch)).status).toBe(200);
  for (const path of ["/config", "/alert/test", "/doctor/disk/scan", "/doctor/disk/clean", "/doctor/process", "/doctor/agent"]) {
    await error(await f.request(path, {}, watch), 403, "read_only");
  }
  await error(await f.request("/config", {}, { cookie: f.cookie, "x-herdr-vps": "1" }), 403, "invalid_origin");
  expect(f.calls).toEqual([]);
});

it("rejects malformed JSON, invalid shapes and unsafe numeric inputs", async () => {
  const f = await fixture();
  await error(await fetch(`${f.base}/api/vps/config`, { method: "POST", headers: f.headers, body: "{" }), 400, "invalid_json");
  for (const body of [null, [], "x"]) await error(await f.request("/config", body), 400, "invalid_body");
  for (const days of [0, -1, 1.5, 3651, "30", null]) await error(await f.request("/doctor/disk/scan", { older_than_days: days }), 400, "invalid_body");
  for (const body of [{}, { scan_id: "", ids: ["x"] }, { scan_id: "x", ids: [] }, { scan_id: "x", ids: [1] }, { scan_id: "x", ids: Array(101).fill("x") }]) await error(await f.request("/doctor/disk/clean", body), 400, "invalid_body");
  for (const body of [{}, { pid: -1, start_ticks: 0, action: "kill" }, { pid: 1.5, start_ticks: 0, action: "kill" }, { pid: 42, start_ticks: -1, action: "kill" }, { pid: 42, start_ticks: 0, action: "unknown" }]) await error(await f.request("/doctor/process", body), 400, "invalid_body");
  for (const body of [{}, { engine: "unknown" }, { engine: "codex", model: 5 }, { engine: "codex", effort: [] }, { engine: "codex", issue_id: {} }, { engine: "codex", note: false }]) await error(await f.request("/doctor/agent", body), 400, "invalid_body");
  expect(f.calls).toEqual([]);
});

it("joins scans of the same age and refuses a concurrent different age or clean", async () => {
  const entered = deferred(); const release = deferred();
  const f = await fixture({ command: async () => { entered.resolve(); await release.promise; return { code: 0, stdout: "", stderr: "" }; } });
  const first = f.request("/doctor/disk/scan", { older_than_days: 30 });
  await entered.promise;
  const same = f.request("/doctor/disk/scan", { older_than_days: 30 });
  await error(await f.request("/doctor/disk/scan", { older_than_days: 60 }), 409, "doctor_busy");
  await error(await f.request("/doctor/disk/clean", { scan_id: "anything", ids: ["codex-history"] }), 409, "doctor_busy");
  release.resolve();
  const a = await (await first).json() as { scan_id: string }; const b = await (await same).json() as { scan_id: string };
  expect(a.scan_id).toBe(b.scan_id);
});

it("joins clean double taps, refuses overlap, consumes plans and enforces expiry without rescanning", async () => {
  const f = await fixture();
  const scan = await (await f.request("/doctor/disk/scan", {})).json() as { scan_id: string };
  const entered = deferred(); const release = deferred();
  f.doctor.root = async () => { entered.resolve(); await release.promise; return false; };
  const body = { scan_id: scan.scan_id, ids: ["codex-history"] };
  const first = f.request("/doctor/disk/clean", body); await entered.promise;
  const same = f.request("/doctor/disk/clean", body);
  await error(await f.request("/doctor/disk/clean", { ...body, ids: ["x"] }), 409, "doctor_busy");
  await error(await f.request("/doctor/disk/scan", {}), 409, "doctor_busy");
  release.resolve();
  const a = await (await first).json(); const b = await (await same).json(); expect(a).toEqual(b);
  expect(a).toMatchObject({ results: [{ id: "codex-history", ok: true }] });
  await expect(lstat(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await (await f.request("/doctor/disk/clean", body)).json()).toMatchObject({ results: [{ ok: false }] });
  f.advance(SCAN_TTL_MS);
  await error(await f.request("/doctor/disk/clean", body), 409, "scan_expired");
});

it("returns deadline and Doctor errors with envelopes and sanitizes unexpected errors", async () => {
  const f = await fixture({ scanTimeoutMs: 20, command: async (_argv, _timeout, signal) => {
    await new Promise<void>((resolve) => { if (signal!.aborted) resolve(); else signal!.addEventListener("abort", () => resolve(), { once: true }); });
    return { code: null, stdout: "", stderr: "", timedOut: true };
  } });
  await error(await f.request("/doctor/disk/scan", {}), 408, "scan_timeout");
  await error(await f.request("/doctor/disk/clean", { scan_id: "unknown", ids: ["x"] }), 409, "scan_expired");
  f.services.options = async () => { throw new DoctorError("fixture_error", "fixture refusal", 409); };
  await error(await f.request("/doctor/options"), 409, "fixture_error");
  f.services.processes = async () => { throw new Error("private fixture error details"); };
  const failure = await f.request("/doctor/processes"); expect(failure.status).toBe(500);
  const payload = await failure.json(); expect(payload).toMatchObject({ error: { code: "internal_error" } });
  expect(JSON.stringify(payload)).not.toContain("private fixture error details");
  await error(await f.request("/unknown"), 404, "not_found");
});

it("returns not_available when no VPS monitor was supplied", async () => {
  const f = await fixture({}, true);
  for (const path of ["/status", "/config", "/doctor/options", "/doctor/processes"]) await error(await f.request(path), 404, "not_available");
  await error(await f.request("/doctor/disk/scan", {}), 404, "not_available");
});

it("defers the recovery callback while a page is active, without sending real push", async () => {
  const f = await fixture();
  // Valid subscription shape only; no push is sent in this test.
  await writeFile(join(f.dir, "push-subscriptions.json"), JSON.stringify([{ endpoint: "https://push.invalid/fixture",
    keys: { p256dh: Buffer.alloc(65).toString("base64url"), auth: Buffer.alloc(16).toString("base64url") } }]));
  // Bun accepts request headers; lib.dom's WebSocket constructor only types protocols.
  const Socket = globalThis.WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
  const ws = new Socket(`${f.base.replace("http:", "ws:")}/ws`, { headers: f.headers });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture presence was not acknowledged")), 2000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "presence", active: true }));
        ws.send(JSON.stringify({ type: "role", mode: "interact" }));
      };
      ws.onmessage = (event) => { if (JSON.parse(String(event.data)).type === "role-ack") { clearTimeout(timer); resolve(); } };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("Fixture websocket failed")); };
    });
    expect(f.monitor.onResolved!("disk:/", f.monitor.status())).toBe(false);
  } finally { ws.close(); }
});
