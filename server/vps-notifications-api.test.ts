import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VpsNotifications } from "../shared/vps.ts";
import { DEVICE_COOKIE, forgetAuthAttempts } from "./auth.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import { CabinetReports } from "./vps-notifications.ts";
import { VpsMonitor, type VpsReader } from "./vps.ts";

const TOKEN = "vps-notifications-fixture";

const fixtures: { root: string; server: ReturnType<typeof createServer>; monitor: VpsMonitor }[] = [];
afterEach(() => {
  for (const { root, server, monitor } of fixtures.splice(0)) {
    server.stop();
    monitor.stop();
    rmSync(root, { recursive: true, force: true });
  }
  forgetAuthAttempts();
});

function report(id: string, ts: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, kind: "alert", level: "info", ts, title: `Report ${id}`, lines: [`Line of ${id}.`], data: {}, ...over };
}

/** The app's server with VPS status on and a feed file of the test's own; `vps: false` leaves VPS status off. */
function fixture(options: { vps?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "herdr-vps-notifications-api-"));
  const stateDir = join(root, "state");
  const feed = join(root, "reports.jsonl");
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
    // no program at `bin`: only the feed says whether there is anything to offer
    ...(options.vps === false ? {} : { vps: monitor, notifications: new CabinetReports({ stateDir, feed, bin: join(root, "no-cabinet") }) }),
  });
  fixtures.push({ root, server, monitor });
  const base = `http://127.0.0.1:${server.port}`;
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, origin: base, "x-herdr-vps": "1" };
  const write = (lines: (Record<string, unknown> | string)[]): void => {
    writeFileSync(`${feed}.tmp`, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n");
    renameSync(`${feed}.tmp`, feed);
  };
  const get = (override?: Record<string, string>) => fetch(`${base}/api/vps/notifications`, { headers: override ?? headers });
  const post = (path = "/read", override?: Record<string, string>, body?: string) => fetch(`${base}/api/vps/notifications${path}`, { method: "POST", headers: override ?? headers, ...(body === undefined ? {} : { body }) });
  const list = async (): Promise<VpsNotifications> => await (await get()).json() as VpsNotifications;
  return { root, stateDir, feed, base, headers, write, get, post, list, watch: { cookie: `${DEVICE_COOKIE}=${watcher.token}`, origin: base, "x-herdr-vps": "1" } };
}

async function refused(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const body = await response.json() as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
}

/** The notifications routes at the HTTP seam, on a feed file of the test's own. No herdr, no cabinet. */
describe("notification routes", () => {
  it("answer an empty list while there is no feed", async () => {
    const f = fixture();
    const response = await f.get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ available: false, items: [], unread: 0, read_ts: 0 });
    // nothing to mark is not an error, and writes nothing
    const read = await f.post();
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ available: false, items: [], unread: 0, read_ts: 0 });
    expect(existsSync(join(f.stateDir, "vps-notifications.json"))).toBe(false);
  });

  it("list the reports newest first, skip a bad line, and count what is unread", async () => {
    const f = fixture();
    f.write([
      report("retry-1", 100, { kind: "retry", level: "ok", data: { moved: { folders: 2, items: [{ path: "/opt/workstation/a/one", bytes: 10, files: 1 }, { path: "/opt/workstation/a/two", bytes: 20 }], busy: [], waiting: 0 } } }),
      "{ cut short",
      report("alert-1", 200, { level: "critical", title: "Drive is not mounted", lines: ["Nothing was copied."] }),
    ]);
    const list = await f.list();
    expect(list).toMatchObject({ available: true, unread: 2, read_ts: 0 });
    expect(list.items).toEqual([
      { id: "alert-1", kind: "alert", level: "critical", ts: 200, title: "Drive is not mounted", lines: ["Nothing was copied."], moved: null, returned: null, waiting: null },
      { id: "retry-1", kind: "retry", level: "ok", ts: 100, title: "Report retry-1", lines: ["Line of retry-1."], moved: { total: 2, items: [{ path: "/opt/workstation/a/one", bytes: 10, why: "" }, { path: "/opt/workstation/a/two", bytes: 20, why: "" }] }, returned: null, waiting: null },
    ]);
  });

  it("mark everything in the feed read, for every device, and count only what came after", async () => {
    const f = fixture();
    f.write([report("a", 100), report("b", 200)]);
    expect((await f.list()).unread).toBe(2);

    const read = await f.post();
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ unread: 0, read_ts: 200 });
    // kept on the server: any other device's next ask agrees
    expect(await f.list()).toMatchObject({ unread: 0, read_ts: 200 });
    expect(JSON.parse(readFileSync(join(f.stateDir, "vps-notifications.json"), "utf8"))).toEqual({ read_ts: 200 });

    f.write([report("a", 100), report("b", 200), report("c", 300)]);
    const after = await f.list();
    expect(after).toMatchObject({ unread: 1, read_ts: 200 });
    expect(after.items.map((item) => item.id)).toEqual(["c", "b", "a"]);
  });

  it("mark read whatever the request carries: no body is read", async () => {
    const f = fixture();
    f.write([report("a", 100), report("b", 200)]);
    const json = { ...f.headers, "content-type": "application/json" };
    expect((await f.post("/read?read_ts=1&ids=a", json, JSON.stringify({ read_ts: 1, ids: ["a"], feed: "/etc/passwd" }))).status).toBe(200);
    expect(await f.list()).toMatchObject({ unread: 0, read_ts: 200 });
    // a body that is not JSON is not read either
    f.write([report("a", 100), report("b", 200), report("c", 300)]);
    expect((await f.post("/read", f.headers, "; not json #")).status).toBe(200);
    expect(await f.list()).toMatchObject({ unread: 0, read_ts: 300 });
  });

  it("send at most 50 reports", async () => {
    const f = fixture();
    f.write(Array.from({ length: 75 }, (_, index) => report(`r${index + 1}`, 1000 + index)));
    const list = await f.list();
    expect(list.items.length).toBe(50);
    expect(list.items[0]!.id).toBe("r75");
    expect(list.items.at(-1)!.id).toBe("r26");
    expect(list.unread).toBe(75);
  });

  it("answer 304 to a page that already has the list, and the whole list once it changed", async () => {
    const f = fixture();
    f.write([report("a", 100)]);
    const first = await f.get();
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"[0-9a-z]+"$/);
    await first.arrayBuffer();

    const same = await f.get({ ...f.headers, "if-none-match": etag });
    expect(same.status).toBe(304);
    expect(same.headers.get("etag")).toBe(etag);
    expect(await same.text()).toBe("");

    // read: the number changed, so the answer did
    expect((await f.post()).status).toBe(200);
    const read = await f.get({ ...f.headers, "if-none-match": etag });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ unread: 0, read_ts: 100 });

    // a new report: the answer changed again
    const before = read.headers.get("etag")!;
    f.write([report("a", 100), report("b", 200)]);
    const next = await f.get({ ...f.headers, "if-none-match": before });
    expect(next.status).toBe(200);
    expect(next.headers.get("etag")).not.toBe(before);
    // the POST always answers the list, whatever the page holds
    expect((await f.post("/read", { ...f.headers, "if-none-match": next.headers.get("etag")! })).status).toBe(200);
  });

  it("are behind the app's sign-in, its own header and its origin, and closed to a watching device", async () => {
    const f = fixture();
    f.write([report("a", 100)]);
    await refused(await f.get({}), 401, "unauthorized");
    await refused(await f.post("/read", { origin: f.base, "x-herdr-vps": "1" }), 401, "unauthorized");
    await refused(await f.post("/read", { authorization: "Bearer wrong", origin: f.base, "x-herdr-vps": "1" }), 401, "unauthorized");
    await refused(await f.post("/read", { authorization: f.headers["authorization"]!, origin: f.base }), 403, "missing_header");
    await refused(await f.post("/read", { ...f.headers, origin: "https://elsewhere.invalid" }), 403, "invalid_origin");
    await refused(await f.post("/read", { ...f.headers, "sec-fetch-site": "cross-site" }), 403, "invalid_origin");
    // a report names work folders: a watching device neither reads the list nor marks it, while the server's numbers stay open to it
    await refused(await f.get(f.watch), 403, "read_only");
    await refused(await f.post("/read", f.watch), 403, "read_only");
    expect((await fetch(`${f.base}/api/vps/status`, { headers: f.watch })).status).toBe(200);
    // marked read with POST alone, and only at its own path
    await refused(await fetch(`${f.base}/api/vps/notifications/read`, { headers: f.headers }), 404, "not_found");
    await refused(await f.post(""), 404, "not_found");
    // none of the refusals read anything
    expect(await f.list()).toMatchObject({ unread: 1, read_ts: 0 });
    expect(existsSync(join(f.stateDir, "vps-notifications.json"))).toBe(false);
  });

  it("are not offered on a server without VPS status", async () => {
    const off = fixture({ vps: false });
    off.write([report("a", 100)]);
    await refused(await off.get(), 404, "not_available");
    await refused(await off.post(), 404, "not_available");
  });
});
