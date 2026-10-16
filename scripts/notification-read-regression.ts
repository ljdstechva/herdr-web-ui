import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { paneNotificationTag } from "../shared/notify-policy.ts";
import { DEFAULT_VPS_THRESHOLDS, type VpsStatus } from "../shared/vps.ts";
import { buildDemoApp } from "./demo-build.ts";

// Real browser notification records and the shipped worker/client; only server data and push
// delivery are fixtures. No subscriptions, live panes, or phone notifications are touched.
const app = mkdtempSync(join(tmpdir(), "herdr-notification-read-"));
const tags = { a: paneNotificationTag(panes.api), b: paneNotificationTag(panes.web), remote: paneNotificationTag(panes.api, "other-pc"), vps: "herdr-vps-cpu" };
const vps: VpsStatus = {
  supported: true, hostname: "qa-server", sampled_at: Date.now(), uptime_seconds: 3600,
  cpu: { cores: 2, usage_percent: 10, average_percent: 10, load: [0.1, 0.1, 0.1] },
  memory: { total_bytes: 4e9, available_bytes: 3e9, used_percent: 25 },
  swap: { total_bytes: 0, used_bytes: 0, used_percent: 0 }, disks: [], top: [], issues: [], severity: "ok",
  config: { alerts: false, thresholds: DEFAULT_VPS_THRESHOLDS },
};
const worker = `
  const nativeAdd = self.addEventListener.bind(self);
  let pushListener;
  self.addEventListener = (type, listener, ...rest) => {
    if (type === "push") pushListener = listener;
    return nativeAdd(type, listener, ...rest);
  };
` + readFileSync(join(import.meta.dir, "../public/sw.js"), "utf8") + `
  nativeAdd("message", (event) => {
    if (event.data?.type !== "qa-push") return;
    let completion;
    pushListener({ data: { json: () => event.data.payload }, waitUntil(promise) { completion = promise; } });
    event.waitUntil(completion.then(() => event.ports[0].postMessage("shown")));
  });
`;

async function inventory(page: Page): Promise<string[]> {
  return page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration())!.getNotifications()).map((n) => n.tag).sort());
}
async function expectTags(page: Page, expected: string[], reason: string): Promise<void> {
  const wanted = [...expected].sort();
  const deadline = Date.now() + 5000;
  let actual = await inventory(page);
  while (JSON.stringify(actual) !== JSON.stringify(wanted) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    actual = await inventory(page);
  }
  assert.deepEqual(actual, wanted, reason);
}
async function seed(page: Page, tag: string, paneId: string | null, machineId = "local"): Promise<void> {
  await page.evaluate(async ({ tag, paneId, machineId }) => {
    await (await navigator.serviceWorker.getRegistration())!.showNotification("Notification QA", {
      tag, body: "Fictional test alert", data: { pane_id: paneId, machine_id: machineId, vps: tag.startsWith("herdr-vps-") },
    });
  }, { tag, paneId, machineId });
}
async function push(page: Page, tag: string, paneId: string | null): Promise<void> {
  await page.evaluate(({ tag, paneId }) => new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("push did not finish")), 5000);
    channel.port1.onmessage = () => { clearTimeout(timer); channel.port1.close(); resolve(); };
    navigator.serviceWorker.controller!.postMessage({ type: "qa-push", payload: { title: "Notification QA", tag, pane_id: paneId } }, [channel.port2]);
  }), { tag, paneId });
}

try {
  await buildDemoApp(app);
  const html = readFileSync(join(app, "index.html"), "utf8").replace(/<script type="module"/, '<script src="/demo-transport.js"></script><script src="/qa-vps.js"></script><script type="module"');
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/sw.js") return new Response(worker, { headers: { "content-type": "application/javascript", "cache-control": "no-store" } });
    if (path === "/qa-vps.js") return new Response(`const demoFetch = window.fetch; window.fetch = (input, init) => String(input) === "/api/vps/status" ? Promise.resolve(Response.json(${JSON.stringify(vps)})) : demoFetch(input, init);`, { headers: { "content-type": "application/javascript" } });
    if (path === "/probe") return new Response("<!doctype html><title>Notification QA setup</title><p>Isolated notification fixture</p>", { headers: { "content-type": "text/html" } });
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    if (path.includes("..")) return new Response("invalid path", { status: 400 });
    const file = Bun.file(join(app, path));
    return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  try {
    for (const mobile of [true, false]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, permissions: ["notifications"], locale: "en-US" });
      try {
        await context.addInitScript(() => {
          localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertsOn: false, defaultView: "chat" }));
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") errors.push(message.text()); });
        await page.goto(`${origin}/probe`);
        await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; });
        await page.waitForFunction(() => !!navigator.serviceWorker.controller);
        await seed(page, tags.a, panes.api);
        await seed(page, tags.b, panes.web);
        await seed(page, tags.remote, panes.api, "other-pc");
        await seed(page, tags.vps, null);
        await seed(page, "herdr-test", null);
        assert.equal((await inventory(page)).length, 5, "native notifications are present before opening the app");
        await page.goto(`${origin}/?pane=${encodeURIComponent(panes.api)}&view=chat`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await expectTags(page, [tags.b, tags.remote, tags.vps], "opening a pane must close its delivered notification, preserving unread ones");
        console.log(`PASS ${mobile ? "phone" : "desktop"}: opening a pane clears only its notification`);
        await push(page, tags.a, panes.api);
        await expectTags(page, [tags.b, tags.remote, tags.vps], "a push for the already-open pane must be reconciled after it is shown");

        const sender = await context.newPage();
        await sender.goto(`${origin}/probe`);
        await page.bringToFront();
        await seed(sender, tags.a, panes.api);
        await sender.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.active!.postMessage({ type: "notification-shown" }));
        await expectTags(page, [tags.b, tags.remote, tags.vps], "a tab-created notification is reconciled by another visible reader");
        await sender.close();

        // Explicit visibility events model an installed app being backgrounded and resumed.
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await push(page, tags.a, panes.api);
        await expectTags(page, Object.values(tags), "a background page must not consume an unread alert");
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await expectTags(page, [tags.b, tags.remote, tags.vps], "resuming the open pane dismisses its notification");

        await page.goto(`${origin}/?pane=${encodeURIComponent(panes.api)}&settings=appearance`);
        await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
        await push(page, tags.a, panes.api);
        await expectTags(page, Object.values(tags), "Settings must not mark the pane underneath as read");
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        await expectTags(page, [tags.b, tags.remote, tags.vps], "returning from Settings reads the pane");

        // A nested dialog changes no App selection/state. Reading resumes after its focus trap
        // restores focus and React has removed the dialog, even without another user gesture.
        if (mobile) await page.locator(".tab-strip-menu:visible").click();
        else await page.locator(".tab-strip-tab[aria-selected='true']").click({ button: "right" });
        await page.getByRole(mobile ? "button" : "menuitem", { name: "Close tab", exact: true }).click();
        await page.getByRole("alertdialog").waitFor();
        await push(page, tags.a, panes.api);
        await expectTags(page, Object.values(tags), "a nested confirmation must not read the pane behind it");
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expectTags(page, [tags.b, tags.remote, tags.vps], "closing a nested dialog resumes reading without another click");

        if (mobile) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await page.getByRole("button", { name: /^VPS status:/ }).click();
        await page.getByRole("dialog", { name: /VPS status/ }).waitFor();
        await expectTags(page, [tags.b, tags.remote], "reading VPS status clears VPS alerts only");
        await page.keyboard.press("Control+Shift+K");
        await page.getByRole("dialog", { name: "Command palette", exact: true }).waitFor();
        await push(page, tags.vps, null);
        await expectTags(page, [tags.b, tags.remote, tags.vps], "a covered VPS dialog must not mark a new alert read");
        await page.keyboard.press("Escape");
        await expectTags(page, [tags.b, tags.remote], "returning to the VPS dialog reads its alert");
        await push(page, tags.a, panes.api);
        await expectTags(page, [tags.a, tags.b, tags.remote], "VPS dialog must not consume the obscured pane's alert");
        await push(page, tags.vps, null);
        await expectTags(page, [tags.a, tags.b, tags.remote], "a late VPS push is read in the already-open status dialog");
        await page.getByRole("button", { name: "Close dialog", exact: true }).click();
        if (mobile) {
          await expectTags(page, [tags.a, tags.b, tags.remote], "the mobile drawer still obscures the selected pane");
          await page.getByRole("button", { name: "Close workspace list", exact: true }).click();
        }
        await expectTags(page, [tags.b, tags.remote], "returning from the VPS dialog/drawer reads the pane");
        if (mobile) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await page.locator(".workspace-select").filter({ hasText: "web-dashboard" }).click();
        await expectTags(page, [tags.remote], "manually switching to the other pane consumes only its notification");
        console.log(`PASS ${mobile ? "phone" : "desktop"}: delivery, resume, Settings, VPS, drawer and pane switching; remote unread preserved`);
        assert.match(await page.title(), /herdr/);
        assert.equal(await page.locator("vite-error-overlay").count(), 0);
        assert.equal(await page.locator(".terminal-host").isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal page overflow");
        assert.deepEqual(errors, []);
        if (process.env.UI_EVIDENCE_DIR) {
          mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `notification-read-${mobile ? "phone" : "desktop"}.png`), animations: "disabled" });
        }
      } finally { await context.close(); }
    }
  } finally { await browser.close(); server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
