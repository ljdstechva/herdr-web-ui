import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright-core";
import { DEFAULT_VPS_THRESHOLDS, type VpsStatus } from "../shared/vps.ts";
import { buildDemoApp } from "./demo-build.ts";

// Real app over fictional demo panes. A finger's long press on the chat's words is the phone's own
// text selection (handles, Copy): nothing a finger does by holding opens pane actions, which a touch
// screen has on the ⋯ button only. Chrome's touch emulator makes the long press itself (the word is
// selected, a finger's contextmenu), and Android's touch drag of selected words is switched on. Chrome
// also sends a contextmenu of its own at a selection (Android: where a drag over the words ends; here
// the menu key makes the same kind): it says "mouse" and is aimed at the focused pane, and it opened
// pane actions over the words being selected. A mouse's right click keeps opening pane actions.
// A VPS alert is up throughout (it stays until dismissed): on a phone it must leave the tab strip
// and the ⋯ in reach.
const app = mkdtempSync(join(tmpdir(), "herdr-chat-selection-"));
const menu = ".row-menu, .row-sheet";
const vps: VpsStatus = {
  supported: true, hostname: "qa-server", sampled_at: Date.now(), uptime_seconds: 3600,
  cpu: { cores: 2, usage_percent: 10, average_percent: 10, load: [0.1, 0.1, 0.1] },
  memory: { total_bytes: 4e9, available_bytes: 1e9, used_percent: 75 },
  swap: { total_bytes: 10e9, used_bytes: 6.6e9, used_percent: 66 }, disks: [], top: [],
  issues: [{ id: "swap", kind: "swap", severity: "warning", title: "Swap is 66% used", detail: "6.6 GB of 10.0 GB in swap: the PC is short of memory", since: Date.now() }],
  severity: "warning", config: { alerts: false, thresholds: DEFAULT_VPS_THRESHOLDS },
};
const ANDROID = ["--enable-features=TouchDragAndContextMenu,TouchDragAndDrop", "--blink-settings=touchDragDropEnabled=true,touchDragEndContextMenu=true"];

/** Dispatches a press then its contextmenu on `selector`; true when nothing cancelled the menu event. */
async function press(page: Page, selector: string, pressedWith: "touch" | "mouse", menuSays: "touch" | "mouse" | "" | null): Promise<boolean> {
  return await page.locator(selector).first().evaluate((node, { pressedWith, menuSays }) => {
    const box = node.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: box.left + 8, clientY: box.top + 8 };
    const button = pressedWith === "mouse" ? 2 : 0;
    node.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: pressedWith, isPrimary: true, button }));
    // null: a MouseEvent, as older builds send it, with no pointerType at all
    const event = menuSays === null ? new MouseEvent("contextmenu", { ...at, button }) : new PointerEvent("contextmenu", { ...at, pointerType: menuSays, button });
    return node.dispatchEvent(event);
  }, { pressedWith, menuSays });
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.locator(menu).waitFor({ state: "detached" });
}

/** The middle of a chat word that nothing covers. */
async function chatWord(page: Page): Promise<{ x: number; y: number; word: string }> {
  const found = await page.evaluate(() => {
    const view = document.querySelector(".chat-view")!;
    const area = view.getBoundingClientRect();
    const walk = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
    for (let text = walk.nextNode(); text; text = walk.nextNode()) {
      if (!text.parentElement?.closest(".chat-turn p") || text.parentElement.closest("a, button, code")) continue;
      for (const match of (text.textContent ?? "").matchAll(/[A-Za-z]{5,}/g)) {
        const range = document.createRange();
        range.setStart(text, match.index);
        range.setEnd(text, match.index + match[0].length);
        const box = range.getBoundingClientRect();
        const x = box.left + box.width / 2, y = box.top + box.height / 2;
        if (box.top > area.top && box.bottom < area.bottom && document.elementFromPoint(x, y)?.closest(".chat-view")) return { x, y, word: match[0] };
      }
    }
    return null;
  });
  assert.ok(found, "a chat word is on screen");
  return found;
}

/** Waits until the chat's words stay put (the VPS status arriving moves the layout once). */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => new Promise<boolean>((resolve) => {
    const turn = () => document.querySelector(".chat-view .chat-turn:last-of-type")?.getBoundingClientRect().top;
    const first = turn();
    setTimeout(() => resolve(first !== undefined && turn() === first), 400);
  }), null, { polling: 100 });
}

/** Chrome's own finger: the touch emulator turns a held mouse into a touch with its long press. */
function finger(cdp: CDPSession) {
  // a held press is answered only once it lets go: the calls are not awaited
  const send = (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number): void => {
    void cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 }).catch(() => {});
  };
  return {
    async hold(page: Page, at: { x: number; y: number }, moveBy = 0): Promise<void> {
      send("mousePressed", at.x, at.y);
      await page.waitForTimeout(1_100);
      for (let step = 1; step <= 4 && moveBy; step += 1) {
        send("mouseMoved", at.x + (moveBy * step) / 4, at.y);
        await page.waitForTimeout(60);
      }
      send("mouseReleased", at.x + moveBy, at.y);
      await page.waitForTimeout(600);
    },
  };
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script src="./qa-vps.js"></script>\n    <script type="module"'));
  writeFileSync(join(app, "qa-vps.js"), `const demoFetch = window.fetch; window.fetch = (input, init) => String(input) === "/api/vps/status" ? Promise.resolve(Response.json(${JSON.stringify(vps)})) : demoFetch(input, init);`);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path.split("/").includes("..")) return new Response(null, { status: 404 });
    const file = Bun.file(join(app, path === "/" ? "index.html" : path));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ headless: true, args: ANDROID, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
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
          await page.locator(".vps-toast").waitFor();
          await settled(page);
          const words = ".chat-view .chat-turn-agent p, .chat-view .chat-turn p";
          const selected = (): Promise<string> => page.evaluate(() => String(getSelection()));
          if (touch) {
            const cdp = await context.newCDPSession(page);
            await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
            const hand = finger(cdp);
            const at = await chatWord(page);
            // 1. the long press selects the word, and only that
            await hand.hold(page, at);
            const first = await selected();
            assert.ok(first.includes(at.word) && first.length < at.word.length + 4, `a long press on a chat word selects it: "${first}" for "${at.word}"`);
            assert.equal(await page.locator(menu).count(), 0, "a long press on chat words opens no pane actions");
            // 2. holding the selection lifts it (Android's touch drag) and lifting sends a contextmenu: still the phone's
            await hand.hold(page, at);
            await hand.hold(page, at, 24);
            assert.equal(await page.locator(menu).count(), 0, "holding the selected words, still or dragging, opens no pane actions");
            // a fresh selection for the next step: the drag may have dropped the last one
            await page.evaluate(() => getSelection()?.removeAllRanges());
            await settled(page);
            const again = await chatWord(page);
            await hand.hold(page, again);
            const before = await selected();
            assert.ok(before.includes(again.word) && before.length < again.word.length + 4, `a long press selects a word again: "${before}" for "${again.word}"`);
            // 3. Chrome's own contextmenu at the selection says "mouse", aimed at the focused pane; Android draws
            //    its Copy bar from it, so it is left uncancelled
            await page.evaluate(() => {
              const said: string[] = (window as unknown as { said: string[] }).said = [];
              document.addEventListener("contextmenu", (event) => setTimeout(() => said.push(`${(event as PointerEvent).pointerType ?? ""}${event.defaultPrevented ? " (cancelled)" : ""}`)), { capture: true, once: true });
            });
            await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ContextMenu", code: "ContextMenu", windowsVirtualKeyCode: 93 });
            await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ContextMenu", code: "ContextMenu", windowsVirtualKeyCode: 93 });
            await page.waitForTimeout(400);
            assert.deepEqual(await page.evaluate(() => (window as unknown as { said: string[] }).said), ["mouse"], "Chrome's own contextmenu says it came from a mouse and is left to the phone");
            assert.equal(await page.locator(menu).count(), 0, "Chrome's own contextmenu at a finger's selection opens no pane actions");
            assert.equal(await selected(), before, "the selection is kept for Copy");
            await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: false });
            // 4. however the long press's contextmenu is labelled: PointerEvent, MouseEvent, "mouse" or nothing
            for (const says of ["touch", null, "mouse", ""] as const) {
              assert.equal(await press(page, words, "touch", says), true, `a long press on chat words keeps the phone's selection (contextmenu says ${JSON.stringify(says)})`);
              assert.equal(await page.locator(menu).count(), 0, `a long press on chat words opens no pane actions (contextmenu says ${JSON.stringify(says)})`);
            }
            // 5. the pane's title opens nothing either; its ⋯ button is the one way to pane actions, and the
            //    alert above the chat leaves it and the tab strip in reach
            await page.evaluate(() => getSelection()?.removeAllRanges());
            const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
            const alert = await box(".vps-toast");
            for (const control of [".tab-strip", '.pane-frame[data-layout-pane="w1C:p1"] .pane-frame-menu']) {
              const near = await box(control);
              assert.ok(alert.y >= near.y + near.height || alert.y + alert.height <= near.y, `the VPS alert leaves ${control} uncovered ${JSON.stringify({ alert, near })}`);
            }
            assert.equal(await press(page, '.pane-frame[data-layout-pane="w1C:p1"] .pane-frame-head', "touch", "touch"), false, "a long press on the title is taken");
            await page.waitForTimeout(300);
            assert.equal(await page.locator(menu).count(), 0, "a long press on the pane title opens no pane actions");
            await page.locator('.pane-frame[data-layout-pane="w1C:p1"] .pane-frame-menu').tap();
            await page.locator(menu).waitFor({ state: "visible" });
            assert.ok((await page.locator(menu).textContent())?.includes("Rename pane"), "the ⋯ button opens pane actions");
            await closeMenu(page);
          } else {
            // a touch screen laptop: a finger's long press is the selection's too
            assert.equal(await press(page, words, "touch", "touch"), true);
            assert.equal(await page.locator(menu).count(), 0, "a finger's long press on chat words opens no pane actions on a wide screen");
            // a mouse's right click on the chat is unchanged: pane actions
            assert.equal(await press(page, words, "mouse", "mouse"), false, "a right click on chat words opens pane actions");
            await page.locator(menu).waitFor({ state: "visible" });
            assert.ok((await page.locator(menu).textContent())?.includes("Rename pane"));
            await closeMenu(page);
          }
          assert.deepEqual(errors, [], "no runtime errors");
          console.log(`PASS ${width}px: ${touch ? "holding chat words (Chrome's long press, the selection's drag, its own contextmenu) selects them and opens nothing; ⋯ opens pane actions" : "a finger's long press is left to the selection, a right click opens pane actions"}`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
