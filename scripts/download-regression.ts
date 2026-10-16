/** Real FileViewer + download UI against owned streaming HTTP files; no live panes or data. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { fileResponse } from "../server/file-view.ts";

declare global { interface Window { downloadTypes: string[]; blockBlobDownloads: boolean; blockedBlobDownloads: number } }

const root = mkdtempSync(join(tmpdir(), "herdr-download-browser-"));
const repo = join(import.meta.dir, "..");
const entry = join(root, "fixture.tsx");
writeFileSync(entry, `
import React from ${JSON.stringify(join(repo, "node_modules/react/index.js"))};
import { createRoot } from ${JSON.stringify(join(repo, "node_modules/react-dom/client.js"))};
import ${JSON.stringify(join(repo, "src/styles.css"))};
import { FileViewer } from ${JSON.stringify(join(repo, "src/components/FileViewer.tsx"))};
import { DownloadCenter } from ${JSON.stringify(join(repo, "src/components/DownloadCenter.tsx"))};
import { SettingsProvider } from ${JSON.stringify(join(repo, "src/lib/settings.ts"))};
import { MachineContext } from ${JSON.stringify(join(repo, "src/lib/machineContext.tsx"))};
function Fixture() {
 const [file, setFile] = React.useState(null);
 const [machine, setMachine] = React.useState('local');
 return <SettingsProvider><div className="app">
   <header className="app-header">Download test</header>
   <div className="app-body"><main><textarea aria-label="Chat draft" defaultValue="Keep this draft" />
   <button onClick={() => setMachine(machine === 'local' ? 'remote-one' : 'local')}>Switch PC</button>
   {['slow.bin','unknown.bin','retry.bin','archive.zip'].map(name => <button key={name} onClick={() => setFile(name)}>Open {name}</button>)}
   </main></div>
   {file && <MachineContext.Provider value={machine}><FileViewer path={'/test/'+file} paneId="owned-test-pane" onClose={() => setFile(null)} /></MachineContext.Provider>}
   <DownloadCenter />
 </div></SettingsProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`);
const bytes = Buffer.alloc(128 * 1024, 65);
// A valid ZIP containing README.txt, served with the production download headers.
const zipBytes = Buffer.from("UEsDBBQAAAAIAK9gTl1dIOe/HwAAAB0AAAAKAAAAUkVBRE1FLnR4dAvIyM9LVUjJL8/LyU9MUShLLcpMy0xOLMnMz9PjAgBQSwECFAMUAAAACACvYE5dXSDnvx8AAAAdAAAACgAAAAAAAAAAAAAAgAEAAAAAUkVBRE1FLnR4dFBLBQYAAAAAAQABADgAAABHAAAAAAA=", "base64");
const zipPath = join(root, "archive.zip");
writeFileSync(zipPath, zipBytes);
const gates = new Map<string, { release: () => void; closed: boolean }>();
const requests: string[] = [];
let failRetry = true;
let server: Server | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const build = await Bun.build({ entrypoints: [entry], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "fixture-jsx", setup(build) { build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () => ({ path: join(repo, "node_modules/react/jsx-dev-runtime.js") })); } }] });
  assert.ok(build.success, String(build.logs));
  const respond = (request: Request): Response => {
    const url = new URL(request.url);
    const name = (url.searchParams.get("path") ?? "").split("/").pop()!;
    if (url.pathname.endsWith("/fs/stat")) return Response.json({ path: `/test/${name}`, name, kind: "binary", mime: name === "archive.zip" ? "application/zip" : "application/octet-stream", size: name === "archive.zip" ? zipBytes.length : bytes.length });
    if (url.pathname.endsWith("/fs/file")) {
      requests.push(url.pathname + url.search);
      if (name === "archive.zip") return fileResponse({ path: zipPath, name, kind: "binary", mime: "application/zip", size: zipBytes.length, modified: "2026-10-14T00:00:00.000Z" }, true);
      if (name === "retry.bin" && failRetry) return Response.json({ error: { code: "not_found", message: "test missing file" } }, { status: 404 });
      if (name === "retry.bin") return new Response(bytes, { headers: { "content-type": "image/svg+xml" } });
      const gate = Promise.withResolvers<void>();
      const record = { release: () => gate.resolve(), closed: false };
      gates.set(name, record);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 65536));
          void gate.promise.then(() => { if (!record.closed) { controller.enqueue(bytes.subarray(65536)); controller.close(); record.closed = true; } });
        },
        cancel() { record.closed = true; gate.resolve(); },
      });
      return new Response(stream, { headers: { "content-type": "application/octet-stream", ...(name === "unknown.bin" ? {} : { "content-length": String(bytes.length) }) } });
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (url.pathname === "/") return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Download test · herdr</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(root, url.pathname.slice(1))));
  };
  // Node preserves the declared length of this deliberately held stream; Bun's streaming
  // response path removes it. Production file responses use Bun.file with a known length.
  server = createServer((request, reply) => {
    const response = respond(new Request(`http://127.0.0.1${request.url}`));
    reply.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) { reply.end(); return; }
    const stream = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream);
    stream.on("error", error => reply.destroy(error));
    reply.on("close", () => stream.destroy());
    stream.pipe(reply);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: "en-US", isMobile: width < 500, hasTouch: width < 500, acceptDownloads: true });
    const page = await context.newPage();
    await page.addInitScript(() => {
      const observed = window;
      observed.downloadTypes = [];
      observed.blockBlobDownloads = false;
      observed.blockedBlobDownloads = 0;
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = value => { if (value instanceof Blob) observed.downloadTypes.push(value.type); return create(value); };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (observed.blockBlobDownloads && this.href.startsWith("blob:")) { observed.blockedBlobDownloads++; return; }
        click.call(this);
      };
    });
    const errors: string[] = [];
    const savedUrls: string[] = [];
    page.on("download", download => savedUrls.push(download.url()));
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(10_000);
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.getByRole("button", { name: "Open slow.bin", exact: true }).click();
    const viewer = page.getByRole("dialog", { name: "slow.bin", exact: true });
    await viewer.getByRole("button", { name: "Download", exact: true }).click();
    const center = page.getByRole("dialog", { name: "Downloads", exact: true });
    await center.waitFor();
    const progress = center.getByRole("progressbar");
    try { await page.waitForFunction(() => document.querySelector('.download-row progress')?.getAttribute('value') === '50'); }
    catch (error) { console.error('Download state:', await center.innerText(), 'Requests:', requests); throw error; }
    assert.equal(await progress.getAttribute("value"), "50");
    await page.keyboard.press("Escape");
    await center.waitFor({ state: "hidden" });
    assert.equal(await viewer.isVisible(), true, "minimize does not close the preview beneath");
    if (width < 500) assert.equal(await page.evaluate(() => {
      const notice = document.querySelector('.download-notification')!.getBoundingClientRect();
      const header = document.querySelector('.file-viewer-header')!.getBoundingClientRect();
      return notice.top >= header.bottom || notice.bottom <= header.top;
    }), true, "minimized notification does not cover the phone preview controls");
    assert.equal(await viewer.getByRole("button", { name: "Download", exact: true }).evaluate(node => node === document.activeElement), true, "focus returns to Download");
    // Re-clicking the preview's Download is the keyboard path back while the preview traps Tab.
    const count = requests.length;
    await viewer.getByRole("button", { name: "Download", exact: true }).click();
    await center.waitFor();
    assert.equal(requests.length, count, "reopen does not start a duplicate transfer");
    await center.getByRole("button", { name: "Minimize downloads" }).click();
    await viewer.getByRole("button", { name: "Close file" }).click();
    await page.getByRole("button", { name: "Switch PC" }).click();
    await page.getByRole("textbox", { name: "Chat draft" }).fill("Still usable during download");
    await page.getByRole("button", { name: "Open downloads", exact: true }).waitFor();
    await page.getByRole("button", { name: "Open downloads", exact: true }).click();
    await center.waitFor();
    await page.keyboard.press("Escape");
    await center.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "Open downloads", exact: true }).evaluate(node => node === document.activeElement), true, "minimizing returns focus to the notification after the preview closed");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env["UI_EVIDENCE_DIR"]) {
      mkdirSync(process.env["UI_EVIDENCE_DIR"], { recursive: true });
      await page.screenshot({ path: join(process.env["UI_EVIDENCE_DIR"], `download-minimized-${width}.png`) });
    }
    const saved = page.waitForEvent("download");
    gates.get("slow.bin")!.release();
    const download = await saved;
    assert.equal(download.suggestedFilename(), "slow.bin");
    assert.deepEqual(readFileSync((await download.path())!), bytes, "the saved browser file is byte-for-byte intact");
    assert.equal(await page.getByRole("button", { name: "Open downloads", exact: true }).isVisible(), true, "finished status stays minimized");
    await page.getByRole("button", { name: "Open downloads", exact: true }).click();
    await center.getByText("Sent to browser", { exact: true }).waitFor();
    await center.getByRole("button", { name: "Dismiss download: slow.bin" }).click();
    await center.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("textbox", { name: "Chat draft" }).inputValue(), "Still usable during download");

    await page.getByRole("button", { name: "Open unknown.bin" }).click();
    await page.getByRole("dialog", { name: "unknown.bin", exact: true }).getByRole("button", { name: "Download", exact: true }).click();
    await center.getByText("64 KB", { exact: true }).waitFor();
    assert.equal(await center.getByRole("progressbar").getAttribute("value"), null, "unknown total remains indeterminate");
    assert.ok(requests.at(-1)!.startsWith("/api/machines/remote-one/fs/file?"), "the new request uses the selected PC");
    await center.getByRole("button", { name: "Cancel download: unknown.bin" }).click();
    await center.getByText("Download cancelled", { exact: true }).waitFor();
    gates.get("unknown.bin")!.release();
    await center.getByRole("button", { name: "Dismiss download: unknown.bin" }).click();
    await page.getByRole("button", { name: "Close file" }).click();

    failRetry = true;
    await page.getByRole("button", { name: "Open retry.bin" }).click();
    await page.getByRole("dialog", { name: "retry.bin", exact: true }).getByRole("button", { name: "Download", exact: true }).click();
    await center.getByRole("alert").getByText("Download failed", { exact: true }).waitFor();
    failRetry = false;
    const retried = page.waitForEvent("download");
    await center.getByRole("button", { name: "Retry", exact: true }).click();
    assert.deepEqual(readFileSync((await (await retried).path())!), bytes);
    assert.equal(await page.evaluate(() => window.downloadTypes.at(-1)), "application/octet-stream", "download blobs cannot turn active file types into executable blob pages");
    await center.getByText("Sent to browser", { exact: true }).waitFor();
    if (process.env["UI_EVIDENCE_DIR"]) await page.screenshot({ path: join(process.env["UI_EVIDENCE_DIR"], `download-complete-${width}.png`) });

    await center.getByRole("button", { name: "Dismiss download: retry.bin" }).click();
    await page.getByRole("button", { name: "Close file" }).click();
    await page.evaluate(() => { window.blockBlobDownloads = true; });
    const beforeZip = savedUrls.length;
    await page.getByRole("button", { name: "Open archive.zip", exact: true }).click();
    await page.getByRole("dialog", { name: "archive.zip", exact: true }).getByRole("button", { name: "Download", exact: true }).click();
    await center.getByText("Sent to browser", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.blockedBlobDownloads), 1);
    assert.equal(savedUrls.length, beforeZip, "a silently ignored blob handoff saved no file");
    assert.equal(await center.getByRole("link", { name: "Save file", exact: true }).count(), 1, "a real HTTP save link recovers from a phone ignoring the blob handoff");
    await center.getByRole("button", { name: "Minimize downloads" }).click();
    await page.getByRole("button", { name: "Close file" }).click();
    await page.getByRole("button", { name: "Switch PC" }).click();
    await page.getByRole("button", { name: "Open downloads", exact: true }).click();
    const saveZip = center.getByRole("link", { name: "Save file", exact: true });
    assert.ok((await saveZip.getAttribute("href"))!.startsWith("/api/machines/remote-one/fs/file?"), "saving keeps the PC the ZIP came from");
    assert.equal(await saveZip.getAttribute("download"), "archive.zip");
    const zipSaving = page.waitForEvent("download");
    await saveZip.click();
    const savedZip = await zipSaving;
    assert.equal(savedZip.suggestedFilename(), "archive.zip");
    assert.ok(savedZip.url().includes("/api/machines/remote-one/fs/file?"));
    assert.deepEqual(readFileSync((await savedZip.path())!), zipBytes, "direct save preserves the complete ZIP archive");
    if (process.env["UI_EVIDENCE_DIR"]) await page.screenshot({ path: join(process.env["UI_EVIDENCE_DIR"], `download-zip-recovery-${width}.png`) });
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: progress, minimize/Escape/focus, duplicate prevention, preview close, PC switch, actual saved bytes, unknown length, cancel, failure/retry and persistent status`);
    console.log(`PASS ${width}px: a real ZIP saves from its original PC after a blocked automatic blob handoff`);
    await context.close();
  }
} finally {
  for (const gate of gates.values()) gate.release();
  await browser?.close(); server?.closeAllConnections(); server?.close(); rmSync(root, { recursive: true, force: true });
}
