import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

// A phone's tabs follow the finger (src/lib/tabSwipe.ts), on the unmodified app over the demo's
// fixture transport, with touches the browser itself dispatches (CDP), so its own scrolling and
// tap recognition take part. All files and HTTP traffic stay in this disposable, loopback-only
// app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-tab-swipe-demo-"));
const shots = process.env["TAB_SWIPE_SHOTS"];

interface Strip { tabs: string[]; open: string | null; swipe: string | null; hint: string | null; hintSide: string | null; offset: number }

const stripOf = (page: Page): Promise<Strip> => page.evaluate(() => {
  const host = document.querySelector<HTMLElement>(".terminal-host")!;
  const hint = host.querySelector<HTMLElement>(".tab-swipe-hint");
  const canvas = host.querySelector<HTMLElement>(".pane-canvas");
  return {
    tabs: [...document.querySelectorAll('.tab-strip [role="tab"]')].map((node) => node.textContent ?? ""),
    open: document.querySelector('.tab-strip [role="tab"][aria-selected="true"]')?.textContent ?? null,
    swipe: host.dataset["tabSwipe"] ?? null,
    hint: hint && !hint.hidden ? hint.textContent : null,
    hintSide: hint?.dataset["side"] ?? null,
    offset: canvas ? Math.round(new DOMMatrixReadOnly(getComputedStyle(canvas).transform).m41) : 0,
  };
});

/** One finger, moved in steps the way a hand does; `hold` leaves it down for the caller to look. */
async function stroke(cdp: CDPSession, from: { x: number; y: number }, by: { x: number; y: number }, options: { steps?: number; stepMs?: number; hold?: boolean } = {}): Promise<() => Promise<void>> {
  const { steps = 8, stepMs = 16, hold = false } = options;
  const point = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.x, from.y) });
  for (let step = 1; step <= steps; step += 1) {
    await new Promise((done) => setTimeout(done, stepMs));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(from.x + by.x * step / steps, from.y + by.y * step / steps) });
  }
  const lift = async (): Promise<void> => { await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); };
  if (!hold) await lift();
  return lift;
}

const openIs = (page: Page, name: string): Promise<unknown> => page.waitForFunction(
  (expected) => document.querySelector('.tab-strip [role="tab"][aria-selected="true"]')?.textContent === expected, name, { timeout: 5_000 });
const atRest = (page: Page): Promise<unknown> => page.waitForFunction(() => document.querySelector<HTMLElement>(".terminal-host")?.dataset["tabSwipe"] === undefined, null, { timeout: 5_000 });

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = (pane: string, view: "chat" | "terminal"): string => `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(pane)}&view=${view}`;
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      const open = async (pane: string, view: "chat" | "terminal" = "chat") => {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
        await context.addInitScript(() => { localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })); });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url(pane, view));
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".tab-strip").waitFor();
        await appFaces(page);
        // two more tabs beside the workspace's own, named so the hint can be told apart
        const workspace = pane.split(":")[0]!;
        await page.evaluate(async (workspaceId) => {
          for (const label of ["review", "deploy"]) {
            await fetch("/api/tab/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: workspaceId, label, focus: false }) });
          }
        }, workspace);
        await page.waitForFunction(() => document.querySelectorAll('.tab-strip [role="tab"]').length === 3);
        // creating a tab may have opened it: every scenario starts on the first
        await page.locator('.tab-strip [role="tab"]').first().click();
        const cdp = await context.newCDPSession(page);
        return { page, cdp, errors, close: () => context.close() };
      };

      {
        const { page, cdp, errors, close } = await open(panes.infra);
        try {
          const start = await stripOf(page);
          assert.equal(start.tabs.length, 3);
          const [first, second, third] = start.tabs as [string, string, string];
          await openIs(page, first);
          const middle = { x: 300, y: 420 };

          // the stroke says what it will do before the finger lifts
          const lift = await stroke(cdp, middle, { x: -40, y: 4 }, { hold: true });
          const short = await stripOf(page);
          assert.equal(short.swipe, "tracking", "a sideways stroke is the tabs'");
          assert.equal(short.hint, second, "the tab it is going to is named");
          assert.equal(short.hintSide, "end", "at the edge it comes from");
          assert.ok(short.offset < 0 && short.offset > -40, `the pane follows the finger part of the way (${short.offset}px)`);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: middle.x - 120, y: middle.y + 4, id: 1 }] });
          const far = await stripOf(page);
          assert.equal(far.swipe, "armed", "far enough: letting go opens it");
          if (shots) await page.screenshot({ path: join(shots, "tab-swipe-armed.png") });
          await lift();
          await openIs(page, second);
          await atRest(page);
          console.log("PASS a stroke to the left names the next tab, follows the finger and opens it on release");

          await stroke(cdp, middle, { x: -130, y: -6 });
          await openIs(page, third);
          await atRest(page);
          // past the row's last tab the stroke leads on, to the workspace after this one: the hint names it
          const paneOf = (): Promise<string | null> => page.evaluate(() => new URLSearchParams(location.search).get("pane"));
          const here = await paneOf();
          const onward = await stroke(cdp, middle, { x: -130, y: 0 }, { hold: true });
          const next = await stripOf(page);
          assert.equal(next.swipe, "armed", "a stroke past the last tab is still the tabs'");
          assert.equal(next.hint, "docs-site", "it names the workspace it leads to");
          assert.equal(next.hintSide, "end");
          await onward();
          await page.waitForFunction((pane) => new URLSearchParams(location.search).get("pane") === pane, panes.docs, { timeout: 5_000 });
          await atRest(page);
          // and the same stroke the other way returns, to the tab it left: the workspace's last
          const back = await stroke(cdp, middle, { x: 130, y: 0 }, { hold: true });
          assert.equal((await stripOf(page)).hint, `infra · ${third}`, "going back, the workspace before is entered at its last tab, and both are named");
          assert.equal((await stripOf(page)).hintSide, "start");
          await back();
          await page.waitForFunction((pane) => new URLSearchParams(location.search).get("pane") === pane, here, { timeout: 5_000 });
          await openIs(page, third);
          await atRest(page);
          console.log("PASS past a workspace's last tab a stroke opens the next workspace, and the stroke back returns to the tab it left");

          await stroke(cdp, middle, { x: 130, y: 0 });
          await openIs(page, second);
          await atRest(page);
          // a quick short stroke is a flick; a slow one that short is not
          await stroke(cdp, middle, { x: 56, y: 0 }, { steps: 2, stepMs: 4 });
          await openIs(page, first);
          await atRest(page);
          await stroke(cdp, middle, { x: -40, y: 0 }, { steps: 8, stepMs: 60 });
          await atRest(page);
          assert.equal((await stripOf(page)).open, first, "a slow stroke short of the distance opens nothing");
          console.log("PASS a stroke to the right goes back, a flick opens a tab, a slow short stroke does not");

          // what is under the finger keeps its own strokes
          const scrolledBefore = await page.evaluate(() => document.querySelector(".chat-view")!.scrollTop);
          await page.evaluate(() => { const view = document.querySelector(".chat-view")!; view.scrollTop = Math.max(0, view.scrollTop - 200); });
          await stroke(cdp, middle, { x: 12, y: -160 });
          assert.equal((await stripOf(page)).open, first, "an upward stroke scrolls the transcript");
          assert.equal((await stripOf(page)).swipe, null);
          void scrolledBefore;
          await stroke(cdp, { x: 8, y: 420 }, { x: 160, y: 0 });
          assert.equal((await stripOf(page)).open, first, "a stroke from the screen's edge is not the tabs'");
          const box = await page.locator(".composer-text").boundingBox();
          assert.ok(box);
          await stroke(cdp, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: -150, y: 0 });
          assert.equal((await stripOf(page)).open, first, "a stroke on the message box moves its caret");
          assert.deepEqual(errors, []);
          console.log("PASS a vertical stroke, one from the screen's edge and one on the message box leave the tabs alone");
        } finally { await close(); }
      }

      {
        // a code block that scrolls sideways keeps the stroke
        const { page, cdp, errors, close } = await open(panes.api);
        try {
          const first = (await stripOf(page)).open;
          const code = await page.evaluate(() => {
            for (const node of document.querySelectorAll<HTMLElement>(".chat-view pre, .chat-view .markdown-code *")) {
              if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) {
                node.scrollIntoView({ block: "center" });
                const box = node.getBoundingClientRect();
                return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
              }
            }
            return null;
          });
          assert.ok(code, "the fixture has a code block wider than a phone");
          await stroke(cdp, code, { x: -140, y: 0 });
          await atRest(page);
          assert.equal((await stripOf(page)).open, first, "a stroke on a code block that scrolls sideways scrolls it");
          // the block is at its start: a finger going right has nothing to scroll there, so that
          // stroke is the tabs' (this is the first tab, so the pane only gives a little)
          // the block's own momentum from that stroke ends first, then it is put back at its start
          await page.waitForTimeout(800);
          await page.evaluate(() => { for (const node of document.querySelectorAll<HTMLElement>(".chat-view *")) if (node.scrollLeft !== 0) node.scrollLeft = 0; });
          const back = await stroke(cdp, code, { x: 120, y: 0 }, { hold: true });
          assert.equal((await stripOf(page)).swipe, "end", "a stroke the block cannot scroll for goes to the tabs");
          await back();
          await atRest(page);
          assert.equal((await stripOf(page)).open, first);
          assert.deepEqual(errors, []);
          console.log("PASS a sideways-scrolling code block keeps a stroke it can scroll for, and passes on one it cannot");
        } finally { await close(); }
      }

      {
        // the terminal lens: the grid is not panned at this size, so the stroke is the tabs' there too
        const { page, cdp, errors, close } = await open(panes.shell, "terminal");
        try {
          const start = await stripOf(page);
          const [first, second] = start.tabs as [string, string];
          await openIs(page, first);
          await page.locator(".pane-terminal .xterm").first().waitFor();
          await stroke(cdp, { x: 300, y: 300 }, { x: -140, y: 0 });
          await openIs(page, second);
          await atRest(page);
          assert.deepEqual(errors, []);
          console.log("PASS a stroke over the terminal opens the tab beside");
        } finally { await close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
void repo;
