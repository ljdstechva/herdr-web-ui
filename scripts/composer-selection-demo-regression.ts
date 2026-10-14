import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";

// Real app over fictional demo panes. Native OS menus are outside Playwright; verify that
// the events which open them reach the chat and terminal inputs uncancelled, without opening pane actions.
const app = mkdtempSync(join(tmpdir(), "herdr-composer-selection-"));
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
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390, locale: "en-US" });
        try {
          await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", terminalInputMode: "line" })));
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          for (const view of ["chat", "terminal"]) {
            await page.goto(`http://127.0.0.1:${server.port}/?pane=w1C:p1&view=${view}`);
            await page.locator(".conn-live").waitFor({ state: "attached" });
            const input = page.getByRole("textbox", { name: view === "chat" ? "Message" : "Terminal input line", exact: true });
            const pane = page.locator('.pane-frame[data-layout-pane="w1C:p1"]');
            const longDraft = "Draft select these words\n" + "More text to edit on the phone. ".repeat(30);
            for (const draft of ["", "Draft select these words", longDraft]) {
              await input.fill(draft);
              const start = draft ? 6 : 0, end = draft ? 12 : 0;
              await input.evaluate((node: HTMLTextAreaElement, range) => node.setSelectionRange(...range), [start, end] as [number, number]);
              for (const type of ["mousedown", "contextmenu", "mouseup"]) {
                const allowed = await input.evaluate((node, type) => node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 2 })), type);
                assert.equal(allowed, true, `${width}px ${view}: ${type} in the input keeps native text editing`);
              }
              assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "editing text opens no pane actions");
              assert.deepEqual(await input.evaluate((node: HTMLTextAreaElement) => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd, focused: node === document.activeElement })),
                { value: draft, start, end, focused: true }, "the draft, selection and keyboard focus survive");
            }
            await page.keyboard.insertText("replace");
            assert.equal(await input.inputValue(), longDraft.replace("select", "replace"), "typing replaces only the selected word in a long draft");
            if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${view}-selection-${width}.png`) });
            // Keep both the ordinary pane menu and xterm's hidden textarea under pane ownership.
            for (const selector of [".pane-frame-head", ".xterm-helper-textarea"]) {
              assert.equal(await pane.locator(selector).evaluate((node) => node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }))), false);
              const menu = page.locator(".row-menu, .row-sheet");
              await menu.waitFor({ state: "visible" });
              assert.ok((await menu.textContent())?.includes("Rename pane"), "pane actions remain available outside the input boxes");
              await page.keyboard.press("Escape");
              await menu.waitFor({ state: "detached" });
            }
            assert.deepEqual(errors, [], "no runtime errors");
            console.log(`PASS ${width}px ${view}: native editing preserves draft/selection/focus; pane and terminal menus still work`);
          }
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
