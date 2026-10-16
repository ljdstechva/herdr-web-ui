import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

// Send is felt at once (src/lib/outbox.ts), on the unmodified app over the demo's fixture
// transport: the box empties and the message stands in the chat in the same task as the tap,
// however late the bridge answers. Every submit here reaches the demo bridge LAG_MS late, so
// that its transcript line and its receipt both wait as they do on a real PC. All files and HTTP
// traffic stay in this disposable, loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-instant-send-demo-"));
const LAG_MS = 900;

interface Chat {
  box: string;
  note: string | null;
  /** every message on its way: its text and what its status line says */
  outgoing: Array<{ text: string; status: string }>;
  /** the transcript's own user turns, in order */
  sent: string[];
  pending: string[];
}

const chatOf = (page: Page): Promise<Chat> => page.evaluate(() => ({
  box: document.querySelector<HTMLTextAreaElement>(".composer-text")?.value ?? "",
  note: document.querySelector(".composer-note")?.textContent ?? null,
  outgoing: [...document.querySelectorAll(".chat-outgoing")].map((node) => ({
    text: node.querySelector(".chat-bubble")?.textContent ?? "",
    status: node.querySelector(".chat-outgoing-status")?.textContent ?? "",
  })),
  sent: [...document.querySelectorAll(".chat-turn-user:not(.chat-outgoing) .chat-bubble")].map((node) => node.textContent ?? ""),
  pending: [...document.querySelectorAll(".pending-message-bubble")].map((node) => node.textContent ?? ""),
}));

/**
 * Types into the box and taps Send; answers with the page as it stands once the tap's own task
 * has ended (React commits a store's change in a microtask of it): no frame, timer or network
 * answer has passed.
 */
const send = (page: Page, text: string): Promise<Chat & { submits: number }> => page.evaluate(async (message) => {
  const box = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
  // the same write React's own onChange reads
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, message);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector<HTMLButtonElement>(".composer-send")!.click();
  const emptied = box.value;
  await new Promise<void>((done) => queueMicrotask(done));
  const drawn = {
    outgoing: [...document.querySelectorAll(".chat-outgoing")].map((node) => ({
      text: node.querySelector(".chat-bubble")?.textContent ?? "",
      status: node.querySelector(".chat-outgoing-status")?.textContent ?? "",
    })),
  };
  // the frame itself leaves a few microtasks on (the socket first checks what the bridge offers)
  await new Promise<void>((done) => setTimeout(done, 0));
  return {
    box: emptied + box.value,
    note: document.querySelector(".composer-note")?.textContent ?? null,
    outgoing: drawn.outgoing,
    sent: [...document.querySelectorAll(".chat-turn-user:not(.chat-outgoing) .chat-bubble")].map((node) => node.textContent ?? ""),
    pending: [...document.querySelectorAll(".pending-message-bubble")].map((node) => node.textContent ?? ""),
    submits: (window as unknown as { submitsSeen: number }).submitsSeen,
  };
}, text);

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  const lag = `<script>(() => {
    const Demo = window.WebSocket;
    window.refuseSubmits = false;
    window.submitsSeen = 0;
    const Lagging = function (url, protocols) {
      const socket = new Demo(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        const message = typeof data === "string" ? JSON.parse(data) : null;
        if (message === null || message.type !== "submit") { send(data); return; }
        window.submitsSeen += 1;
        const refuse = window.refuseSubmits;
        setTimeout(() => {
          if (refuse) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "submit-result", id: message.id, pane_id: message.pane_id, ok: false, code: "submit_failed", message: "refused by the test" }) }));
          else send(data);
        }, ${LAG_MS});
      };
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Lagging, name, { value: Demo[name] });
    window.WebSocket = Lagging;
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${lag}\n    <script type="module"`));

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
  const url = (pane: string): string => `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(pane)}&view=chat`;
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      const open = async (pane: string): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> => {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
        await context.addInitScript(() => { localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })); });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url(pane));
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".terminal-stack.is-chat").waitFor();
        await page.locator(".composer-text").waitFor();
        await page.locator(".chat-view[role='log']").waitFor();
        await page.waitForFunction(() => document.querySelector(".chat-inline-state") === null);
        await appFaces(page);
        return { page, errors, close: () => context.close() };
      };
      const settled = (page: Page): Promise<unknown> => page.waitForFunction(() => document.querySelector(".chat-outgoing") === null, null, { timeout: 15_000 });

      {
        // an agent at rest: the message goes into the pane
        const { page, errors, close } = await open(panes.infra);
        try {
          const before = await chatOf(page);
          const tapped = await send(page, "first on its way");
          assert.equal(tapped.box, "", "the box is empty as the tap returns");
          assert.deepEqual(tapped.outgoing, [{ text: "first on its way", status: "Sending…" }], "the message stands in the chat, marked as sending");
          assert.equal(tapped.submits, 1, "and it is on its way to the pane by the next task");
          assert.equal(tapped.note, null);
          // the next message is typed and sent while the first still has no answer
          const second = await send(page, "second right behind");
          assert.equal(second.box, "");
          assert.deepEqual(second.outgoing.map((message) => message.text), ["first on its way", "second right behind"], "both stand in the order they were sent");
          assert.equal(second.submits, 1, "the second waits for the first's answer: one submit is out");
          console.log("PASS Send empties the box and shows the message as sending in the tap's own task; a second message queues behind it");

          const visible = await page.evaluate(() => {
            const view = document.querySelector(".chat-view")!.getBoundingClientRect();
            const last = [...document.querySelectorAll(".chat-outgoing")].at(-1)!.getBoundingClientRect();
            return last.bottom <= view.bottom + 1 && last.top >= view.top;
          });
          assert.equal(visible, true, "the newest message on its way is inside the transcript's view");

          await settled(page);
          const after = await chatOf(page);
          assert.deepEqual(after.sent.slice(before.sent.length), ["first on its way", "second right behind"], "the transcript holds each once, in order");
          assert.equal(after.box, "");
          assert.equal(after.note, null);
          assert.equal(await page.evaluate(() => (window as unknown as { submitsSeen: number }).submitsSeen), 2);
          assert.deepEqual(errors, []);
          console.log("PASS the transcript's own turns take the place of both, once each and in order");
        } finally { await close(); }
      }

      {
        // the reader had scrolled up: their own message still comes into view
        const { page, errors, close } = await open(panes.api);
        try {
          await page.evaluate(() => { const view = document.querySelector(".chat-view")!; view.scrollTop = 0; view.dispatchEvent(new Event("scroll")); });
          const tapped = await send(page, "sent from far up the transcript");
          assert.equal(tapped.outgoing.length, 1);
          const visible = await page.evaluate(() => {
            const view = document.querySelector(".chat-view")!.getBoundingClientRect();
            const last = document.querySelector(".chat-outgoing")!.getBoundingClientRect();
            return last.bottom <= view.bottom + 1 && last.top >= view.top;
          });
          assert.equal(visible, true, "a message sent while scrolled up is brought into view");
          // this agent is working: the bridge takes the message into its waiting list, whose row then shows it
          await settled(page);
          await page.locator(".pending-message-bubble").waitFor();
          const after = await chatOf(page);
          assert.deepEqual(after.pending, ["sent from far up the transcript"]);
          assert.equal(after.box, "");
          assert.deepEqual(errors, []);
          console.log("PASS a message sent while scrolled up comes into view, and one the bridge queues moves to its waiting row");
        } finally { await close(); }
      }

      {
        // refused: everything that was not sent is back in the box, in order, with the reason
        const { page, errors, close } = await open(panes.infra);
        try {
          const before = await chatOf(page);
          await page.evaluate(() => { (window as unknown as { refuseSubmits: boolean }).refuseSubmits = true; });
          await send(page, "refused one");
          const second = await send(page, "never left");
          assert.deepEqual(second.outgoing.map((message) => message.text), ["refused one", "never left"]);
          await page.locator(".composer-text").pressSequentially("typed since");
          await settled(page);
          const after = await chatOf(page);
          assert.equal(after.box, "refused one\nnever left\ntyped since", "the refused message, the one behind it and the draft, in the order they were written");
          assert.equal(after.note, "Not sent: refused by the test");
          assert.deepEqual(after.sent, before.sent, "nothing joined the transcript");
          assert.equal(await page.evaluate(() => (window as unknown as { submitsSeen: number }).submitsSeen), 1, "the message behind a refused one is never sent");
          assert.deepEqual(errors, []);
          console.log("PASS a refused message returns to the box with the one behind it and the reason, and nothing is sent after it");
        } finally { await close(); }
      }

      {
        // the page goes away before the answer: the message is back in the box, and says so
        const { page, errors, close } = await open(panes.infra);
        try {
          await send(page, "caught by a reload");
          await page.reload();
          await page.locator(".composer-text").waitFor();
          await page.locator(".composer-note").waitFor();
          const after = await chatOf(page);
          assert.equal(after.box, "caught by a reload");
          assert.match(after.note ?? "", /^Not confirmed: the page reloaded/);
          assert.deepEqual(after.outgoing, [], "nothing is shown as on its way, and nothing is sent again");
          assert.equal(await page.evaluate(() => (window as unknown as { submitsSeen: number }).submitsSeen), 0);
          assert.deepEqual(errors, []);
          console.log("PASS a message whose page reloaded before the answer is back in the box, not sent again");
        } finally { await close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
