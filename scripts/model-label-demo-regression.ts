import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";

// The composer's model label on a phone, on the unmodified app over the demo's fixture transport:
// the whole label is the control, the model and its level are always drawn, and Codex's Fast mode
// is toggled from it and shown by a bolt only while it is on. All files and HTTP traffic stay in
// this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-model-label-demo-"));

interface Label { model: string | null; modelWidth: number; effort: string | null; effortWidth: number; clipped: boolean; fast: boolean; ownRow: boolean; note: string | null }

const labelOf = (page: Page): Promise<Label> => page.evaluate(() => {
  const status = document.querySelector<HTMLElement>(".composer-status")!;
  const model = status.querySelector<HTMLElement>(".composer-model");
  const effort = status.querySelector<HTMLElement>(".composer-reasoning-short");
  const level = status.querySelector<HTMLElement>(".composer-reasoning");
  return {
    model: model?.textContent ?? null, modelWidth: model?.getBoundingClientRect().width ?? 0,
    effort: effort?.textContent ?? null, effortWidth: effort?.getBoundingClientRect().width ?? 0,
    clipped: (model !== null && model.scrollWidth > model.clientWidth) || (level !== null && level.scrollWidth > level.clientWidth),
    fast: status.querySelector(".composer-fast") !== null,
    ownRow: document.querySelector(".composer-surface")!.hasAttribute("data-status-row"),
    note: document.querySelector(".composer-note")?.textContent ?? null,
  };
});

/** The sheet's items as drawn: label and hint. */
const sheetOf = (page: Page): Promise<string[]> => page.locator(".row-sheet-item").evaluateAll((items) =>
  items.map((item) => `${item.querySelector(".row-sheet-label")?.textContent ?? ""} | ${item.querySelector(".row-sheet-hint")?.textContent ?? ""}`));

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // counts what the page asks of the bridge, and answers the Fast mode toggle as a PC would whose
  // Codex binds no key to it, or whose Codex takes the key and changes nothing
  const watch = `<script>(() => {
    const demo = window.fetch.bind(window);
    window.fastCalls = 0; window.fastAnswer = "demo"; window.submitted = [];
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/pane/fast")) {
        window.fastCalls += 1;
        if (window.fastAnswer === "unbound") return new Response(JSON.stringify({ error: { code: "fast_unbound", message: "Codex binds no key to its Fast mode toggle on this PC." } }), { status: 409, headers: { "content-type": "application/json" } });
        if (window.fastAnswer === "ignored") return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return demo(input, init);
    };
    const Demo = window.WebSocket;
    const Watching = function (url, protocols) {
      const socket = new Demo(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (data) => { const message = typeof data === "string" ? JSON.parse(data) : null; if (message && message.type === "submit") window.submitted.push(message.text); send(data); };
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Watching, name, { value: Demo[name] });
    window.WebSocket = Watching;
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${watch}\n    <script type="module"`));

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
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      /** A phone on an agent at rest of the kind asked for, in the chat. */
      const open = async (width: number, kind: "codex" | "claude"): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> => {
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
        await context.addInitScript(() => { localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })); });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const made = await page.evaluate(async (agent) => (await (await fetch("/api/workspace/create", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: `/home/demo/label-${agent}`, label: `label-${agent}`, agent: { kind: agent } }),
        })).json()) as { pane_id: string }, kind);
        // the same row click the sidebar gets: a reload would start the demo over
        const row = page.locator(`.pane-select[title^="${made.pane_id} —"]`).first();
        await row.waitFor({ state: "attached" });
        await row.evaluate((node: HTMLElement) => node.click());
        await page.locator(`.pane-select[title^="${made.pane_id} —"][aria-current="true"]`).first().waitFor({ state: "attached" });
        if (await page.locator(".terminal-stack.is-chat").count() === 0) await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).tap();
        await page.locator(".composer-pill-button:not(:disabled)").waitFor();
        await appFaces(page);
        return { page, errors, close: () => context.close() };
      };
      const closeSheet = async (page: Page): Promise<void> => {
        await page.locator(".row-sheet").getByRole("button", { name: "Cancel", exact: true }).tap();
        await page.locator(".row-sheet").waitFor({ state: "detached" });
      };
      const pick = async (page: Page, label: RegExp): Promise<void> => {
        await page.locator(".composer-pill-button").tap();
        await page.locator(".row-sheet-item").filter({ hasText: label }).tap();
        await page.locator(".row-sheet").waitFor({ state: "detached" });
      };

      {
        const { page, errors, close } = await open(390, "codex");
        try {
          const rest = await labelOf(page);
          assert.ok(rest.model && rest.modelWidth > 1 && rest.effort && rest.effortWidth > 1 && !rest.clipped, `the model and its level are both drawn: ${JSON.stringify(rest)}`);
          assert.equal(rest.fast, false, "no bolt while Fast mode is off");
          // the whole label is the control: the agent's mark, the level and the caret open it as the name does
          for (const part of [".agent-mark", ".composer-reasoning-short", ".composer-pick-caret", ".composer-model"]) {
            await page.locator(`.composer-pill-button ${part}`).tap();
            await page.locator(".row-sheet").waitFor();
            await closeSheet(page);
          }
          // and so does its edge, where a finger lands beside the words
          const button = (await page.locator(".composer-pill-button").boundingBox())!;
          const pill = (await page.locator(".composer-pill").boundingBox())!;
          assert.ok(button.x <= pill.x + 0.5 && button.height >= pill.height - 0.5, `the control reaches the pill's edge and height: ${JSON.stringify({ button, pill })}`);
          await page.touchscreen.tap(pill.x + 8, pill.y + pill.height / 2);
          await page.locator(".row-sheet").waitFor();
          await closeSheet(page);
          await page.touchscreen.tap(button.x + button.width / 2, pill.y + pill.height - 2);
          await page.locator(".row-sheet").waitFor();
          assert.deepEqual(await sheetOf(page), [`Change model and reasoning (/model) | ${rest.model} · ${rest.effort}`, "Turn Fast mode on | Off"]);
          await closeSheet(page);
          console.log("PASS a tap anywhere on the label opens what can be changed, with the model and its level both drawn");

          await pick(page, /Turn Fast mode on/);
          await page.locator(".composer-fast").waitFor();
          assert.equal(await page.evaluate(() => (window as unknown as { fastCalls: number }).fastCalls), 1);
          // it stays once the pane has said so itself, with no note
          await page.waitForTimeout(2_600);
          const on = await labelOf(page);
          assert.ok(on.fast && on.note === null && !on.clipped && on.effortWidth > 1, `the bolt stands with the model and the level: ${JSON.stringify(on)}`);
          await page.locator(".composer-pill-button").tap();
          assert.deepEqual((await sheetOf(page)).at(-1), "Turn Fast mode off | On");
          await page.locator(".row-sheet-item").filter({ hasText: /Turn Fast mode off/ }).tap();
          await page.locator(".composer-fast").waitFor({ state: "detached" });
          assert.equal(await page.evaluate(() => (window as unknown as { fastCalls: number }).fastCalls), 2);
          console.log("PASS Fast mode is turned on and off from the label, and its bolt is drawn only while it is on");

          await pick(page, /Change model and reasoning/);
          await page.waitForFunction(() => (window as unknown as { submitted: string[] }).submitted.includes("/model"));
          console.log("PASS the model item sends Codex's own /model");

          // a PC whose Codex binds no key to the toggle: nothing is claimed, and the way to set one is said
          await page.evaluate(() => { (window as unknown as { fastAnswer: string }).fastAnswer = "unbound"; });
          await pick(page, /Turn Fast mode on/);
          await page.locator(".composer-note").waitFor();
          const unbound = await labelOf(page);
          assert.match(unbound.note ?? "", /^Fast mode needs a key in Codex\./);
          assert.equal(unbound.fast, false);
          // a Codex that takes the key and changes nothing (one started before the key was set): the bolt does not stay
          await page.evaluate(() => { (window as unknown as { fastAnswer: string }).fastAnswer = "ignored"; });
          await pick(page, /Turn Fast mode on/);
          await page.locator(".composer-fast").waitFor();
          await page.locator(".composer-fast").waitFor({ state: "detached", timeout: 12_000 });
          assert.match((await labelOf(page)).note ?? "", /^Fast mode did not change\./);
          assert.deepEqual(errors, []);
          console.log("PASS an unbound toggle and one the pane ignores are said, and never drawn as on");
        } finally { await close(); }
      }

      {
        // a narrow phone: where the label does not fit beside the controls it takes a row of its own, whole
        const { page, errors, close } = await open(320, "codex");
        try {
          await pick(page, /Turn Fast mode on/);
          await page.locator(".composer-fast").waitFor();
          await page.waitForFunction(() => document.querySelector(".composer-surface")?.hasAttribute("data-status-row") === true, null, { timeout: 5_000 });
          const narrow = await labelOf(page);
          assert.ok(narrow.ownRow && narrow.fast && narrow.effortWidth > 1 && narrow.modelWidth > 1 && !narrow.clipped, `the model, the level and the bolt are all drawn on their own row: ${JSON.stringify(narrow)}`);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "nothing overflows sideways");
          assert.deepEqual(errors, []);
          console.log("PASS on a 320px phone the label takes a row of its own, with the model, the level and the bolt whole");
        } finally { await close(); }
      }

      {
        // Claude Code has a picker for each and no Fast mode
        const { page, errors, close } = await open(390, "claude");
        try {
          const rest = await labelOf(page);
          await page.locator(".composer-pill-button .agent-mark").tap();
          await page.locator(".row-sheet").waitFor();
          assert.deepEqual(await sheetOf(page), [`Change model (/model) | ${rest.model}`, `Change reasoning effort (/effort) | ${rest.effort}`]);
          await page.locator(".row-sheet-item").filter({ hasText: /Change reasoning effort/ }).tap();
          await page.waitForFunction(() => (window as unknown as { submitted: string[] }).submitted.includes("/effort"));
          assert.equal(await page.evaluate(() => (window as unknown as { fastCalls: number }).fastCalls), 0);
          assert.equal((await labelOf(page)).fast, false);
          assert.deepEqual(errors, []);
          console.log("PASS Claude Code's label offers its model and its effort, and no Fast mode");
        } finally { await close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
