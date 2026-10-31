import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";

// Real app over fictional demo panes. The demo's Claude pane runs a subagent and a background
// command: a row of the "what is running" line over the message box, and of the status line's
// background list, opens a look inside (TaskView): the subagent's own conversation, drawn as the
// chat draws turns, and what the command printed. The chat's answers list (top right) jumps back
// to an answer and marks it. Phone and desktop widths; nothing may leave the screen sideways.
const app = mkdtempSync(join(tmpdir(), "herdr-task-view-"));
const PANE = "w1C:p1";

async function noSideways(page: Page, what: string): Promise<void> {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(wide <= 0, `${what}: nothing runs off the screen sideways (${wide}px)`);
}

async function goBack(page: Page, how: "escape" | "button"): Promise<void> {
  if (how === "escape") await page.keyboard.press("Escape");
  else await page.locator(".task-view-back").click();
  await page.locator(".task-view").waitFor({ state: "detached" });
  await page.locator(".chat-view .chat-turn").first().waitFor();
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
      for (const width of [360, 390, 1280]) {
        const touch = width < 1000;
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: touch, hasTouch: touch, locale: "en-US" });
        try {
          await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/?pane=${PANE}&view=chat&demo-tasks`);
          await page.locator(".chat-view .chat-turn").first().waitFor();

          // 1. the "what is running" line: its rows open the subagent and the command
          await page.locator("button.agent-activity-bar").click();
          // who is who: the main agent first with its state, then each subagent and command with theirs
          const main = page.locator(".agent-activity-task.is-main");
          await main.waitFor();
          assert.match(await main.innerText(), /main agent[\s\S]*working/i);
          assert.match(await page.locator(".agent-activity-task-open", { hasText: "Find every caller" }).innerText(), /subagent[\s\S]*running/i);
          assert.match(await page.locator(".agent-activity-task-open", { hasText: "bun test" }).innerText(), /command[\s\S]*running/i);
          for (const row of await page.locator(".agent-activity-task").all()) {
            const box = (await row.boundingBox())!;
            assert.ok(box.x >= 0 && box.x + box.width <= width + 0.5, `${width}px: a list row fits the screen`);
            if (touch) assert.ok(box.height >= 40, `${width}px: a list row is a finger's height (${box.height})`);
          }
          await noSideways(page, `${width}px working list`);
          // the reader's place in the main chat, which Back must find again
          await page.locator(".chat-view").evaluate((node) => { node.scrollTop = Math.max(0, node.scrollHeight / 3); });
          const subagent = page.locator(".agent-activity-task-open", { hasText: "Find every caller" });
          await subagent.click();
          const view = page.locator(".task-view");
          await view.waitFor();
          // it takes the chat's place: the same box, no dialog over the page, the composer still below
          assert.equal(await page.locator("[aria-modal='true']").count(), 0, "no dialog: the view is in the chat's place");
          const chatBox = (await page.locator(".chat-view").boundingBox())!;
          const viewBox = (await view.boundingBox())!;
          for (const side of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(chatBox[side] - viewBox[side]) <= 1, `${width}px: the view covers the chat exactly (${side} ${viewBox[side]} vs ${chatBox[side]})`);
          assert.ok(await page.locator(".composer-text").isVisible(), "the message box stays under it");
          // measured once the list folded: a shorter list makes the chat taller, which moves no reader
          const chatScroll = await page.locator(".chat-view").evaluate((node) => node.scrollTop);
          assert.equal(await page.locator(".agent-activity-list").count(), 0, "the list folds away after a pick: the view has the room");
          await page.locator("button.agent-activity-bar").click();
          assert.equal(await subagent.getAttribute("aria-current"), "true", "its row says it is the one shown");
          await page.locator("button.agent-activity-bar").click();
          assert.match(await page.locator(".task-view-back").innerText(), /Back to Claude/);
          await view.locator(".chat-turn-user", { hasText: "idempotency key" }).waitFor();
          await view.locator(".chat-turn-agent", { hasText: "Three callers so far" }).waitFor();
          assert.match(await view.locator(".task-view-title").innerText(), /Find every caller of charge\(\)/);
          await noSideways(page, `${width}px subagent view`);
          if (touch) {
            const back = (await page.locator(".task-view-back").boundingBox())!;
            assert.ok(back.height >= 40, `${width}px: Back is a finger's height (${back.height})`);
            const menu = await page.locator(`.pane-frame[data-layout-pane="${PANE}"] .pane-frame-menu`).boundingBox();
            if (menu !== null) assert.ok(back.x + back.width <= menu.x || back.y >= menu.y + menu.height, `${width}px: Back stays clear of the pane's ⋯`);
          }
          assert.match(await view.locator(".task-view-meta").innerText(), /subagent/);
          // another row switches the view in place, from subagent to command
          if (!(await page.locator(".agent-activity-list").isVisible())) await page.locator("button.agent-activity-bar").click();
          await page.locator(".agent-activity-task-open", { hasText: "bun test server/payments" }).click();
          await page.locator(".task-view .task-view-output", { hasText: "charges once per key" }).waitFor();
          assert.equal(await page.locator(".task-view .chat-turn").count(), 0, "the command's view holds no subagent turns");
          assert.equal(await page.locator(".task-view").count(), 1, "one view at a time");
          await goBack(page, "button");
          const back = await page.locator(".chat-view").evaluate((node) => node.scrollTop);
          assert.ok(Math.abs(back - chatScroll) <= 2, `${width}px: Back returns to the chat where it was read (${back} vs ${chatScroll})`);

          if (!(await page.locator(".agent-activity-list").isVisible())) await page.locator("button.agent-activity-bar").click();
          await page.locator(".agent-activity-task-open", { hasText: "Find every caller" }).click();
          await page.locator(".task-view .chat-turn-agent", { hasText: "Three callers so far" }).waitFor();
          // the main agent's row is the other way back
          await page.locator("button.agent-activity-bar").click();
          await page.locator(".agent-activity-task.is-main button").click();
          await page.locator(".task-view").waitFor({ state: "detached" });
          await page.locator(".agent-activity-list").waitFor({ state: "detached" });
          if (!(await page.locator(".agent-activity-list").isVisible())) await page.locator("button.agent-activity-bar").click();
          await page.locator(".agent-activity-task-open", { hasText: "Find every caller" }).click();
          await page.locator(".task-view .chat-turn-agent", { hasText: "Three callers so far" }).waitFor();
          await goBack(page, "escape");

          // 2. the status line's background list opens the same look inside
          await page.locator(".bg-tasks-toggle").click();
          await page.locator(".bg-task-open", { hasText: "Find every caller" }).click();
          await page.locator(".task-view .chat-turn-agent", { hasText: "Three callers so far" }).waitFor();
          assert.equal(await page.locator(".bg-tasks-menu").count(), 0, "the list makes way for the look inside");
          await goBack(page, "button");

          // 3. the answers list: a pick scrolls to the answer and marks it, and the list closes
          const toggle = page.locator(".chat-outline-toggle");
          await toggle.waitFor();
          // it stays clear of the pane's own ⋯ at the same corner
          const menu = await page.locator(`.pane-frame[data-layout-pane="${PANE}"] .pane-frame-menu`).boundingBox();
          const own = (await toggle.boundingBox())!;
          if (menu !== null) assert.ok(own.y >= menu.y + menu.height || own.x + own.width <= menu.x, `${width}px: the answers button does not cover the pane's ⋯`);
          await toggle.click();
          const items = page.locator(".chat-outline-item");
          await items.first().waitFor();
          assert.ok(await items.count() >= 1, "the answers list has the agent's answers");
          assert.match(await items.first().innerText(), /Done\. Retries are now safe/);
          const panel = (await page.locator(".chat-outline").boundingBox())!;
          assert.ok(panel.x >= 0 && panel.x + panel.width <= width + 0.5, `${width}px: the answers list fits the screen`);
          await noSideways(page, `${width}px answers list`);
          await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await items.first().click();
          await page.locator(".chat-outline").waitFor({ state: "detached" });
          const picked = page.locator(".chat-transcript [data-picked]");
          await picked.waitFor();
          assert.match(await picked.innerText(), /Retries are now safe/);
          await page.waitForFunction(() => {
            const node = document.querySelector(".chat-transcript [data-picked]");
            const area = document.querySelector(".chat-view")?.getBoundingClientRect();
            const box = node?.getBoundingClientRect();
            return box !== undefined && area !== undefined && box.top >= area.top - 1 && box.top < area.bottom - 40;
          });
          // Escape closes an open list too
          await toggle.click();
          await page.locator(".chat-outline").waitFor();
          await page.keyboard.press("Escape");
          await page.locator(".chat-outline").waitFor({ state: "detached" });
          assert.deepEqual(errors, [], "no page errors");
          console.log(`ok ${width}px: subagent and command open in the chat's place from both lists, Back returns; the answers list jumps`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
