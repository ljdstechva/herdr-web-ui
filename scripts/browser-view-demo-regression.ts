import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";

// Real app, fictional panes, controlled discovery responses. No user's terminal or display.
const app = mkdtempSync(join(tmpdir(), "herdr-browser-view-demo-"));
let status = 200;
let requests = 0;
let hanging = false;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, `<script>window.browserTestFetch = window.fetch.bind(window);</script>
    <script src="./demo-transport.js"></script>
    <script>
      const demoFetch = window.fetch;
      window.fetch = (input, init) => {
        const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        if (location.search.includes('connecting=1') && (path === '/api/health' || path === '/api/machines')) return Promise.reject(new TypeError('Test bridge unavailable'));
        return path === '/api/browsers' ? window.browserTestFetch(input, init) : demoFetch(input, init);
      };
    </script>
    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 60, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/browsers") {
      requests++;
      if (hanging) await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }));
      return Response.json(status === 200 ? { browsers: [] } : { error: { code: status === 403 ? "read_only" : "not_available", message: "Browser discovery unavailable" } }, { status });
    }
    const name = decodeURIComponent(path === "/" ? "/index.html" : path);
    if (name.split("/").includes("..")) return new Response(null, { status: 404 });
    const file = Bun.file(join(app, name));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
    try {
      for (const width of [320, 390, 768, 1280]) {
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 769, hasTouch: width < 769, locale: "en-US" });
        try {
          await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          status = 200;
          requests = 0;
          await page.goto(`http://127.0.0.1:${server.port}/?pane=w1C:p1&view=chat`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const opener = page.getByRole("button", { name: "Open the server's browser", exact: true });
          await opener.waitFor({ state: "visible", timeout: 5000 });
          assert.equal(await opener.count(), 1, "one persistent browser entry point");
          if (width > 768) await page.getByRole("button", { name: "Hide workspace list", exact: true }).click();
          await opener.click();
          const dialog = page.getByRole("dialog", { name: "Browser on the server", exact: true });
          await dialog.getByText("No browser is open on the server right now.", { exact: true }).waitFor();
          assert.ok(requests > 0, "opening the viewer discovers browsers");
          const retry = dialog.getByRole("button", { name: "Retry", exact: true });
          for (const failure of [404, 403, 503]) {
            status = failure;
            await retry.click();
            await dialog.getByRole("alert").waitFor();
            // Recovery must work without reloading, including after a 403/404.
            status = 200;
            await dialog.getByRole("alert").waitFor({ state: "hidden", timeout: 7000 });
            await dialog.getByText("No browser is open on the server right now.", { exact: true }).waitFor();
          }
          if (width === 390) {
            hanging = true;
            await retry.click();
            await dialog.getByRole("alert").waitFor({ timeout: 15000 });
            hanging = false;
            await retry.click();
            await dialog.getByRole("alert").waitFor({ state: "hidden" });
          }
          await dialog.getByRole("button", { name: "Close", exact: true }).click();
          assert.equal(await opener.evaluate((node) => node === document.activeElement), true, "close returns focus to the visible opener");
          const box = await opener.boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 844, "icon stays within viewport with sidebar closed");
          // With no pane selected, the brand and machine name must still leave room for it.
          await page.evaluate(async () => {
            const { snapshot } = await (await fetch("/api/session")).json();
            for (const workspace of snapshot.workspaces) {
              const response = await fetch("/api/workspace/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: workspace.workspace_id, close_group: true }) });
              if (!response.ok && response.status !== 404) throw new Error("Could not close a demo workspace");
            }
          });
          await page.locator(".view-switch").waitFor({ state: "hidden" });
          await opener.click();
          await dialog.getByText("No browser is open on the server right now.", { exact: true }).waitFor();
          await dialog.getByRole("button", { name: "Close", exact: true }).click();
          const emptyBox = await opener.boundingBox();
          assert.ok(emptyBox && emptyBox.x >= 0 && emptyBox.x + emptyBox.width <= width, "icon stays within an empty workspace's bar");
          await page.goto(`http://127.0.0.1:${server.port}/?connecting=1`);
          await page.getByText("Connecting to herdr web ui…", { exact: true }).waitFor();
          await opener.click();
          await dialog.getByText("No browser is open on the server right now.", { exact: true }).waitFor();
          await dialog.getByRole("button", { name: "Close", exact: true }).click();
          assert.equal(await page.locator("vite-error-overlay").count(), 0);
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}px: persistent entry with/without panes and while connecting, empty state, 403/404/503 recovery, Retry and focus${width === 390 ? ", request timeout" : ""}`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
