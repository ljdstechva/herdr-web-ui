/**
 * The Files browser in a real browser, against the real server modules and a folder of its own:
 * sizes beside every row, a new folder, and the row menu (right click, a held finger, the ⋯)
 * that downloads a file as itself and a folder as a .zip. No herdr, no live panes.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";

import { archiveResponse, archiveSlotFree, planArchive } from "../server/archive.ts";
import { listDirectories } from "../server/directories.ts";
import { fileInfo, fileResponse } from "../server/file-view.ts";
import { createFolder, storageUsage } from "../server/storage.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-file-browser-"));
const repo = join(import.meta.dir, "..");
const files = join(root, "files");
mkdirSync(join(files, "Client A", "work"), { recursive: true });
mkdirSync(join(files, "photos"));
mkdirSync(join(files, "empty"));
writeFileSync(join(files, "photos", "one.jpg"), Buffer.alloc(3_000_000, 1));
writeFileSync(join(files, "photos", "two.jpg"), Buffer.alloc(1_500_000, 2));
writeFileSync(join(files, "Client A", "work", "reel.mp4"), Buffer.alloc(800_000, 3));
writeFileSync(join(files, "notes.txt"), "hello from the PC\n");
writeFileSync(join(files, "report.pdf"), Buffer.alloc(250_000, 4));

const entry = join(root, "fixture.tsx");
writeFileSync(entry, `
import React from ${JSON.stringify(join(repo, "node_modules/react/index.js"))};
import { createRoot } from ${JSON.stringify(join(repo, "node_modules/react-dom/client.js"))};
import ${JSON.stringify(join(repo, "src/styles.css"))};
import { FilesDialog } from ${JSON.stringify(join(repo, "src/components/FilesDialog.tsx"))};
import { DownloadCenter } from ${JSON.stringify(join(repo, "src/components/DownloadCenter.tsx"))};
import { SettingsProvider } from ${JSON.stringify(join(repo, "src/lib/settings.ts"))};
function Fixture() {
 const [open, setOpen] = React.useState(false);
 const [opened, setOpened] = React.useState("");
 return <SettingsProvider><div className="app">
   <header className="app-header">Files test</header>
   <div className="app-body"><main><button onClick={() => setOpen(true)}>Browse files</button><output id="opened">{opened}</output></main></div>
   {open && <FilesDialog start=${JSON.stringify(files)} viewing={false} onOpenFile={setOpened} onClose={() => setOpen(false)} />}
   <DownloadCenter />
 </div></SettingsProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`);

const refuse = (code: string, message: string, status: number): Response => Response.json({ error: { code, message } }, { status });
const writes: string[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const build = await Bun.build({ entrypoints: [entry], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{ name: "fixture-jsx", setup(build) { build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () => ({ path: join(repo, "node_modules/react/jsx-dev-runtime.js") })); } }] });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.searchParams.get("path") ?? "";
      if (url.pathname === "/api/workspace/directories") {
        const listing = listDirectories(path, url.searchParams.get("hidden") === "1", url.searchParams.get("files") === "1");
        return listing === null ? refuse("invalid_cwd", "not a folder", 400) : Response.json(listing);
      }
      if (url.pathname === "/api/fs/usage") {
        const usage = await storageUsage(path, request.signal);
        return usage === null ? refuse("not_found", "nothing there", 404) : Response.json(usage);
      }
      if (url.pathname === "/api/fs/folder") {
        const body = await request.json() as { path: string; name: unknown };
        writes.push(`${body.path}/${String(body.name)}`);
        const made = createFolder(body.path, body.name);
        return "created" in made ? Response.json(made.created, { status: 201 }) : refuse(made.refused, made.refused, made.refused === "exists" ? 409 : 400);
      }
      if (url.pathname === "/api/fs/archive") {
        if (!archiveSlotFree()) return refuse("busy", "busy", 429);
        const plan = await planArchive(path);
        if (plan === null) return refuse("not_found", "not a folder", 404);
        if (plan === "too_many_files") return refuse("too_many_files", "too many", 413);
        if (url.searchParams.get("check") === "1") return Response.json({ name: plan.name, entries: plan.entries.length, size: plan.entries.reduce((sum, item) => sum + item.size, 0) });
        return archiveResponse(plan);
      }
      if (url.pathname === "/api/fs/file") {
        const info = fileInfo(path);
        return info === null ? refuse("not_found", "no file", 404) : fileResponse(info, url.searchParams.get("download") === "1");
      }
      if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
      if (url.pathname === "/") return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Files test · herdr</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
      return new Response(Bun.file(join(root, url.pathname.slice(1))));
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });

  /** The names in a stored .zip, read from its central directory. */
  const zipNames = (zip: Buffer): string[] => {
    const names: string[] = [];
    for (let at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); at >= 0 && zip.readUInt32LE(at) === 0x02014b50; at += 46 + zip.readUInt16LE(at + 28) + zip.readUInt16LE(at + 30)) {
      names.push(zip.subarray(at + 46, at + 46 + zip.readUInt16LE(at + 28)).toString("utf8"));
    }
    return names;
  };
  const row = (page: Page, name: string): Locator => page.locator(".files-dialog .file-row").filter({ has: page.locator(".file-row-name", { hasText: new RegExp(`^${name}$`) }) });
  const sizeOf = async (page: Page, name: string): Promise<string> => ((await row(page, name).locator(".dir-browser-size").textContent()) ?? "").trim();
  const names = (page: Page): Promise<string[]> => page.locator(".files-dialog .file-row-name").allTextContents();
  const openFiles = async (page: Page): Promise<void> => {
    await page.goto(`${origin}/`);
    await page.getByRole("button", { name: "Browse files", exact: true }).click();
    await page.locator(".file-summary-count").waitFor();
  };
  const minimize = (page: Page): Promise<void> => page.getByRole("dialog", { name: "Downloads", exact: true }).getByRole("button", { name: "Minimize downloads" }).click();

  // ---- a desktop: sizes, the right-click menu, downloads, a new folder ----
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 844 }, locale: "en-US", acceptDownloads: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(10_000);
    await openFiles(page);
    assert.deepEqual(await names(page), ["Client A", "empty", "photos", "notes.txt", "report.pdf"]);
    assert.deepEqual([await sizeOf(page, "photos"), await sizeOf(page, "Client A"), await sizeOf(page, "empty"), await sizeOf(page, "report.pdf"), await sizeOf(page, "notes.txt")], ["4.3 MB", "781 KB", "0 B", "244 KB", "18 B"]);
    assert.match((await page.locator(".file-summary").innerText()).replace(/\s+/g, " "), /^5\.3 MB 5 files · 4 folders .+ free of .+ on this disk$/);
    assert.equal(await row(page, "photos").locator(".file-row-share").evaluate((node) => getComputedStyle(node).getPropertyValue("--share")), "100%", "the largest row's bar is full");
    console.log("PASS 1280px: every folder and file shows what it takes, and the folder its total");

    await row(page, "photos").click({ button: "right", position: { x: 120, y: 12 } });
    const menu = page.locator(".row-menu");
    await menu.waitFor();
    assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Open", "Download as .zip", "Storage details", "Copy path"]);
    assert.equal(await menu.evaluate((node) => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.left + 20, box.top + 20)); }), true, "the menu is over the dialog it opened from");
    let saving = page.waitForEvent("download");
    await menu.getByRole("menuitem", { name: "Download as .zip" }).click();
    let saved = await saving;
    assert.equal(saved.suggestedFilename(), "photos.zip");
    assert.deepEqual(zipNames(readFileSync((await saved.path())!)), ["photos/", "photos/one.jpg", "photos/two.jpg"]);
    await minimize(page);
    console.log("PASS 1280px: a right click opens the row's menu; a folder downloads as a .zip of what is in it");

    await row(page, "notes.txt").click({ button: "right" });
    saving = page.waitForEvent("download");
    await page.locator(".row-menu").getByRole("menuitem", { name: "Download", exact: true }).click();
    saved = await saving;
    assert.equal(saved.suggestedFilename(), "notes.txt");
    assert.equal(readFileSync((await saved.path())!, "utf8"), "hello from the PC\n");
    await minimize(page);
    console.log("PASS 1280px: a file downloads as itself");

    await row(page, "Client A").getByRole("button", { name: "Actions for Client A" }).click();
    await page.locator(".row-menu").getByRole("menuitem", { name: "Storage details" }).click();
    const details = page.getByRole("dialog", { name: "Client A", exact: true });
    await details.locator(".file-details-list").waitFor();
    assert.match((await details.innerText()).replace(/\s+/g, " "), /781 KB \(800,000 bytes\) On disk .+ Contains 1 file · 1 folder Changed .+ Location .+files\/Client A/);
    await page.keyboard.press("Escape");
    await details.waitFor({ state: "hidden" });
    assert.equal(await page.locator(".files-dialog").isVisible(), true, "Escape closed the details only");
    console.log("PASS 1280px: Storage details says size, disk, contents and place, and Escape closes only it");

    await page.getByRole("button", { name: "Sorted by name. Sort by size" }).click();
    assert.deepEqual(await names(page), ["photos", "Client A", "report.pdf", "notes.txt", "empty"]);
    await page.getByRole("button", { name: "Sorted by size. Sort by name" }).click();
    console.log("PASS 1280px: sorted by size, the largest comes first whatever it is");

    await page.getByRole("button", { name: "New folder", exact: true }).click();
    const field = page.getByRole("textbox", { name: "New folder name" });
    await field.fill("what?");
    await page.locator(".file-new-error", { hasText: "character a folder cannot have" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Create", exact: true }).isDisabled(), true);
    await field.fill("PHOTOS");
    await field.press("Enter");
    await page.locator(".file-new-error", { hasText: "already has that name" }).waitFor();
    await field.fill("Week A");
    await field.press("Enter");
    await row(page, "Week A").waitFor();
    assert.equal(statSync(join(files, "Week A")).isDirectory(), true);
    assert.equal(await row(page, "Week A").getAttribute("data-fresh"), "", "the new folder's row is marked");
    assert.equal(existsSync(join(files, "what?")), false);
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    await page.getByRole("textbox", { name: "New folder name" }).press("Escape");
    assert.equal(await page.locator(".files-dialog").isVisible(), true, "Escape closed the field only");
    assert.equal(await page.locator(".file-new").count(), 0);
    console.log("PASS 1280px: New folder refuses a bad or taken name in words, makes a good one and shows it");

    await row(page, "Client A").locator(".dir-browser-item").click();
    await row(page, "work").waitFor();
    await page.locator(".file-summary-count", { hasText: "1 file" }).waitFor();
    assert.equal(await sizeOf(page, "work"), "781 KB");
    await row(page, "work").locator(".dir-browser-item").click();
    await row(page, "reel.mp4").locator(".dir-browser-item").click();
    assert.equal(await page.locator("#opened").textContent(), join(files, "Client A", "work", "reel.mp4"));
    assert.deepEqual(errors, []);
    console.log("PASS 1280px: a click opens a folder and measures it, and a file is handed to the viewer");
    await context.close();
  }

  // ---- a phone: a held finger asks for the menu, and its lift chooses nothing ----
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US", isMobile: true, hasTouch: true, acceptDownloads: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(10_000);
    await openFiles(page);
    // the sheet's entrance moves the rows until it ends
    await page.locator(".files-dialog").evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
    const box = (await row(page, "photos").boundingBox())!;
    const more = (await row(page, "photos").getByRole("button", { name: "Actions for photos" }).boundingBox())!;
    assert.ok(box.height >= 40 && more.width >= 40 && more.height >= 40, "rows and their ⋯ are finger sized");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "nothing is wider than the phone");
    const cdp = await context.newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number): Promise<unknown> => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const sheet = page.locator(".row-sheet");
    await touch("touchStart", box.x + 90, box.y + box.height / 2);
    await sheet.waitFor();
    await touch("touchEnd", box.x + 90, box.y + box.height / 2);
    // the lift lands on the sheet now under the finger: nothing ran, nothing opened
    await page.waitForFunction(() => document.querySelectorAll(".row-sheet .row-sheet-item").length === 4);
    assert.deepEqual(await sheet.locator(".row-sheet-item").allTextContents(), ["Open", "Download as .zip", "Storage details", "Copy path"]);
    assert.match(await sheet.locator(".row-sheet-head").innerText(), /photos\s+Folder · 4\.3 MB/);
    assert.equal(await row(page, "photos").count(), 1, "the held folder was not opened");
    let saving = page.waitForEvent("download");
    await sheet.locator(".row-sheet-item", { hasText: "Download as .zip" }).tap();
    let saved = await saving;
    assert.equal(saved.suggestedFilename(), "photos.zip");
    assert.equal(zipNames(readFileSync((await saved.path())!)).length, 3);
    await minimize(page);
    console.log("PASS 390px: holding a folder opens its menu as a sheet, the lift chooses nothing, and it downloads as a .zip");

    const fileBox = (await row(page, "report.pdf").boundingBox())!;
    await touch("touchStart", fileBox.x + 90, fileBox.y + fileBox.height / 2);
    await sheet.waitFor();
    await touch("touchEnd", fileBox.x + 90, fileBox.y + fileBox.height / 2);
    assert.equal(await page.locator("#opened").textContent(), "", "the held file was not opened");
    saving = page.waitForEvent("download");
    await sheet.locator(".row-sheet-item", { hasText: /^Download$/ }).tap();
    saved = await saving;
    assert.equal(saved.suggestedFilename(), "report.pdf");
    assert.equal(statSync((await saved.path())!).size, 250_000);
    await minimize(page);
    console.log("PASS 390px: holding a file downloads it whole, without opening it");

    const from = (await row(page, "Client A").boundingBox())!;
    await touch("touchStart", from.x + 90, from.y + 20);
    for (let step = 1; step <= 5; step++) await touch("touchMove", from.x + 90, from.y + 20 - step * 12);
    await page.waitForTimeout(700);
    await touch("touchEnd", from.x + 90, from.y - 40);
    assert.equal(await sheet.count(), 0, "a finger that moved is scrolling");
    await row(page, "Client A").locator(".dir-browser-item").tap();
    await row(page, "work").waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS 390px: a moving finger asks for no menu, and a tap still opens the folder");
    await context.close();
  }
  assert.deepEqual(writes, [`${files}/PHOTOS`, `${files}/Week A`], "only the names sent on purpose reached the server");
} finally {
  await browser?.close();
  await server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
