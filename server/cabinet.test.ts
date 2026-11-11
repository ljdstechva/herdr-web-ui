import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FAKE_DRY_RUN, FAKE_RUN, fakeCabinet, type FakeCabinet } from "./cabinet.fake.ts";
import { CabinetError, CabinetTidy, lastLine, parseJsonLine, parsePreview, parseResult, runOutcome } from "./cabinet.ts";

const DRY = FAKE_DRY_RUN;
const REAL = FAKE_RUN;

describe("cabinet's answers", () => {
  it("reads the last JSON line and nothing else", () => {
    expect(parseJsonLine(`warming up\n{"a":1}\n${JSON.stringify(DRY)}\n`)).toMatchObject({ folders: 3 });
    expect(parseJsonLine("Traceback (most recent call last):\n  boom\n")).toBeNull();
    expect(parseJsonLine("[1,2]\n")).toBeNull();
    expect(parseJsonLine("")).toBeNull();
    // a broken last line does not hide the answer before it
    expect(parseJsonLine(`{"moved":2}\n{"moved":`)).toEqual({ moved: 2 });
  });

  it("shapes a dry run: largest first, a bounded list, and numbers only where they are numbers", () => {
    const preview = parsePreview(DRY);
    expect(preview.items.map((item) => item.path)).toEqual(["/opt/workstation/b/large", "/opt/workstation/c/middle", "/opt/workstation/a/small"]);
    expect(preview).toMatchObject({ folders: 3, bytes: 1_500, waiting: 1, free_gb: 37.1, idle_days: 1, busy: [{ path: "/opt/workstation/d/held", bytes: 123, why: "client lock stepsocial is held (pid 42)" }] });
    const many = parsePreview({ items: Array.from({ length: 69 }, (_, index) => ({ path: `/opt/workstation/f${index}`, bytes: index })), bytes: "x", free_gb: "37" });
    expect(many.folders).toBe(69);
    expect(many.items).toHaveLength(20);
    expect(many.items[0]).toEqual({ path: "/opt/workstation/f68", bytes: 68, idle_hours: null });
    expect(many).toMatchObject({ bytes: 0, free_gb: null, idle_days: null, waiting: 0, busy: [] });
    expect(parsePreview({ items: [{ bytes: 5 }, "x", null, { path: 7 }] }).items).toEqual([]);
  });

  it("shapes a real run, and tells a run from anything else", () => {
    expect(parseResult(REAL)).toEqual({ ok: true, moved: 3, bytes: 123_456_789, waiting: 1, busy: [{ path: "/opt/workstation/d/held", bytes: 123, why: "in use" }], failed: 0, fails: [], scratch_folders: 2, scratch_bytes: 1234, browser_files: 0, free_before_gb: 37.1, free_after_gb: 41.2, seconds: 95 });
    // cabinet's own record of a run (`last_tidy`) counts the folders in use instead of listing them
    expect(parseResult({ ...REAL, busy: 2, waiting: 2 })).toMatchObject({ waiting: 2, busy: [] });
    expect(parseResult({ ...REAL, ok: false, failed: 2, fails: ["a/b", "c/d", 5] })).toMatchObject({ ok: false, failed: 2, fails: ["a/b", "c/d"] });
    // a failure the program counted is a failure whatever its `ok` says
    expect(parseResult({ moved: 1, failed: 1 })?.ok).toBe(false);
    expect(parseResult({ ok: false, busy: true, message: "locked" })).toBeNull();
    expect(parseResult(DRY)).toBeNull();
  });

  it("names how a run ended", () => {
    expect(runOutcome(REAL, 0, "", null)).toMatchObject({ state: "done", message: null, result: { ok: true, moved: 3 } });
    // exit 1: something failed, and the JSON still says what moved
    expect(runOutcome({ ...REAL, failed: 1, fails: ["x/y"] }, 1, "", null)).toMatchObject({ state: "done", result: { ok: false, moved: 3, fails: ["x/y"] } });
    expect(runOutcome(REAL, 1, "", null).result?.ok).toBe(false);
    // exit 3, or its JSON read after a restart with no exit code
    expect(runOutcome({ ok: false, busy: true, message: "the hourly copy is running" }, 3, "", null)).toEqual({ state: "busy", result: null, message: "the hourly copy is running" });
    expect(runOutcome({ ok: false, busy: true }, null, "", null)).toMatchObject({ state: "busy", message: "Another cabinet job is running. Nothing was changed." });
    expect(runOutcome(null, 3, "", null).state).toBe("busy");
    expect(runOutcome(null, 3, "cabinet: another cabinet job is still running (move lock). Try again in a few minutes.", null).message).toBe("cabinet: another cabinet job is still running (move lock). Try again in a few minutes.");
    // no answer in the output: cabinet's own record, else a failure in words
    expect(runOutcome(null, null, "", parseResult(REAL))).toMatchObject({ state: "done", result: { moved: 3 } });
    expect(runOutcome(null, 2, lastLine("one\nrclone: not signed in\n\n"), null)).toEqual({ state: "failed", result: null, message: "rclone: not signed in" });
    expect(lastLine("")).toBe("");
    expect(runOutcome(null, 2, "", null).message).toBe("cabinet ended with code 2 and no result.");
    expect(runOutcome(null, null, "", null).message).toBe("The run ended without a result.");
    expect(runOutcome({ ok: false, message: "Drive is not mounted" }, 1, "", null)).toEqual({ state: "failed", result: null, message: "Drive is not mounted" });
  });
});

/** Bounded polls: the stand-in program runs in its own process. */
async function until<T>(read: () => T | null | undefined | false, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

const fixtures: { root: string; fake: FakeCabinet }[] = [];
afterEach(async () => {
  for (const { root, fake } of fixtures.splice(0)) {
    // let go of a stand-in still waiting, and see it gone, before its folder goes
    fake.releaseAll();
    let pid: number | null = null;
    try { pid = (JSON.parse(readFileSync(join(root, "state", "cabinet-tidy.json"), "utf8")) as { pid: number | null }).pid; } catch { /* no run was started, or a test broke the record on purpose */ }
    // (a record written by hand may name this test's own process)
    if (pid && pid !== process.pid) await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "the stand-in to end");
    rmSync(root, { recursive: true, force: true });
  }
});

/** A stand-in cabinet program (cabinet.fake.ts), a state folder, and a CabinetTidy that runs the one in the other. */
function fixture(options: { previewTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "herdr-cabinet-"));
  const fake = fakeCabinet(root);
  fixtures.push({ root, fake });
  const stateDir = join(root, "state");
  const cabinetState = join(root, "cabinet-state.json");
  const make = (): CabinetTidy => new CabinetTidy({ stateDir, bin: fake.bin, cabinetState, ...options });
  return { root, stateDir, bin: fake.bin, cabinetState, stage: fake.stage, hold: fake.hold, calls: fake.calls, make, cabinet: make() };
}

async function refusal(work: Promise<unknown> | (() => unknown), status: number, code: string): Promise<CabinetError> {
  let caught: unknown;
  try { await (typeof work === "function" ? work() : work); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(CabinetError);
  expect([(caught as CabinetError).status, (caught as CabinetError).code]).toEqual([status, code]);
  return caught as CabinetError;
}

describe.skipIf(process.platform === "win32")("cabinet tidy", () => {
  it("offers nothing where there is no cabinet program", async () => {
    const f = fixture();
    const missing = new CabinetTidy({ stateDir: f.stateDir, bin: join(f.root, "no-such-cabinet"), cabinetState: f.cabinetState });
    expect(missing.status()).toMatchObject({ available: false, run: null });
    await refusal(missing.preview(), 404, "cabinet_missing");
    await refusal(() => missing.start(), 404, "cabinet_missing");
    // a file this user may not run is no program either
    chmodSync(f.bin, 0o644);
    expect(f.cabinet.status().available).toBe(false);
    await refusal(f.cabinet.preview(), 404, "cabinet_missing");
    expect(f.calls()).toEqual([]);
  });

  it("previews with the dry run, and only the dry run", async () => {
    const f = fixture();
    expect(f.cabinet.status()).toMatchObject({ available: true, run: null });
    const preview = await f.cabinet.preview();
    expect(preview).toMatchObject({ folders: 3, bytes: 1_500, free_gb: 37.1, idle_days: 1, waiting: 1 });
    expect(preview.items[0]).toEqual({ path: "/opt/workstation/b/large", bytes: 1_000, idle_hours: 25.7 });
    expect(f.calls()).toEqual(["tidy --dry-run --json"]);
    // nothing was started, and nothing is recorded as a run
    expect(f.cabinet.status().run).toBeNull();
    expect(existsSync(join(f.stateDir, "cabinet-tidy.json"))).toBe(false);
  });

  it("shares one dry run between asks made together", async () => {
    const f = fixture();
    const release = f.hold("dry");
    const first = f.cabinet.preview();
    const second = f.cabinet.preview();
    await until(() => f.calls().length > 0, "the dry run to start");
    release();
    expect(await first).toEqual(await second);
    expect(f.calls()).toEqual(["tidy --dry-run --json"]);
  });

  it("says why a dry run gave no preview", async () => {
    const f = fixture();
    // it answered, but not in JSON
    f.stage("dry", "", 0);
    expect((await refusal(f.cabinet.preview(), 502, "bad_output")).message).toBe("cabinet did not answer in JSON.");
    f.stage("dry", "68 folders would move\n", 0);
    expect((await refusal(f.cabinet.preview(), 502, "bad_output")).message).toBe("cabinet did not answer in JSON: 68 folders would move");
    // it failed and said why: on its error output, or (as cabinet ends a refusal, with exit code 2) as its last line
    f.stage("dry", "Traceback (most recent call last):\n", 1, "KeyError: 'folders'\n");
    expect((await refusal(f.cabinet.preview(), 502, "preview_failed")).message).toBe("KeyError: 'folders'");
    f.stage("dry", "cabinet: Drive is not mounted\n", 2);
    expect((await refusal(f.cabinet.preview(), 502, "preview_failed")).message).toBe("cabinet: Drive is not mounted");
    // another cabinet job holds the lock: as JSON, or as the sentence cabinet prints without it
    f.stage("dry", { ok: false, busy: true, message: "cabinet sync is running (pid 7)" }, 3);
    expect((await refusal(f.cabinet.preview(), 409, "cabinet_busy")).message).toBe("cabinet sync is running (pid 7)");
    f.stage("dry", "cabinet: another cabinet job is still running (move lock). Try again in a few minutes.\n", 3);
    expect((await refusal(f.cabinet.preview(), 409, "cabinet_busy")).message).toBe("cabinet: another cabinet job is still running (move lock). Try again in a few minutes.");
    f.stage("dry", { ok: false, message: "Drive is not mounted" }, 1);
    expect((await refusal(f.cabinet.preview(), 502, "preview_failed")).message).toBe("Drive is not mounted");
    f.stage("dry", DRY, 2);
    await refusal(f.cabinet.preview(), 502, "preview_failed");
  });

  it("gives up on a dry run that does not answer", async () => {
    const f = fixture({ previewTimeoutMs: 150 });
    f.hold("dry");
    const started = performance.now();
    expect((await refusal(f.cabinet.preview(), 504, "preview_timeout")).message).toBe("cabinet did not answer in 0 s.");
    expect(performance.now() - started).toBeLessThan(5000);
    // the next ask is a new dry run, not the one given up on
    expect(f.calls()).toEqual(["tidy --dry-run --json"]);
  });

  it("starts the run detached, one at a time, and reads its result when it ended", async () => {
    const f = fixture();
    const release = f.hold("real");
    const before = Date.now();
    const started = f.cabinet.start();
    expect(started).toMatchObject({ available: true, run: { state: "running", finished_at: null, result: null, message: null } });
    expect(started.run!.started_at).toBeGreaterThanOrEqual(before);
    await until(() => f.calls().includes("tidy --json"), "the run to start");

    // the record is private, and names the process
    const recordPath = join(f.stateDir, "cabinet-tidy.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { pid: number; start_ticks: number | null; state: string };
    expect(statSync(recordPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.stateDir, "cabinet", "tidy.out")).mode & 0o777).toBe(0o600);
    expect(record.state).toBe("running");
    expect(record.pid).toBeGreaterThan(0);
    // what the wire carries names no process
    expect(Object.keys(started.run!).sort()).toEqual(["finished_at", "id", "message", "result", "started_at", "state"]);
    // in a session of its own: a signal to this server's process group does not reach it
    if (process.platform === "linux") {
      const sid = (pid: number): string => { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]!; };
      expect(sid(record.pid)).toBe(String(record.pid));
      expect(sid(record.pid)).not.toBe(sid(process.pid));
    }

    // one at a time: no second run, and no dry run beside it
    await refusal(() => f.cabinet.start(), 409, "tidy_running");
    await refusal(f.cabinet.preview(), 409, "tidy_running");
    expect(f.cabinet.status().run).toMatchObject({ id: started.run!.id, state: "running" });

    release();
    const done = await until(() => { const run = f.cabinet.status().run; return run && run.state !== "running" ? run : null; }, "the run to end");
    expect(done).toMatchObject({ id: started.run!.id, state: "done", message: null, result: { ok: true, moved: 3, bytes: 123_456_789, waiting: 1, failed: 0, free_before_gb: 37.1, free_after_gb: 41.2, seconds: 95 } });
    expect(done.finished_at!).toBeGreaterThanOrEqual(done.started_at);
    // exactly the fixed command, once
    expect(f.calls()).toEqual(["tidy --json"]);
    // the result stays for the next look, also by a server started later
    expect(f.make().status().run).toEqual(done);
    // and another run may follow
    expect(f.cabinet.start().run).toMatchObject({ state: "running" });
    await until(() => f.cabinet.status().run?.state === "done", "the second run to end");
    expect(f.calls()).toEqual(["tidy --json", "tidy --json"]);
  });

  it("refuses to start while its own dry run still holds the program", async () => {
    const f = fixture();
    const release = f.hold("dry");
    const preview = f.cabinet.preview();
    await until(() => f.calls().length > 0, "the dry run to start");
    await refusal(() => f.cabinet.start(), 409, "preview_running");
    release();
    await preview;
    expect(f.calls()).toEqual(["tidy --dry-run --json"]);
  });

  it("tells a run cabinet refused, one that failed in part, and one that gave no result", async () => {
    const f = fixture();
    const ended = async () => until(() => { const run = f.cabinet.status().run; return run && run.state !== "running" ? run : null; }, "the run to end");

    f.stage("real", { ok: false, busy: true, message: "cabinet sync is running (pid 7)" }, 3);
    f.cabinet.start();
    expect(await ended()).toMatchObject({ state: "busy", result: null, message: "cabinet sync is running (pid 7)" });

    f.stage("real", { ...REAL, ok: false, moved: 2, failed: 1, fails: ["03 SMARCOMMS/clients/acme/work"] }, 1);
    f.cabinet.start();
    expect(await ended()).toMatchObject({ state: "done", result: { ok: false, moved: 2, failed: 1, fails: ["03 SMARCOMMS/clients/acme/work"] } });

    f.stage("real", "", 2, "warming up\nrclone: not signed in\n");
    f.cabinet.start();
    expect(await ended()).toMatchObject({ state: "failed", result: null, message: "rclone: not signed in" });

    // cabinet's own refusal: one sentence on its output, exit code 2
    f.stage("real", "cabinet: Drive is not mounted\n", 2);
    f.cabinet.start();
    expect(await ended()).toMatchObject({ state: "failed", result: null, message: "cabinet: Drive is not mounted" });
    expect(f.calls()).toEqual(["tidy --json", "tidy --json", "tidy --json", "tidy --json"]);
  });

  it("says so when the program cannot be started", async () => {
    const f = fixture();
    // executable, but its interpreter does not exist: the system refuses to run it
    writeFileSync(f.bin, "#!/no/such/interpreter\n");
    expect(f.cabinet.status().available).toBe(true);
    expect((await refusal(f.cabinet.preview(), 502, "preview_failed")).message).toStartWith("cabinet could not be started: ");
    expect(f.cabinet.start().run).toMatchObject({ state: "running" });
    const ended = await until(() => { const run = f.cabinet.status().run; return run && run.state !== "running" ? run : null; }, "the run to end");
    expect(ended).toMatchObject({ state: "failed", result: null });
    expect(ended.message).toStartWith("cabinet could not be started: ");
    // and it does not stand in the way of the next try
    await refusal(f.cabinet.preview(), 502, "preview_failed");
  });

  it.skipIf(process.platform !== "linux")("keeps the run when the server that started it is stopped, and a new server reads it", async () => {
    const f = fixture();
    const release = f.hold("real");
    // a server of its own, stopped the way the plugin stops one: a signal to its process group
    const script = join(f.root, "server.ts");
    writeFileSync(script, `import { CabinetTidy } from ${JSON.stringify(join(import.meta.dir, "cabinet.ts"))};
const cabinet = new CabinetTidy({ stateDir: ${JSON.stringify(f.stateDir)}, bin: ${JSON.stringify(f.bin)}, cabinetState: ${JSON.stringify(f.cabinetState)} });
cabinet.start();
setInterval(() => {}, 1000);
`);
    const server = spawn(process.execPath, [script], { detached: true, stdio: "ignore" });
    const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
    try {
      await until(() => f.calls().includes("tidy --json"), "the run to start");
      // the stand-in can be running before the server that started it has written its record
      const record = await until(() => { try { return JSON.parse(readFileSync(join(f.stateDir, "cabinet-tidy.json"), "utf8")) as { id: string; pid: number }; } catch { return null; } }, "the run's record");
      process.kill(-server.pid!, "SIGTERM");
      await exited;
      // the run goes on without it
      expect(() => process.kill(record.pid, 0)).not.toThrow();
      const next = f.make();
      expect(next.status().run).toMatchObject({ id: record.id, state: "running" });
      await refusal(() => next.start(), 409, "tidy_running");
      release();
      const done = await until(() => { const run = next.status().run; return run && run.state !== "running" ? run : null; }, "the run to end");
      expect(done).toMatchObject({ id: record.id, state: "done", result: { ok: true, moved: 3, free_after_gb: 41.2 } });
      expect(f.calls()).toEqual(["tidy --json"]);
    } finally {
      try { process.kill(-server.pid!, "SIGKILL"); } catch { /* stopped above */ }
    }
  });

  it("ends a run it finds gone: from cabinet's own record, else as a failure", () => {
    const f = fixture();
    mkdirSync(f.stateDir, { recursive: true });
    const startedAt = Date.now() - 600_000;
    // no process has this pid and start time: the server that started the run is gone, and so is the run
    const lost = { id: "tidy-lost", state: "running", started_at: startedAt, finished_at: null, result: null, message: null, pid: process.pid, start_ticks: 1 };
    writeFileSync(join(f.stateDir, "cabinet-tidy.json"), JSON.stringify(lost));
    expect(f.make().status().run).toMatchObject({ id: "tidy-lost", state: "failed", message: "The run ended without a result." });

    // the same, but cabinet recorded a tidy that ended after this run began
    writeFileSync(join(f.stateDir, "cabinet-tidy.json"), JSON.stringify(lost));
    const ts = (startedAt + 95_000) / 1000;
    writeFileSync(f.cabinetState, JSON.stringify({ last_tidy: { ...REAL, ts }, last_move: { ts: 1_794_334_180.3, ok: true, moved: 4, bytes: 856_937_184, failed: 0, fails: [], waiting: 0 } }));
    expect(f.make().status().run).toMatchObject({ id: "tidy-lost", state: "done", finished_at: startedAt + 95_000, result: { moved: 3, free_after_gb: 41.2 } });

    // a record of a tidy from before the run began says nothing about it
    writeFileSync(join(f.stateDir, "cabinet-tidy.json"), JSON.stringify(lost));
    writeFileSync(f.cabinetState, JSON.stringify({ last_tidy: { ...REAL, ts: (startedAt - 3_600_000) / 1000 } }));
    expect(f.make().status().run).toMatchObject({ id: "tidy-lost", state: "failed" });
  });

  it("shows the last tidy cabinet ran by other means, and reads no run from a broken record", () => {
    const f = fixture();
    mkdirSync(f.stateDir, { recursive: true });
    // as cabinet writes it: the run's JSON, `ts` in seconds, and `busy` as a count
    writeFileSync(f.cabinetState, JSON.stringify({ last_tidy: { ...REAL, moved: 7, waiting: 2, busy: 2, ts: 1_794_400_000 } }));
    expect(f.cabinet.status().run).toMatchObject({ id: "cabinet-1794400000000", state: "done", started_at: 1_794_400_000_000 - 95_000, finished_at: 1_794_400_000_000, result: { moved: 7, waiting: 2, busy: [], scratch_folders: 2 } });

    // a run from the app that ended later than that stays the last run
    const mine = { id: "tidy-mine", state: "busy", started_at: 1_794_400_100_000, finished_at: 1_794_400_101_000, result: null, message: "locked", pid: null, start_ticks: null };
    writeFileSync(join(f.stateDir, "cabinet-tidy.json"), JSON.stringify(mine));
    expect(f.make().status().run).toMatchObject({ id: "tidy-mine", state: "busy", message: "locked" });
    // and an older one gives way to it
    writeFileSync(join(f.stateDir, "cabinet-tidy.json"), JSON.stringify({ ...mine, started_at: 1_794_300_000_000, finished_at: 1_794_300_001_000 }));
    expect(f.make().status().run).toMatchObject({ id: "cabinet-1794400000000", result: { moved: 7 } });

    writeFileSync(join(f.stateDir, "cabinet-tidy.json"), "{ not json");
    writeFileSync(f.cabinetState, "{ not json");
    expect(f.make().status()).toMatchObject({ available: true, run: null });
  });
});
