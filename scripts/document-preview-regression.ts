/**
 * Document previews on a phone, end to end: the built client and a real server open a PDF with
 * pdf.js, a Word file through GET /api/fs/preview (a stand-in soffice prints a real PDF), a
 * spreadsheet as its cells and as its pages, and say so when the PC has no LibreOffice.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { utils, write } from "xlsx";
import { createServer } from "../server/index.ts";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

/** A PDF of one line of Helvetica per page (a standard font, so pdf.js reads its shipped font data). */
function tinyPdf(pages: { width: number; height: number; text: string }[]): string {
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((page, index) => {
    const stream = `BT /F1 18 Tf 24 ${page.height - 48} Td (${page.text}) Tj ET`;
    objects[4 + index * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`;
    objects[5 + index * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  return `${pdf}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-doc-preview-"));
writeFileSync(join(root, "mixed.pdf"), tinyPdf([{ width: 300, height: 420, text: "Effluent BOD 32 mg/L" }, { width: 420, height: 300, text: "A landscape page" }]));
const printed = join(root, "printed.pdf");
writeFileSync(printed, tinyPdf([{ width: 300, height: 420, text: "Printed by the stand-in" }]));
// a docx is a zip: the server checks the signature, the stand-in reads nothing
writeFileSync(join(root, "report.docx"), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("the stand-in soffice does not read this")]));
const book = utils.book_new();
const sheet = utils.aoa_to_sheet([["Self-monitoring (fictional)", null, null], ["Parameter", "Result", "Limit"], ["BOD", 32, 50], ["TSS", 48, 100]]);
sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
utils.book_append_sheet(book, sheet, "Summary");
utils.book_append_sheet(book, utils.aoa_to_sheet([["Notes"], ["Composite sample taken on the fifth"]]), "Notes");
writeFileSync(join(root, "results.xlsx"), write(book, { type: "buffer", bookType: "xlsx" }));
// prints source.<ext> in --outdir to source.pdf, as soffice does
const standIn = join(root, "soffice");
writeFileSync(standIn, `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "--outdir" ]; then out="$2"; shift; fi; shift; done\ncp "${printed}" "$out/source.pdf"\n`);
chmodSync(standIn, 0o755);

let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let bare: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

/** The viewer's first page drawn, or its cells laid out. */
const shown = (page: Page) => page.waitForFunction(() => {
  const canvas = document.querySelector<HTMLCanvasElement>(".pdf-page canvas");
  return (canvas !== null && canvas.width > 0) || document.querySelector(".sheet-grid td") !== null;
}, undefined, { timeout: 30_000 });

try {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-doc-preview" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), soffice: standIn });
  bare = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state-bare"), soffice: null });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async (origin: string, name: string) => {
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}&file=${encodeURIComponent(join(root, name))}`);
    await page.locator(".modal.file-viewer").waitFor();
  };
  const origin = `http://127.0.0.1:${server.port}`;

  // a PDF: pdf.js draws it in the page, a page counter, a text layer, zoom by button and by pinch
  await open(origin, "mixed.pdf");
  await shown(page);
  assert.equal(await page.locator(".pdf-page").count(), 2, "both pages are laid out");
  assert.equal(await page.locator(".pdf-page-count").textContent(), "1 of 2");
  await page.locator(".pdf-page[data-page='1'] .pdf-text", { hasText: "Effluent BOD 32 mg/L" }).waitFor();
  const sizes = await page.locator(".pdf-page").evaluateAll((pages) => pages.map((element) => element.getBoundingClientRect()).map(({ width, height }) => ({ width, height })));
  assert.ok(sizes[0]!.height > sizes[0]!.width && sizes[1]!.width > sizes[1]!.height, `a portrait and a landscape page keep their shapes: ${JSON.stringify(sizes)}`);
  assert.ok(sizes.every(({ width }) => Math.abs(width - sizes[0]!.width) < 2), "each page is fitted to the width");
  await page.getByRole("button", { name: "Zoom in" }).tap();
  await page.getByRole("button", { name: "Fit to width" }).filter({ hasText: "125%" }).waitFor();
  await page.getByRole("button", { name: "Fit to width" }).tap();
  await page.getByRole("button", { name: "Fit to width" }).filter({ hasText: "100%" }).waitFor();
  const cdp = await context.newCDPSession(page);
  const touch = (spread: number) => [{ x: 195 - spread / 2, y: 400, id: 1 }, { x: 195 + spread / 2, y: 400, id: 2 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(80) });
  for (let step = 1; step <= 6; step += 1) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(80 + step * 30) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(() => Number.parseInt(document.querySelector(".zoom-controls-level")?.textContent ?? "100", 10) > 150);
  const scrolled = await page.locator(".pdf-scroll").evaluate((element) => ({ wide: element.scrollWidth > element.clientWidth, page: document.documentElement.scrollWidth }));
  assert.ok(scrolled.wide, "a pinched page is wider than the view, which scrolls sideways");
  assert.ok(scrolled.page <= 390, "the app itself never scrolls sideways");
  // a double tap zooms in around the tapped point, and a second one fits the width again
  await page.getByRole("button", { name: "Fit to width" }).tap();
  const doubleTap = async () => {
    for (let tap = 0; tap < 2; tap += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 300, id: 1 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  };
  await doubleTap();
  await page.getByRole("button", { name: "Fit to width" }).filter({ hasText: "250%" }).waitFor();
  await doubleTap();
  await page.getByRole("button", { name: "Fit to width" }).filter({ hasText: "100%" }).waitFor();
  console.log("PASS a PDF is drawn in the page, fitted, selectable, and zooms by button, pinch and double tap");

  // a Word file: converted on the server, drawn the same way; the new tab opens the PDF
  await open(origin, "report.docx");
  await shown(page);
  await page.locator(".pdf-text", { hasText: "Printed by the stand-in" }).waitFor();
  const newTab = await page.getByRole("link", { name: "Open in a new tab" }).getAttribute("href");
  assert.match(newTab ?? "", /\/api\/fs\/preview\/pdf\?id=[0-9a-f]{64}&name=report\.docx$/);
  console.log("PASS a Word file shows the pages LibreOffice prints");

  // a spreadsheet: cells with the merge and the tabs, a tapped cell's text, and its printed pages
  await open(origin, "results.xlsx");
  await shown(page);
  assert.equal(await page.locator(".sheet-grid td[colspan='3']").textContent(), "Self-monitoring (fictional)");
  assert.equal(await page.locator(".sheet-grid td.is-number").first().textContent(), "32");
  await page.getByRole("tab", { name: "Notes" }).tap();
  await page.locator(".sheet-grid td", { hasText: "Composite sample" }).tap();
  assert.equal(await page.locator(".sheet-cell").textContent(), "A2Composite sample taken on the fifth");
  await page.getByRole("button", { name: "Show as pages" }).tap();
  await page.locator(".pdf-text", { hasText: "Printed by the stand-in" }).waitFor();
  await page.getByRole("button", { name: "Show as cells" }).tap();
  await page.locator(".sheet-grid td").first().waitFor();
  console.log("PASS a spreadsheet shows its cells, its sheets and its printed pages");

  // a PC without LibreOffice says what is missing, and the download stays
  await open(`http://127.0.0.1:${bare.port}`, "report.docx");
  await page.getByRole("alert").filter({ hasText: "needs LibreOffice" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Download" }).isEnabled(), true);
  console.log("PASS without LibreOffice the viewer says so and offers the download");

  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop();
  bare?.stop();
  if (workspace) await workspaceClose(workspace).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
