/**
 * Notifications in a real browser: the button in the app bar with the number of reports not
 * looked at yet, the list it opens, a report opened to its folders, and the number going away
 * once the list was opened, on a phone (390 px) and on a desktop (1280 px).
 *
 * The page is the real app with the demo's fictional panes. Only /api/vps/notifications goes to
 * this script's server, which answers with the real route handler and the real
 * server/vps-notifications.ts on a feed file of the script's own. No herdr, no cabinet program,
 * and nothing of the PC's own feed.
 *
 * NOTIFICATIONS_SHOT_DIR=<folder> also saves cropped JPEGs there (the button, the list, a report opened).
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";

import { handleVpsRequest, type VpsServices } from "../server/vps-api.ts";
import { CabinetReports } from "../server/vps-notifications.ts";
import { translate } from "../src/lib/i18n.ts";
import { whenLabel } from "../src/lib/vpsNotifications.ts";
import { buildDemoApp } from "./demo-build.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-vps-notifications-"));
const app = join(root, "app");
const feed = join(root, "reports.jsonl");
const stateDir = join(root, "state");
const bin = join(root, "cabinet");
const shots = process.env["NOTIFICATIONS_SHOT_DIR"] ?? "";
const ZONE = "Asia/Manila";

const started = Math.floor(Date.now() / 1000);
/** what a night looks like: an older run that failed, last night's run, the folders that waited, a health message */
const OLD = {
  id: "nightly-0", kind: "nightly", level: "critical", ts: started - 3 * 86_400, title: "Night run: the backup did not finish",
  lines: ["Backup: stopped after 12 min, Drive did not answer. Nothing was removed from the VPS.", "Free on the VPS now: 37.0 GB of 96 GB (61% used)."],
  data: { backup: { ok: false, ran: true, files: 0, bytes: 0, failed: ["03 Agency"] }, moved: null, returned: null, problems: [{ level: "CRITICAL", message: "Drive did not answer" }], free_after_gb: 37.0 },
};
const NIGHTLY = {
  id: "nightly-1", kind: "nightly", level: "ok", ts: started - 3 * 3600, title: "Night run done: backup complete, 2 folders wait",
  lines: [
    "Backup: 6,572 new or changed files (919.2 MB) copied to Drive in 60 min; 416 older versions kept.",
    "Moved to Drive: nothing at midnight. 2 folders in use right now wait; they are tried again every hour.",
    "Brought back from Drive since the last night run: 2 folders, 40.5 MB.",
    "Cleaned: 1 old scratch folder deleted (12.1 MB); 53 old browser files packed to Drive (10.8 MB).",
    "Freed 22.9 MB. Free on the VPS now: 48.9 GB of 96 GB (49% used).",
  ],
  data: {
    backup: { ok: true, ran: true, files: 6572, bytes: 963_800_000, kept_versions: 416, seconds: 3639, sources: 15, failed: [] },
    moved: {
      folders: 0, bytes: 0, items: [], waiting: 2, failed: 0, fails: [],
      busy: [
        { path: "/opt/workstation/11 Reels/work/reel-7", bytes: 88_000_000, why: "client lock reels is held (a session is working in it)" },
        { path: "/opt/workstation/03 Agency/clients/cardinal-plumbing-drain-services/work/dec2026-revision", bytes: 466_358_422, why: "a file in it changed 20 minutes ago" },
      ],
    },
    returned: { folders: 2, bytes: 42_500_000, items: [{ path: "/opt/workstation/11 Reels/.tmp/otter-b", bytes: 31_485_958 }, { path: "/opt/workstation/07 Reports/2026/quarter-3", bytes: 11_015_758 }] },
    scratch: { folders: 1, bytes: 12_677_120 }, browser: { files: 53, bytes: 11_353_208 }, caches: null, check: null, problems: [], failed_steps: [],
    freed_bytes: 24_030_328, free_before_gb: 48.9, free_after_gb: 48.9, disk_total_gb: 96, used_pct: 49, seconds: 3679,
  },
};
const RETRY = {
  id: "retry-1", kind: "retry", level: "ok", ts: started - 2 * 3600, title: "2 waiting folders moved to Drive, 528.7 MB freed",
  lines: ["Moved to Drive: 2 folders that had to wait, 528.7 MB.", "Freed 528.7 MB. Free on the VPS now: 49.4 GB of 96 GB (49% used)."],
  data: {
    moved: {
      folders: 3, bytes: 554_392_310, waiting: 0, busy: [], failed: 0, fails: [],
      items: [
        { path: "/opt/workstation/03 Agency/clients/cardinal-plumbing-drain-services/work/dec2026-revision", bytes: 466_358_422, files: 32 },
        { path: "/opt/workstation/11 Reels/work/reel-7", bytes: 88_000_000, files: 20 },
        { path: "/opt/workstation/Week A", bytes: 33_888, files: 1 },
      ],
    },
    freed_bytes: 554_392_310, free_after_gb: 49.4, disk_total_gb: 96, used_pct: 49, seconds: 408,
  },
};
const ALERT = {
  id: "alert-1", kind: "alert", level: "warning", ts: started - 3600, title: "Drive is almost full",
  lines: ["Only 4.0 GB are left on Google Drive. The next backup may not fit."], data: {},
};

/** replaced whole by a rename, as cabinet does it */
function write(reports: unknown[]): void {
  writeFileSync(`${feed}.tmp`, reports.map((report) => JSON.stringify(report)).join("\n") + "\n");
  renameSync(`${feed}.tmp`, feed);
}
const en = (key: string, vars?: Record<string, string | number>): string => translate("en", key, vars);
const reads = (text: string): string => text.replace(/\s+/g, " ").trim();
/** what the page should say a report's time is */
const when = (ts: number): string => reads(whenLabel(ts, Date.now(), "en-US", en, ZONE));
const readTs = (): number => (JSON.parse(readFileSync(join(stateDir, "vps-notifications.json"), "utf8")) as { read_ts: number }).read_ts;

const never = (): never => { throw new Error("only the notifications are part of this test"); };
const services: VpsServices = {
  monitor: { status: never, config: never, setConfig: never } as unknown as VpsServices["monitor"],
  doctor: { options: never, scanDisk: never, cleanDisk: never, processes: never, processAction: never, startAgent: never },
  testAlert: never,
  // no program at `bin` until the script writes one: the feed alone says whether there is anything to offer
  notifications: new CabinetReports({ stateDir, feed, bin }),
};

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  // the demo answers every request itself; the notifications alone go to this script's server
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, `<script>window.inboxTestFetch = window.fetch.bind(window);</script>
    <script src="./demo-transport.js"></script>
    <script>
      const demoFetch = window.fetch;
      window.fetch = (input, init) => {
        const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        return path.startsWith('/api/vps/notifications') ? window.inboxTestFetch(input, init) : demoFetch(input, init);
      };
    </script>
    <script type="module"`));
  const asked = { get: 0, notModified: 0 };
  const posted: string[] = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/vps/")) {
        if (request.method === "POST") posted.push(`${url.pathname}${url.search} ${await request.clone().text()}`);
        else asked.get += 1;
        const response = await handleVpsRequest(request, url.pathname, services, () => {});
        if (response.status === 304) asked.notModified += 1;
        return response;
      }
      const name = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      if (name.split("/").includes("..")) return new Response(null, { status: 404 });
      const file = Bun.file(join(app, name));
      return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ headless: true, ...(process.env["CHROME_PATH"] ? { executablePath: process.env["CHROME_PATH"] } : {}) });

  const button = (page: Page): Locator => page.locator(".vps-inbox-button");
  const badge = (page: Page): Locator => page.locator(".vps-inbox-badge");
  const dialog = (page: Page): Locator => page.locator(".vps-inbox");
  const items = (page: Page): Locator => dialog(page).locator(".vps-inbox-item");
  const open = async (page: Page): Promise<void> => {
    await page.goto(`${origin}/?pane=w1C:p1&view=chat`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
  };
  /** the page comes back to the front: the moment it asks again without waiting out its minute */
  const comeBack = (page: Page): Promise<void> => page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); });
  const settled = (target: Locator): Promise<unknown> => target.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  const fits = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth
    && [...document.querySelectorAll(".vps-inbox *, .app-header *")].every((node) => { const box = node.getBoundingClientRect(); return box.width === 0 || (box.left >= -0.5 && box.right <= window.innerWidth + 0.5); }));
  /** A cropped JPEG of one part of the page, when a folder for them was named. */
  const shot = async (page: Page, name: string, around: Locator, pad = { x: 0, top: 0, bottom: 0 }): Promise<void> => {
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    const box = (await around.boundingBox())!;
    const view = page.viewportSize()!;
    const left = pad.x < 0 ? 0 : Math.max(0, box.x - pad.x);
    const right = pad.x < 0 ? view.width : Math.min(view.width, box.x + box.width + pad.x);
    const top = Math.max(0, box.y - pad.top);
    const bottom = Math.min(view.height, box.y + box.height + pad.bottom);
    await page.screenshot({ path: join(shots, name), type: "jpeg", quality: 85, clip: { x: left, y: top, width: right - left, height: bottom - top } });
  };
  /** The bar is one row: the button sits on the line of the controls beside it, inside the bar, with its number on its upper right corner. */
  const inBar = async (page: Page, width: number): Promise<void> => {
    const bar = (await page.locator(".app-header").boundingBox())!;
    const box = (await button(page).boundingBox())!;
    const more = (await page.locator(".header-more-button").boundingBox())!;
    const globe = (await page.locator(".browser-view-open").boundingBox())!;
    const middle = (target: { y: number; height: number }): number => target.y + target.height / 2;
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= bar.y && box.y + box.height <= bar.y + bar.height, "the button is inside the bar");
    assert.ok(Math.abs(middle(box) - middle(more)) < 1.5 && Math.abs(middle(box) - middle(globe)) < 1.5, "the bar stays one row");
    assert.ok(globe.x + globe.width <= box.x && box.x + box.width <= more.x, "it sits between the browser and More");
    if (await badge(page).count() === 0) return;
    const number = (await badge(page).boundingBox())!;
    assert.ok(number.x >= box.x + box.width / 2 && number.y >= box.y - 0.5 && number.y + number.height <= box.y + box.height / 2 + 2, "the number is on the button's upper right corner, clear of the glyph's middle");
    // a wide number may reach over the gap beside the button, never to the next control's glyph
    assert.ok(number.x + number.width <= more.x + (more.width - 18) / 2 - 2, "and stays clear of the control beside it");
    assert.ok(number.y >= bar.y && number.x + number.width <= width, "and is not cut by the bar or the screen");
    assert.ok(number.height >= 14 && number.width >= number.height - 0.5, "and is large enough to read");
  };

  // ---- a phone ----
  {
    write([OLD, NIGHTLY, RETRY, ALERT]);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US", timezoneId: ZONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(10_000);

    await open(page);
    await button(page).waitFor();
    assert.equal(await badge(page).innerText(), "4");
    assert.equal(await button(page).getAttribute("aria-label"), "Notifications: 4 new");
    assert.equal(await button(page).getAttribute("aria-expanded"), "false");
    const touch = (await button(page).boundingBox())!;
    assert.ok(touch.width >= 40 && touch.height >= 40, "a thumb can hit it");
    await inBar(page, 390);
    assert.equal(await fits(page), true, "the bar is not wider than the phone");
    const title = (await page.locator(".context-title").boundingBox())!;
    const lens = (await page.locator(".view-switch").boundingBox())!;
    assert.ok(title.width >= 24 && title.x + title.width <= lens.x, "the pane's title keeps its mark and does not run under the lens switch");
    assert.equal(posted.length, 0, "showing the number marks nothing read");
    await shot(page, "inbox-bell-390.jpg", page.locator(".app-header"), { x: -1, top: 150, bottom: 0 });
    console.log("PASS 390px: the button is in the bar with the number of new reports on it, and the bar stays one row");

    await button(page).tap();
    await dialog(page).waitFor();
    await settled(dialog(page));
    assert.equal(await dialog(page).getByRole("heading", { level: 2 }).innerText(), "Notifications");
    // newest first
    assert.deepEqual(await items(page).locator(".vps-inbox-title").allTextContents(), [ALERT.title, RETRY.title, NIGHTLY.title, OLD.title]);
    // the level by its mark's shape and name, and in a word where it asks for a look: never by colour alone
    assert.deepEqual(await items(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-level"))), ["warning", "ok", "ok", "critical"]);
    assert.deepEqual(await items(page).locator(".vps-inbox-mark .visually-hidden").allTextContents(), ["Warning", "OK", "OK", "Critical"]);
    assert.deepEqual(await items(page).locator(".vps-inbox-mark svg").evaluateAll((nodes) => nodes.map((node) => [...node.classList].find((name) => name.startsWith("lucide-") && name !== "lucide-icon") ?? "")), ["lucide-triangle-alert", "lucide-circle-check", "lucide-circle-check", "lucide-octagon-alert"]);
    assert.deepEqual(await items(page).locator(".vps-inbox-level").allTextContents(), ["Warning", "Critical"]);
    // when, on this device's clock
    assert.deepEqual((await items(page).locator("time").allTextContents()).map(reads), [when(ALERT.ts), when(RETRY.ts), when(NIGHTLY.ts), when(OLD.ts)]);
    assert.match(when(ALERT.ts), /^(Today|Yesterday) \d{1,2}:\d{2} [AP]M$/);
    assert.match(when(OLD.ts), /^[A-Z][a-z]{2} \d{1,2}, (\d{4}, )?\d{1,2}:\d{2} [AP]M$/);
    // then what it says, as cabinet wrote it
    assert.deepEqual(await items(page).nth(2).locator(".vps-inbox-lines li").allTextContents(), NIGHTLY.lines);
    assert.deepEqual(await items(page).nth(0).locator(".vps-inbox-lines li").allTextContents(), ALERT.lines);
    // all four are new, and say so in a word
    assert.deepEqual(await items(page).locator(".vps-inbox-new").allTextContents(), ["New", "New", "New", "New"]);
    assert.equal(await items(page).evaluateAll((nodes) => nodes.filter((node) => node.hasAttribute("data-new")).length), 4);
    // a report that names no folders has nothing to open
    assert.equal(await items(page).nth(0).locator(".vps-inbox-toggle").count(), 0);
    assert.equal(await items(page).nth(3).locator(".vps-inbox-toggle").count(), 0);
    assert.equal(await fits(page), true, "nothing in the list is wider than the phone");
    const sheet = (await dialog(page).boundingBox())!;
    assert.ok(sheet.x === 0 && sheet.width === 390 && Math.abs(sheet.y + sheet.height - 844) < 1, "on a phone the list is a sheet on the screen's lower edge");
    console.log("PASS 390px: the list opens newest first with level, title, time and lines, and marks what is new");

    // opening is reading: the number goes, and the server keeps the moment
    await badge(page).waitFor({ state: "detached" });
    assert.equal(await button(page).getAttribute("aria-label"), "Notifications");
    assert.equal(readTs(), ALERT.ts);
    assert.deepEqual(posted, ["/api/vps/notifications/read {}"], "one POST, carrying nothing");
    // what was new stays marked until the list is closed
    assert.equal(await items(page).locator(".vps-inbox-new").count(), 4);
    await dialog(page).locator(".modal-body").evaluate((node) => { node.scrollTop = 0; });
    await shot(page, "inbox-list-390.jpg", dialog(page));
    console.log("PASS 390px: the number clears once the list is open, and the new reports stay marked while it is");

    // a report opened to its folders: the look of the lists of "Move unused files to Drive"
    const retry = items(page).nth(1);
    const toggle = retry.locator(".vps-inbox-toggle");
    assert.equal(reads(await toggle.innerText()), "Show folders (3)");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.ok((await toggle.boundingBox())!.height >= 40, "a thumb can hit the row that opens the folders");
    await toggle.tap();
    await retry.locator(".vps-inbox-details").waitFor();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(reads(await toggle.innerText()), "Hide folders");
    assert.match(await retry.locator(".vps-inbox-heading").innerText(), /^MOVED TO DRIVE · 3$/i);
    assert.deepEqual(await retry.locator(".cabinet-row-name").allTextContents(), ["dec2026-revision", "reel-7", "Week A"]);
    assert.deepEqual(await retry.locator(".cabinet-row-size").allTextContents(), ["445 MB", "83.9 MB", "33.1 KB"]);
    // inside the work folder, without the work folder in front; a folder at its top says nothing more
    assert.deepEqual(await retry.locator(".cabinet-row-where").allTextContents(), ["03 Agency/clients/cardinal-plumbing-drain-services/work", "11 Reels/work"]);
    await settled(dialog(page));
    assert.equal(await fits(page), true, "a long path wraps, it does not widen the phone");
    // on a phone the folders take the sheet's whole width, from under the mark
    const listBox = (await retry.locator(".cabinet-list").boundingBox())!;
    const markBox = (await retry.locator(".vps-inbox-mark").boundingBox())!;
    assert.ok(Math.abs(listBox.x - markBox.x) < 1 && listBox.width >= 390 - 2 * 16 - 1, "the folders have the sheet's width");
    await retry.scrollIntoViewIfNeeded();
    await shot(page, "inbox-expanded-390.jpg", dialog(page));

    const nightly = items(page).nth(2);
    assert.equal(reads(await nightly.locator(".vps-inbox-toggle").innerText()), "Show folders (4)");
    await nightly.locator(".vps-inbox-toggle").tap();
    assert.deepEqual((await nightly.locator(".vps-inbox-heading").allTextContents()).map((text) => text.toUpperCase()), ["BROUGHT BACK FROM DRIVE · 2", "WAITING, IN USE · 2"]);
    assert.deepEqual(await nightly.locator(".cabinet-row-name").allTextContents(), ["otter-b", "quarter-3", "reel-7", "dec2026-revision"]);
    assert.deepEqual(await nightly.locator(".cabinet-row-why").allTextContents(), ["client lock reels is held (a session is working in it)", "a file in it changed 20 minutes ago"]);
    assert.equal(await fits(page), true);
    // closed again, the folders go and the other report's stay
    await nightly.locator(".vps-inbox-toggle").tap();
    assert.equal(await nightly.locator(".vps-inbox-details").count(), 0);
    assert.equal(await retry.locator(".cabinet-row").count(), 3);
    console.log("PASS 390px: a report opens to the folders it names, with name, place inside the work folder and size");

    // closed with nothing new: a phone's bar gives the button's room back to the pane's title, and More leads to the list
    await dialog(page).getByRole("button", { name: "Close dialog" }).tap();
    await dialog(page).waitFor({ state: "detached" });
    await button(page).waitFor({ state: "hidden" });
    assert.ok((await page.locator(".context-title").boundingBox())!.width >= title.width, "the title has its room again");
    await page.locator(".header-more-button").tap();
    const moreSheet = page.getByRole("dialog", { name: "More" });
    const entry = moreSheet.locator(".row-sheet-item", { hasText: "Notifications" });
    assert.equal(reads(await entry.innerText()), "Notifications");
    await settled(moreSheet);
    await entry.tap();
    await dialog(page).waitFor();
    assert.equal(await items(page).count(), 4);
    assert.equal(await items(page).locator(".vps-inbox-new").count(), 0, "read reports are not marked new at the next opening");
    assert.deepEqual(posted, ["/api/vps/notifications/read {}"], "nothing new, nothing marked");
    await dialog(page).getByRole("button", { name: "Close dialog" }).tap();
    await dialog(page).waitFor({ state: "detached" });
    console.log("PASS 390px: with nothing new the bar has no button, and More opens the same list");

    // a report arrives: the page that comes back to the front asks, and the number is there again
    const fresh = { id: "retry-2", kind: "retry", level: "ok", ts: Date.now() / 1000, title: "1 waiting folder moved to Drive, 83.9 MB freed", lines: ["Moved to Drive: 1 folder that had to wait, 83.9 MB."], data: { moved: { folders: 1, bytes: 88_000_000, items: [{ path: "/opt/workstation/11 Reels/work/reel-8", bytes: 88_000_000, files: 3 }] } } };
    write([OLD, NIGHTLY, RETRY, ALERT, fresh]);
    await comeBack(page);
    await button(page).waitFor();
    assert.equal(await badge(page).innerText(), "1");
    assert.equal(await button(page).getAttribute("aria-label"), "Notifications: 1 new");
    await inBar(page, 390);
    // More says the same number in words
    await page.locator(".header-more-button").tap();
    assert.equal(reads(await moreSheet.locator(".row-sheet-item", { hasText: "Notifications" }).innerText()), "Notifications 1 new");
    await settled(moreSheet);
    await moreSheet.getByRole("button", { name: "Cancel" }).tap();
    await moreSheet.waitFor({ state: "detached" });
    await button(page).tap();
    await dialog(page).waitFor();
    assert.equal(await items(page).count(), 5);
    assert.equal(await items(page).first().locator(".vps-inbox-title").innerText(), fresh.title);
    await badge(page).waitFor({ state: "detached" });
    assert.equal(await items(page).locator(".vps-inbox-new").count(), 1, "only the report that arrived is new");
    assert.equal(await items(page).first().locator(".vps-inbox-new").count(), 1);
    assert.equal(readTs(), fresh.ts);
    // the list is open: the button stays in the bar until it is closed, then goes
    assert.equal(await button(page).isVisible(), true);
    await dialog(page).getByRole("button", { name: "Close dialog" }).tap();
    await button(page).waitFor({ state: "hidden" });

    // more than nine
    const many = Array.from({ length: 12 }, (_, index) => ({ id: `alert-${index + 10}`, kind: "alert", level: "info", ts: Date.now() / 1000 + 1 + index / 100, title: `Drive is fine again (${index + 1})`, lines: ["The last check found no problem."], data: {} }));
    write([OLD, NIGHTLY, RETRY, ALERT, fresh, ...many]);
    await comeBack(page);
    await button(page).waitFor();
    assert.equal(await badge(page).innerText(), "9+");
    assert.equal(await button(page).getAttribute("aria-label"), "Notifications: 12 new");
    await inBar(page, 390);
    assert.equal(await fits(page), true);
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.deepEqual(errors, []);
    console.log("PASS 390px: a report that arrives brings the button and its number back, and above nine it reads 9+");
    await context.close();
  }

  // ---- a desktop: another device, the same number ----
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 844 }, locale: "en-US", timezoneId: ZONE });
    await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(10_000);

    await open(page);
    await button(page).waitFor();
    // the phone read five of the seventeen: a device that has stored nothing counts the same twelve
    assert.equal(await badge(page).innerText(), "9+");
    assert.equal(await button(page).getAttribute("aria-label"), "Notifications: 12 new");
    await inBar(page, 1280);
    const side = (await page.locator(".header-side").boundingBox())!;
    assert.ok((await button(page).boundingBox())!.x > side.x + side.width, "it is over the pane, not in the sidebar's top row");
    assert.equal(await fits(page), true);
    await shot(page, "inbox-bell-1280.jpg", button(page), { x: 420, top: 8, bottom: 110 });
    console.log("PASS 1280px: the button is in the header with the same number the phone left");

    const before = posted.length;
    await button(page).click();
    await dialog(page).waitFor();
    await settled(dialog(page));
    const box = (await dialog(page).boundingBox())!;
    assert.ok(box.width <= 640 && box.x > 200 && box.x + box.width < 1080 && box.y > 0 && box.y + box.height < 844, "on a desktop the list is a dialog in the middle of the window");
    assert.equal(await items(page).count(), 17);
    assert.equal(await items(page).locator(".vps-inbox-new").count(), 12);
    await badge(page).waitFor({ state: "detached" });
    assert.equal(await button(page).isVisible(), true, "a desktop keeps the button with nothing new");
    assert.equal(await button(page).getAttribute("aria-expanded"), "true");
    assert.equal(posted.length, before + 1);
    assert.equal(await items(page).locator(".vps-inbox-new").count(), 12, "what was new stays marked while the list is open");
    // the keyboard: Tab stays in the dialog, a report opens with Enter, Escape closes and the focus returns to the button
    assert.equal(await dialog(page).evaluate((node) => node.contains(document.activeElement)), true, "the focus starts inside the dialog");
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press("Tab");
      assert.equal(await dialog(page).evaluate((node) => node.contains(document.activeElement)), true, "Tab stays inside the dialog");
    }
    const retry = items(page).filter({ hasText: RETRY.title });
    await retry.locator(".vps-inbox-toggle").focus();
    await page.keyboard.press("Enter");
    await retry.locator(".vps-inbox-details").waitFor();
    assert.deepEqual(await retry.locator(".cabinet-row-name").allTextContents(), ["dec2026-revision", "reel-7", "Week A"]);
    await settled(dialog(page));
    // on a desktop the folders line up under the report's words
    assert.ok(Math.abs((await retry.locator(".cabinet-list").boundingBox())!.x - (await retry.locator(".vps-inbox-title").boundingBox())!.x) < 1, "the folders sit under the report's text");
    await retry.scrollIntoViewIfNeeded();
    await shot(page, "inbox-expanded-1280.jpg", dialog(page), { x: 40, top: 40, bottom: 40 });
    await page.keyboard.press("Escape");
    await dialog(page).waitFor({ state: "detached" });
    assert.equal(await button(page).evaluate((node) => node === document.activeElement), true, "Escape closes the list and the focus returns to the button");
    assert.equal(await button(page).getAttribute("aria-label"), "Notifications");
    await inBar(page, 1280);

    // opened again: nothing is new, and a click beside the dialog closes it
    await button(page).click();
    await dialog(page).waitFor();
    await settled(dialog(page));
    assert.equal(await items(page).locator(".vps-inbox-new").count(), 0);
    await dialog(page).locator(".modal-body").evaluate((node) => { node.scrollTop = 0; });
    await shot(page, "inbox-list-1280.jpg", dialog(page), { x: 40, top: 40, bottom: 40 });
    await page.mouse.click(40, 400);
    await dialog(page).waitFor({ state: "detached" });
    // the header's button is the way in on a desktop: More does not repeat it
    await page.locator(".header-more-button").click();
    await page.getByRole("menu").waitFor();
    assert.equal(await page.getByRole("menu").getByText("Notifications").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(posted.length, before + 1, "nothing new, nothing marked");
    console.log("PASS 1280px: the list is a dialog, the number clears on opening, and keyboard and pointer both close it");

    // no report yet on a server that has cabinet: the button without a number, and the words for what will come
    rmSync(feed);
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    await comeBack(page);
    await button(page).click();
    await dialog(page).waitFor();
    await dialog(page).locator(".vps-inbox-empty").waitFor();
    assert.equal(await dialog(page).locator(".vps-inbox-empty").innerText(), "No notifications yet. After each night run at 12:00 a.m. you will see here what was backed up, what was moved to Drive and how much space is free.");
    assert.equal(await items(page).count(), 0);
    assert.equal(await badge(page).count(), 0);
    await page.keyboard.press("Escape");
    await dialog(page).waitFor({ state: "detached" });

    // no cabinet at all: nothing is drawn
    rmSync(bin);
    await comeBack(page);
    await button(page).waitFor({ state: "detached" });
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
    assert.deepEqual(errors, []);
    console.log("PASS 1280px: before the first report the list says what will come, and a server without cabinet draws no button");
    await context.close();
  }

  // the page asked sparingly: an unchanged list came back without a body, and every POST carried nothing
  assert.ok(asked.notModified > 0, "an ask for a list the page already has is answered 304");
  assert.ok(posted.length === 3 && posted.every((line) => line === "/api/vps/notifications/read {}"), `the page posts nothing but an empty object: ${posted.join(" | ")}`);
  assert.ok(existsSync(join(stateDir, "vps-notifications.json")));
  if (shots) console.log(`screenshots: ${shots}`);
} finally {
  await browser?.close();
  await server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
