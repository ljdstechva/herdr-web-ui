import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CabinetPreview, CabinetStatus } from "../shared/vps.ts";
import { DEVICE_COOKIE, forgetAuthAttempts } from "./auth.ts";
import { fakeCabinet, type FakeCabinet } from "./cabinet.fake.ts";
import { CabinetTidy } from "./cabinet.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import { VpsMonitor, type VpsReader } from "./vps.ts";

const TOKEN = "cabinet-api-fixture";

const fixtures: { root: string; fake: FakeCabinet; server: ReturnType<typeof createServer>; monitor: VpsMonitor }[] = [];
afterEach(async () => {
  for (const { root, fake, server, monitor } of fixtures.splice(0)) {
    server.stop();
    monitor.stop();
    // let go of a stand-in still waiting, and see it gone, before its folder goes
    fake.releaseAll();
    let pid: number | null = null;
    try { pid = (JSON.parse(readFileSync(join(root, "state", "cabinet-tidy.json"), "utf8")) as { pid: number | null }).pid; } catch { /* no run was started */ }
    const deadline = Date.now() + 8000;
    while (pid && Date.now() < deadline) { try { process.kill(pid, 0); await Bun.sleep(20); } catch { pid = null; } }
    rmSync(root, { recursive: true, force: true });
  }
  forgetAuthAttempts();
});

/** The app's server with VPS status on and a stand-in cabinet program (cabinet.fake.ts); `vps: false` leaves VPS status off. */
function fixture(options: { vps?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "herdr-cabinet-api-"));
  const stateDir = join(root, "state");
  const fake = fakeCabinet(root);
  const reader: VpsReader = {
    supported: () => true, cpuTimes: () => ({ total: 100, idle: 90 }), cores: () => 2,
    memInfo: () => ({ total_bytes: 100, available_bytes: 80, swap_total_bytes: 0, swap_free_bytes: 0 }),
    load: () => [0, 0, 0], uptime: () => 123, disks: () => [], processes: () => [], command: () => null,
    ownUid: () => (process.getuid?.() ?? 0), userName: () => "fixture",
  };
  const monitor = new VpsMonitor({ stateDir, reader });
  const store = new DeviceStore(stateDir);
  const watcher = store.pair(store.startPairing().code, "Fixture watcher", "watch")!;
  const server = createServer({
    port: 0, hostname: "127.0.0.1", stateDir, token: TOKEN, tailscaleOwner: null, tailscaleServeOnly: false, machines: false,
    ...(options.vps === false ? {} : { vps: monitor, cabinet: new CabinetTidy({ stateDir, bin: fake.bin, cabinetState: join(root, "cabinet-state.json") }) }),
  });
  fixtures.push({ root, fake, server, monitor });
  const base = `http://127.0.0.1:${server.port}`;
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, origin: base, "x-herdr-vps": "1" };
  const get = (path = "", override?: Record<string, string>) => fetch(`${base}/api/vps/cabinet${path}`, { headers: override ?? headers });
  const post = (path: string, override?: Record<string, string>, body?: string) => fetch(`${base}/api/vps/cabinet${path}`, { method: "POST", headers: override ?? headers, ...(body === undefined ? {} : { body }) });
  const status = async (): Promise<CabinetStatus> => await (await get()).json() as CabinetStatus;
  const ended = async (): Promise<CabinetStatus> => {
    const deadline = Date.now() + 8000;
    for (;;) {
      const now = await status();
      if (now.run && now.run.state !== "running") return now;
      if (Date.now() > deadline) throw new Error("timed out waiting for the run to end");
      await Bun.sleep(20);
    }
  };
  return { root, fake, base, headers, watch: { cookie: `${DEVICE_COOKIE}=${watcher.token}`, origin: base, "x-herdr-vps": "1" }, get, post, status, ended };
}

async function refused(response: Response, status: number, code: string): Promise<string> {
  expect(response.status).toBe(status);
  const body = await response.json() as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  return body.error.message;
}

/** "Move unused files to Drive" at the HTTP seam, with a stand-in for the cabinet program. No herdr, and never the real cabinet. */
describe.skipIf(process.platform === "win32")("cabinet routes", () => {
  it("previews, starts one run, says it is running, and gives its result", async () => {
    const f = fixture();
    expect(await f.status()).toMatchObject({ available: true, run: null });

    const preview = await f.post("/preview");
    expect(preview.status).toBe(200);
    expect(await preview.json() as CabinetPreview).toMatchObject({ folders: 3, bytes: 1_500, waiting: 1, free_gb: 37.1, idle_days: 1, items: [{ path: "/opt/workstation/b/large", bytes: 1_000 }, { path: "/opt/workstation/c/middle" }, { path: "/opt/workstation/a/small" }] });
    expect(f.fake.calls()).toEqual(["tidy --dry-run --json"]);

    const release = f.fake.hold("real");
    const started = await f.post("/tidy");
    expect(started.status).toBe(202);
    const run = (await started.json() as CabinetStatus).run!;
    expect(run).toMatchObject({ state: "running", result: null, finished_at: null });
    // the answer names no process
    expect(Object.keys(run).sort()).toEqual(["finished_at", "id", "message", "result", "started_at", "state"]);
    // one at a time, for a second start and for a preview alike
    expect(await refused(await f.post("/tidy"), 409, "tidy_running")).toBe("Files are being moved to Drive now.");
    await refused(await f.post("/preview"), 409, "tidy_running");
    expect((await f.status()).run).toMatchObject({ id: run.id, state: "running" });

    release();
    expect((await f.ended()).run).toMatchObject({ id: run.id, state: "done", result: { ok: true, moved: 3, bytes: 123_456_789, free_before_gb: 37.1, free_after_gb: 41.2, seconds: 95 } });
    expect(f.fake.calls()).toEqual(["tidy --dry-run --json", "tidy --json"]);
  });

  it("runs the fixed command whatever the request carries", async () => {
    const f = fixture();
    const json = { ...f.headers, "content-type": "application/json" };
    const smuggled = JSON.stringify({ args: ["--force", "--idle-days", "0"], path: "/", dry_run: false, bin: "/bin/rm" });
    expect((await f.post("/preview?args=--force&path=/etc", json, smuggled)).status).toBe(200);
    expect((await f.post("/tidy?args=--force&dry_run=0", json, smuggled)).status).toBe(202);
    await f.ended();
    // a body that is not JSON is not read either
    expect((await f.post("/preview", f.headers, "; rm -rf / #")).status).toBe(200);
    expect(f.fake.calls()).toEqual(["tidy --dry-run --json", "tidy --json", "tidy --dry-run --json"]);
  });

  it("is behind the app's sign-in, its own header and its origin, and closed to a watching device", async () => {
    const f = fixture();
    await refused(await f.get("", {}), 401, "unauthorized");
    await refused(await f.post("/preview", { origin: f.base, "x-herdr-vps": "1" }), 401, "unauthorized");
    await refused(await f.post("/tidy", { origin: f.base, "x-herdr-vps": "1" }), 401, "unauthorized");
    await refused(await f.post("/tidy", { authorization: "Bearer wrong", origin: f.base, "x-herdr-vps": "1" }), 401, "unauthorized");
    for (const path of ["/preview", "/tidy"]) {
      await refused(await f.post(path, { authorization: f.headers["authorization"]!, origin: f.base }), 403, "missing_header");
      await refused(await f.post(path, { ...f.headers, origin: "https://elsewhere.invalid" }), 403, "invalid_origin");
      await refused(await f.post(path, { ...f.headers, "sec-fetch-site": "cross-site" }), 403, "invalid_origin");
      await refused(await f.post(path, f.watch), 403, "read_only");
    }
    // a run's result names work folders: a watching device does not read it either, while the server's numbers stay open to it
    await refused(await f.get("", f.watch), 403, "read_only");
    expect((await fetch(`${f.base}/api/vps/status`, { headers: f.watch })).status).toBe(200);
    // the run is started with POST alone
    await refused(await f.get("/tidy"), 404, "not_found");
    await refused(await f.get("/preview"), 404, "not_found");
    expect(f.fake.calls()).toEqual([]);
    expect((await f.status()).run).toBeNull();
  });

  it("answers in words when cabinet is busy, silent or absent", async () => {
    const f = fixture();
    f.fake.stage("dry", { ok: false, busy: true, message: "cabinet sync is running (pid 7)" }, 3);
    expect(await refused(await f.post("/preview"), 409, "cabinet_busy")).toBe("cabinet sync is running (pid 7)");
    f.fake.stage("dry", "not json at all\n", 0);
    await refused(await f.post("/preview"), 502, "bad_output");

    f.fake.stage("real", { ok: false, busy: true, message: "cabinet sync is running (pid 7)" }, 3);
    expect((await f.post("/tidy")).status).toBe(202);
    expect((await f.ended()).run).toMatchObject({ state: "busy", result: null, message: "cabinet sync is running (pid 7)" });

    // no VPS status on this server: nothing of it is offered
    const off = fixture({ vps: false });
    await refused(await off.get(), 404, "not_available");
    await refused(await off.post("/tidy"), 404, "not_available");
    expect(off.fake.calls()).toEqual([]);
  });

  it("says so where the server has no cabinet program", async () => {
    const f = fixture();
    rmSync(f.fake.bin);
    expect(await f.status()).toMatchObject({ available: false, run: null });
    await refused(await f.post("/preview"), 404, "cabinet_missing");
    await refused(await f.post("/tidy"), 404, "cabinet_missing");
  });
});
