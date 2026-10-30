import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";

// Real app over fictional demo panes. A finger's long press on the chat's words is the phone's own
// text selection (handles, Copy): its contextmenu must reach the browser uncancelled and open no pane
// actions. The pane title and a mouse's right click keep opening pane actions.
const app = mkdtempSync(join(tmpdir(), "herdr-chat-selection-"));
const menu = ".row-menu, .row-sheet";

/** Dispatches a press then its contextmenu on `selector`; true when nothing cancelled the menu event. */
async function press(page: Page, selector: string, pointerType: "touch" | "mouse", asPointerEvent: boolean): Promise<boolean> {
  return await page.locator(selector).first().evaluate((node, { pointerType, asPointerEvent }) => {
    const box = node.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: box.left + 8, clientY: box.top + 8 };
    node.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType, isPrimary: true, button: pointerType === "mouse" ? 2 : 0 }));
    const button = pointerType === "mouse" ? 2 : 0;
    const event = asPointerEvent ? new PointerEvent("contextmenu", { ...at, pointerType, button }) : new MouseEvent("contextmenu", { ...at, button });
    return node.dispatchEvent(event);
  }, { pointerType, asPointerEvent });
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.locator(menu).waitFor({ state: "detached" });
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path.split("/").includes("..")) return new Response(null, { status: 404 });
    const file = Bun.file(join(app, path === "/" ? "index.html" : path));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    try {
      for (const width of [390, 1280]) {
        const touch = width === 390;
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: touch, hasTouch: touch, locale: "en-US" });
        try {
          await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/?pane=w1C:p1&view=chat`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.locator(".chat-view .chat-turn").first().waitFor();
          const words = ".chat-view .chat-turn-agent p, .chat-view .chat-turn p";
          if (touch) {
            // Chrome on Android sends the long press's contextmenu as a PointerEvent; older builds as a MouseEvent after the touch's pointerdown
            for (const asPointerEvent of [true, false]) {
              assert.equal(await press(page, words, "touch", asPointerEvent), true, `a long press on chat words keeps the phone's selection (${asPointerEvent ? "PointerEvent" : "MouseEvent"})`);
              assert.equal(await page.locator(menu).count(), 0, "a long press on chat words opens no pane actions");
            }
            // (desktop Chromium draws no long press from emulated touch: the selection itself is the phone's to show)
            // the pane's title keeps its long-press menu
            assert.equal(await press(page, '.pane-frame[data-layout-pane="w1C:p1"] .pane-frame-head', "touch", true), false);
            await page.locator(menu).waitFor({ state: "visible" });
            assert.ok((await page.locator(menu).textContent())?.includes("Rename pane"), "a long press on the pane title still opens pane actions");
            await closeMenu(page);
          } else {
            // a mouse's right click on the chat is unchanged: pane actions
            assert.equal(await press(page, words, "mouse", true), false, "a right click on chat words opens pane actions");
            await page.locator(menu).waitFor({ state: "visible" });
            assert.ok((await page.locator(menu).textContent())?.includes("Rename pane"));
            await closeMenu(page);
          }
          assert.deepEqual(errors, [], "no runtime errors");
          console.log(`PASS ${width}px: ${touch ? "a finger's long press on chat words is left to the phone; the title keeps pane actions" : "a right click on the chat opens pane actions"}`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
