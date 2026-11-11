/**
 * "Move unused files to Drive" in a real browser: the entry under the disk meter of the VPS
 * dialog, the dry run it shows first, the run it starts on a second button, and what the dialog
 * shows when it is opened again while the run goes on and after it ended.
 *
 * The page talks to the real route handler and the real server/cabinet.ts, which run a stand-in
 * for the cabinet program (server/cabinet.fake.ts). No herdr, no live panes, and never the real
 * cabinet: that one moves the owner's folders.
 *
 * CABINET_SHOT_DIR=<folder> also saves two cropped phone-width JPEGs there (the entry, the dry run).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";

import { fakeCabinet, FAKE_RUN } from "../server/cabinet.fake.ts";
import { CabinetTidy } from "../server/cabinet.ts";
import { handleVpsRequest, type VpsServices } from "../server/vps-api.ts";
import { DEFAULT_VPS_THRESHOLDS, type VpsStatus } from "../shared/vps.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-cabinet-tidy-"));
const repo = join(import.meta.dir, "..");
const shots = process.env["CABINET_SHOT_DIR"] ?? "";
const GIB = 1024 ** 3;

// what a dry run on a work folder looks like: many folders, a few large, one in use
const sizes = [712_228_226, 466_358_422, 432_216_075, 401_120_000, 356_000_000];
const names = [
  "11 Reels/.tmp/football-2-music",
  "03 Agency/clients/cardinal-plumbing-drain-services/work/dec2026-revision",
  "03 Agency/.tmp/captions-nov",
  "07 Reports/2026/quarter-3/engineer-report-drafts",
  "Week A",
];
const items = [
  ...names.map((name, index) => ({ path: `/opt/workstation/${name}`, bytes: sizes[index]!, idle_hours: 25.7 + index * 40 })),
  ...Array.from({ length: 63 }, (_, index) => ({ path: `/opt/workstation/09 Archive/batch-${index + 1}`, bytes: 40_000_000 - index * 100_000, idle_hours: 100 })),
];
const DRY = {
  dry_run: true, ok: true, folders: items.length, bytes: 4_926_428_642, waiting: 1, items,
  busy: [{ path: "/opt/workstation/11 Reels/work/reel-7", bytes: 88_000_000, why: "client lock reels is held (a session is working in it)" }],
  free_gb: 37.0, idle_days: 1,
};

const fake = fakeCabinet(root);
fake.stage("dry", DRY);
const cabinet = new CabinetTidy({ stateDir: join(root, "state"), bin: fake.bin, cabinetState: join(root, "cabinet-state.json") });

const status: VpsStatus = {
  supported: true, hostname: "demo-vps", sampled_at: Date.now(), uptime_seconds: 9 * 86_400 + 3_600,
  cpu: { cores: 4, usage_percent: 12, average_percent: 9, load: [0.4, 0.5, 0.6] },
  memory: { total_bytes: 8 * GIB, available_bytes: 3.5 * GIB, used_percent: 56.3 },
  swap: { total_bytes: 0, used_bytes: 0, used_percent: 0 },
  disks: [{ mount: "/", device: "/dev/sda1", fs_type: "ext4", total_bytes: 96 * GIB, used_bytes: 59 * GIB, available_bytes: 37 * GIB, used_percent: 61.5 }],
  oom_kills: 0, top: [], issues: [], severity: "ok", config: { alerts: true, thresholds: DEFAULT_VPS_THRESHOLDS },
};
const never = (): never => { throw new Error("the Doctor is not part of this test"); };
const services: VpsServices = {
  monitor: { status: () => ({ ...status, sampled_at: Date.now() }), config: () => status.config, setConfig: never } as unknown as VpsServices["monitor"],
  doctor: { options: never, scanDisk: never, cleanDisk: never, processes: never, processAction: never, startAgent: never },
  testAlert: never,
  cabinet,
};

const entry = join(root, "fixture.tsx");
writeFileSync(entry, `
import React from ${JSON.stringify(join(repo, "node_modules/react/index.js"))};
import { createRoot } from ${JSON.stringify(join(repo, "node_modules/react-dom/client.js"))};
import ${JSON.stringify(join(repo, "src/styles.css"))};
import { VpsStatusRow } from ${JSON.stringify(join(repo, "src/components/VpsStatus.tsx"))};
function Fixture() {
 return <div className="app">
   <header className="app-header">Cabinet test</header>
   <div className="app-body"><main><VpsStatusRow onSelect={() => {}} /></main></div>
 </div>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`);

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const build = await Bun.build({ entrypoints: [entry], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "fixture-jsx", setup(build) { build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () => ({ path: join(repo, "node_modules/react/jsx-dev-runtime.js") })); } }] });
  assert.ok(build.success, String(build.logs));
  const posted: string[] = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/vps/")) {
        if (request.method === "POST") posted.push(`${url.pathname}${url.search} ${await request.clone().text()}`);
        return handleVpsRequest(request, url.pathname, services, () => {});
      }
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      if (url.pathname === "/") return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cabinet test · herdr</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
      return new Response(Bun.file(join(root, url.pathname.slice(1))));
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });

  const dialog = (page: Page): Locator => page.getByRole("dialog");
  const entryRow = (page: Page): Locator => dialog(page).locator(".cabinet-entry");
  const lead = async (page: Page): Promise<string> => ((await dialog(page).locator(".cabinet-lead").innerText()) ?? "").replace(/\s+/g, " ").trim();
  const openStatus = async (page: Page): Promise<void> => {
    await page.goto(`${origin}/`);
    await page.getByRole("button", { name: /^VPS status/ }).click();
    await entryRow(page).waitFor();
    // the dialog's entrance moves what is in it until it ends
    await dialog(page).evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  };
  /** A cropped JPEG of one part of the page, when a folder for them was named. */
  const shot = async (page: Page, name: string, around: Locator, pad: { top: number; bottom: number }): Promise<void> => {
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    const box = (await around.boundingBox())!;
    const view = page.viewportSize()!;
    const top = Math.max(0, box.y - pad.top);
    const bottom = Math.min(view.height, box.y + box.height + pad.bottom);
    await page.screenshot({ path: join(shots, name), type: "jpeg", quality: 82, clip: { x: 0, y: top, width: view.width, height: bottom - top } });
  };
  const fits = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth
    && [...document.querySelectorAll(".vps-modal *")].every((node) => node.getBoundingClientRect().right <= window.innerWidth + 0.5));

  // ---- a phone: the entry, the dry run, the run, a reload in its middle, the result ----
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US", isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(10_000);

    await openStatus(page);
    assert.match((await entryRow(page).innerText()).replace(/\s+/g, " "), /^Move unused files to Drive Work folders not used for a day\. You see the list first\.$/);
    const entryBox = (await entryRow(page).boundingBox())!;
    assert.ok(entryBox.height >= 48 && entryBox.width >= 300, "the entry is a full row a thumb can hit");
    const meter = (await dialog(page).locator(".vps-meter", { hasText: "Disk /" }).boundingBox())!;
    assert.ok(entryBox.y >= meter.y + meter.height && entryBox.y - (meter.y + meter.height) < 24, "the entry sits directly under the disk's meter");
    assert.deepEqual(fake.calls(), [], "opening the dialog runs nothing");
    await shot(page, "cabinet-entry-390.jpg", entryRow(page), { top: 150, bottom: 24 });
    console.log("PASS 390px: the entry sits under the disk meter and runs nothing by being shown");

    await entryRow(page).tap();
    await dialog(page).locator('.cabinet[data-state="preview"]').waitFor();
    assert.equal(await dialog(page).getByRole("heading", { level: 2 }).innerText(), "Move unused files to Drive");
    assert.equal(await lead(page), "68 folders, 4.6 GB would move.");
    assert.equal(await dialog(page).locator(".cabinet-free").innerText(), "Free now: 37.0 GB");
    assert.equal(await dialog(page).locator(".cabinet-explain").first().innerText(), "Work folders not used for 1 day go to Google Drive. Each one is checked there before it leaves this server.");
    assert.deepEqual(await dialog(page).locator('[aria-label="Largest folders"] .cabinet-row-name').allTextContents(), ["football-2-music", "dec2026-revision", "captions-nov", "engineer-report-drafts", "Week A"]);
    assert.deepEqual(await dialog(page).locator('[aria-label="Largest folders"] .cabinet-row-size').allTextContents(), ["679 MB", "445 MB", "412 MB", "383 MB", "340 MB"]);
    // inside the work folder, without the work folder in front; a folder at its top says nothing more
    assert.deepEqual(await dialog(page).locator('[aria-label="Largest folders"] .cabinet-row-where').allTextContents(), ["11 Reels/.tmp", "03 Agency/clients/cardinal-plumbing-drain-services/work", "03 Agency/.tmp", "07 Reports/2026/quarter-3"]);
    assert.equal(await dialog(page).locator(".cabinet-more").first().innerText(), "and 63 more folders");
    const waiting = dialog(page).locator('[aria-label="Folders that wait"]');
    assert.match((await waiting.innerText()).replace(/\s+/g, " "), /^WAITING · 1 In use right now\. They stay here and move on a later run\. reel-7 83\.9 MB 11 Reels\/work client lock reels is held \(a session is working in it\)$/i);
    const move = dialog(page).getByRole("button", { name: "Move 68 folders to Drive" });
    const moveBox = (await move.boundingBox())!;
    const againBox = (await dialog(page).getByRole("button", { name: "Check again" }).boundingBox())!;
    assert.ok(moveBox.height >= 48 && againBox.height >= 48 && moveBox.width >= 300, "both controls are full rows a thumb can hit");
    assert.ok(moveBox.y < againBox.y, "the control that acts is the upper one");
    assert.equal(await fits(page), true, "nothing is wider than the phone");
    assert.deepEqual(fake.calls(), ["tidy --dry-run --json"], "the look at the list is the dry run alone");
    await dialog(page).locator(".modal-body").evaluate((node) => { node.scrollTop = 0; });
    await shot(page, "cabinet-preview-390.jpg", dialog(page), { top: 0, bottom: 0 });
    console.log("PASS 390px: the dry run shows how much would move, the largest folders and what waits, and starts nothing");

    const release = fake.hold("real");
    await move.tap();
    await dialog(page).locator('.cabinet[data-state="running"]').waitFor();
    assert.equal(await lead(page), "Moving files to Drive…");
    assert.match(await dialog(page).locator(".cabinet-free").innerText(), /^Working for \d+ s$/);
    assert.deepEqual(fake.calls(), ["tidy --dry-run --json", "tidy --json"]);

    // the page is closed and opened again while the server works
    await page.reload();
    await page.getByRole("button", { name: /^VPS status/ }).click();
    await dialog(page).locator(".cabinet-entry[data-running]").waitFor();
    assert.match((await entryRow(page).innerText()).replace(/\s+/g, " "), /^Moving files to Drive… Working now\. Tap to see\.$/);
    await entryRow(page).tap();
    await dialog(page).locator('.cabinet[data-state="running"]').waitFor();
    assert.deepEqual(fake.calls(), ["tidy --dry-run --json", "tidy --json"], "looking at a run under way starts neither a dry run nor a second run");
    console.log("PASS 390px: one tap starts the run, and a page opened again finds it still working");

    release();
    await dialog(page).locator('.cabinet[data-state="done"]').waitFor();
    assert.equal(await lead(page), "Moved 3 folders, 118 MB.");
    assert.equal(await dialog(page).locator(".cabinet-free").innerText(), "Free: 37.1 GB → 41.2 GB");
    assert.match(await dialog(page).locator(".cabinet-explain").first().innerText(), /^Finished just now · took 1 min 35 s\.$/);
    assert.equal(await dialog(page).locator(".cabinet-explain").nth(1).innerText(), "Also cleared 2 old scratch folders (1.2 KB).");
    assert.match((await waiting.innerText()).replace(/\s+/g, " "), /^WAITING · 1 They were in use, so they stayed\. They move on a later run\. held 123 B d in use$/i);
    assert.equal(await fits(page), true, "nothing is wider than the phone");
    await dialog(page).getByRole("button", { name: "Done" }).tap();
    await entryRow(page).waitFor();
    assert.match((await entryRow(page).innerText()).replace(/\s+/g, " "), /^Move unused files to Drive Last run just now: moved 3 folders, 118 MB\.$/);
    console.log("PASS 390px: the result says what moved and what the disk gained, and stays on the entry");

    // another cabinet job holds the lock: nothing changed, and it can be tried again
    fake.stage("real", { ok: false, busy: true, message: "cabinet sync is running (pid 4242)" }, 3);
    await entryRow(page).tap();
    await dialog(page).getByRole("button", { name: "Move 68 folders to Drive" }).tap();
    await dialog(page).locator('.cabinet[data-state="busy"]').waitFor();
    assert.equal(await lead(page), "Another cabinet job is running.");
    assert.match(await dialog(page).locator(".cabinet-explain").innerText(), /Nothing was changed\..+Try again in a few minutes\./);
    assert.equal(await dialog(page).locator(".cabinet-said").innerText(), "cabinet sync is running (pid 4242)");
    await dialog(page).getByRole("button", { name: "Try again" }).tap();
    await dialog(page).locator('.cabinet[data-state="preview"]').waitFor();
    // the last try is one line under the new list, and opens what it was
    const last = dialog(page).locator(".cabinet-last");
    assert.match(await last.innerText(), /^Last try just now: another cabinet job was running, nothing was changed\.$/);
    await last.tap();
    await dialog(page).locator('.cabinet[data-state="busy"]').waitFor();
    await dialog(page).getByRole("button", { name: "Done" }).tap();
    console.log("PASS 390px: a busy cabinet is said in words, changes nothing and offers another try");

    // a run that moved some folders and could not move one
    fake.stage("real", { ...FAKE_RUN, ok: false, moved: 2, bytes: 80_000_000, failed: 1, fails: ["03 Agency/clients/acme/work"], waiting: 0, busy: [] }, 1);
    await entryRow(page).tap();
    await dialog(page).getByRole("button", { name: "Move 68 folders to Drive" }).tap();
    await dialog(page).locator('.cabinet[data-state="done"]').waitFor();
    assert.equal(await lead(page), "Moved 2 folders, 76.3 MB. 1 could not be moved.");
    assert.match((await dialog(page).locator('[aria-label="Folders that could not be moved"]').innerText()).replace(/\s+/g, " "), /^COULD NOT BE MOVED · 1 These are still on this server\. Nothing is lost\. work 03 Agency\/clients\/acme$/i);

    // nothing left to move is an answer, not an error
    fake.stage("dry", { dry_run: true, ok: true, folders: 0, bytes: 0, waiting: 0, items: [], busy: [], free_gb: 41.2, idle_days: 1 });
    await dialog(page).getByRole("button", { name: "Check again" }).tap();
    await dialog(page).locator('.cabinet[data-state="nothing"]').waitFor();
    assert.equal(await lead(page), "Nothing to move.");
    assert.equal(await dialog(page).locator(".cabinet-explain").first().innerText(), "Every work folder was used in the last day.");
    assert.equal(await dialog(page).getByRole("button", { name: /^Move / }).count(), 0, "nothing to move offers no move");

    // many folders in use: the lists scroll, the control that acts stays in view
    const held = Array.from({ length: 14 }, (_, index) => ({ path: `/opt/workstation/11 Reels/work/reel-${index + 1}`, bytes: 50_000_000, why: "client lock reels is held (a session is working in it)" }));
    fake.stage("dry", { ...DRY, waiting: held.length, busy: held });
    await dialog(page).getByRole("button", { name: "Check again" }).tap();
    await dialog(page).locator('.cabinet[data-state="preview"]').waitFor();
    assert.equal(await dialog(page).locator('[aria-label="Folders that wait"] .cabinet-row').count(), 14);
    assert.equal(await dialog(page).locator(".modal-body").evaluate((node) => node.scrollHeight > node.clientHeight + 200), true, "the lists are longer than the dialog");
    const stuck = (await dialog(page).getByRole("button", { name: "Move 68 folders to Drive" }).boundingBox())!;
    const frame = (await dialog(page).boundingBox())!;
    assert.ok(stuck.y >= frame.y && stuck.y + stuck.height <= frame.y + frame.height, "the move stays in view over a long list");
    assert.equal(await dialog(page).getByRole("button", { name: "Move 68 folders to Drive" }).evaluate((node) => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)); }), true, "and nothing lies over it");
    await shot(page, "cabinet-long-390.jpg", dialog(page), { top: 0, bottom: 0 });

    // the dry run cannot be read: said in words, with another try
    fake.stage("dry", "Traceback (most recent call last):\n", 1, "KeyError: 'folders'\n");
    await dialog(page).getByRole("button", { name: "Check again" }).tap();
    await dialog(page).locator(".cabinet-lead.is-problem").waitFor();
    assert.equal(await lead(page), "The check did not work: KeyError: 'folders'");
    await dialog(page).getByRole("button", { name: "Back to status" }).tap();
    await entryRow(page).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS 390px: a partial failure names what stayed, nothing to move is a plain answer, a long list keeps the move in view, and an unreadable check is said in words");
    await context.close();
  }

  // ---- a desktop: the same view, its two controls side by side ----
  {
    fake.stage("dry", DRY);
    const context = await browser.newContext({ viewport: { width: 1280, height: 844 }, locale: "en-US" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(10_000);
    await openStatus(page);
    await entryRow(page).click();
    await dialog(page).locator('.cabinet[data-state="preview"]').waitFor();
    const moveBox = (await dialog(page).getByRole("button", { name: "Move 68 folders to Drive" }).boundingBox())!;
    const againBox = (await dialog(page).getByRole("button", { name: "Check again" }).boundingBox())!;
    assert.ok(Math.abs(moveBox.y - againBox.y) < 2 && againBox.x < moveBox.x, "the two controls share a row, the one that acts last");
    await page.keyboard.press("Escape");
    await entryRow(page).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS 1280px: the controls share a row, and Escape returns to the status");
    await context.close();
  }

  // every command the page caused was one of the two fixed ones, and no request carried anything
  const calls = fake.calls();
  assert.deepEqual([...new Set(calls)].sort(), ["tidy --dry-run --json", "tidy --json"]);
  assert.equal(calls.filter((call) => call === "tidy --json").length, 3, "three runs were asked for, and three ran");
  assert.ok(posted.length > 0 && posted.every((line) => /^\/api\/vps\/cabinet\/(preview|tidy) \{\}$/.test(line)), `the page posts nothing but an empty object: ${posted.join(" | ")}`);
  if (shots) console.log(`screenshots: ${join(shots, "cabinet-entry-390.jpg")} ${join(shots, "cabinet-preview-390.jpg")}`);
} finally {
  await browser?.close();
  await server?.stop(true);
  fake.releaseAll();
  // a stand-in still running would hold the folder: it ends within a moment of being let go
  try {
    const pid = (JSON.parse(readFileSync(join(root, "state", "cabinet-tidy.json"), "utf8")) as { pid: number | null }).pid;
    const deadline = Date.now() + 5000;
    while (pid && Date.now() < deadline) { try { process.kill(pid, 0); await Bun.sleep(20); } catch { break; } }
  } catch { /* no run was started */ }
  rmSync(root, { recursive: true, force: true });
}
