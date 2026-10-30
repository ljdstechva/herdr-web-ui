/** Self-contained mobile/desktop file viewer layout matrix; no live herdr session. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright-core";

const level = (page: Page) => page.evaluate(() => Number.parseInt(document.querySelector(".zoom-controls-level")?.textContent ?? "0", 10));
/** The view's scroll, its room and the image's box in the view, in CSS px. */
const view = (page: Page) => page.evaluate(() => {
  const scroll = document.querySelector<HTMLElement>(".image-scroll")!;
  const image = document.querySelector<HTMLElement>(".image-view-img")!.getBoundingClientRect();
  const area = scroll.getBoundingClientRect();
  const bar = document.querySelector<HTMLElement>(".image-toolbar")!.getBoundingClientRect();
  return { left: scroll.scrollLeft, top: scroll.scrollTop, wide: scroll.scrollWidth > scroll.clientWidth + 1, tall: scroll.scrollHeight > scroll.clientHeight + 1,
    area: { x: area.x, y: area.y, width: area.width, height: area.height, right: area.right, bottom: area.bottom },
    image: { x: image.x, y: image.y, width: image.width, height: image.height, right: image.right, bottom: image.bottom }, barTop: bar.y };
});
/** The part of the image (0-1 across, 0-1 down) at a point of the screen. */
const partAt = async (page: Page, x: number, y: number) => { const { image } = await view(page); return { x: (x - image.x) / image.width, y: (y - image.y) / image.height }; };
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/** Pinch, a finger's drag, a double tap and the buttons on a phone; a mouse's drag, double click and Ctrl+wheel on a desktop. */
async function checkZoom(page: Page, cdp: CDPSession | null, label: string): Promise<void> {
  let at = await view(page);
  assert.equal(await level(page), 100, `${label}: the image opens fitted`);
  assert.ok(at.image.x >= at.area.x - 1 && at.image.right <= at.area.right + 1 && at.image.y >= at.area.y - 1, `${label}: the fitted image is whole in the view ${JSON.stringify(at)}`);
  assert.ok(at.image.bottom <= at.barTop + 1, `${label}: the fitted image is clear of the zoom buttons`);
  assert.equal(at.wide || at.tall, false, `${label}: nothing to scroll at fit`);
  const middle = { x: at.image.x + at.image.width / 2, y: at.image.y + at.image.height / 2 };
  if (cdp !== null) {
    // a long press on the image opens no image menu: the finger may be about to drag it
    const pressed = await page.locator(".image-scroll").evaluate((node, point) => {
      node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, pointerType: "touch", isPrimary: true }));
      return node.dispatchEvent(new PointerEvent("contextmenu", { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y, pointerType: "touch" }));
    }, middle);
    assert.equal(pressed, false, `${label}: a finger's long press on the image is no menu`);
    // two fingers spread around the middle of the image
    const before = await partAt(page, middle.x, middle.y);
    const fingers = (spread: number) => [{ x: middle.x - spread, y: middle.y, id: 1 }, { x: middle.x + spread, y: middle.y, id: 2 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(30) });
    for (let step = 1; step <= 6; step += 1) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(30 + step * 15) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(() => Number.parseInt(document.querySelector(".zoom-controls-level")?.textContent ?? "0", 10) > 200);
    await settle(page);
    at = await view(page);
    const after = await partAt(page, middle.x, middle.y);
    assert.ok(at.wide || at.tall, `${label}: a pinched image is bigger than the view`);
    if (at.wide) assert.ok(Math.abs(after.x - before.x) < 0.03, `${label}: what was between the fingers stays there (across) ${JSON.stringify({ before, after })}`);
    if (at.tall) assert.ok(Math.abs(after.y - before.y) < 0.03, `${label}: what was between the fingers stays there (down) ${JSON.stringify({ before, after })}`);
    // one finger drags it about, a slant stroke both ways at once (the browser's own scroll would keep to one axis)
    const start = { left: at.left, top: at.top, wide: at.wide, tall: at.tall };
    const from = { x: Math.round(at.area.x + at.area.width / 2), y: Math.round(at.area.y + at.area.height / 2) };
    for (let step = 0; step <= 6; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: step === 0 ? "touchStart" : "touchMove", touchPoints: [{ x: from.x - step * 15, y: from.y - step * 10, id: 1 }] });
      await page.waitForTimeout(16);
    }
    // the finger rests before it lifts: no glide, so the image is where the finger left it
    await page.waitForTimeout(150);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settle(page);
    at = await view(page);
    const moved = { left: at.left - start.left, top: at.top - start.top };
    if (start.wide) assert.ok(Math.abs(moved.left - 90) < 3, `${label}: a finger's drag moves the image across with it ${JSON.stringify({ start, moved })}`);
    if (start.tall) assert.ok(Math.abs(moved.top - 60) < 3, `${label}: a finger's drag moves the image down with it ${JSON.stringify({ start, moved })}`);
    // a flick glides on past where the finger lifted (the strokes carry a phone's 16 ms timing, whatever this host's load)
    const flickFrom = { left: at.left, top: at.top };
    const t0 = Date.now() / 1000;
    for (let step = 0; step <= 4; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: step === 0 ? "touchStart" : "touchMove", timestamp: t0 + step * 0.016, touchPoints: [{ x: from.x + step * 12, y: from.y + step * 8, id: 1 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", timestamp: t0 + 5 * 0.016, touchPoints: [] });
    await page.waitForTimeout(700);
    at = await view(page);
    const glided = start.wide ? flickFrom.left - at.left : flickFrom.top - at.top;
    assert.ok(glided > (start.wide ? 48 : 32) + 10, `${label}: a flick glides on ${JSON.stringify({ flickFrom, now: { left: at.left, top: at.top } })}`);
    // a double tap fits it again, and another zooms in around the tapped point
    const tap = async (x: number, y: number) => {
      for (let i = 0; i < 2; i += 1) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      }
    };
    await tap(Math.round(at.area.x + at.area.width / 2), Math.round(at.area.y + at.area.height / 2));
    await page.waitForFunction(() => document.querySelector(".zoom-controls-level")?.textContent === "100%");
    at = await view(page);
    const tapped = { x: Math.round(at.image.x + at.image.width * 0.3), y: Math.round(at.image.y + at.image.height * 0.7) };
    const part = await partAt(page, tapped.x, tapped.y);
    await tap(tapped.x, tapped.y);
    await page.waitForFunction(() => document.querySelector(".zoom-controls-level")?.textContent === "250%");
    await settle(page);
    const kept = await partAt(page, tapped.x, tapped.y);
    at = await view(page);
    // a side still narrower than the view stays in its middle; a side that outgrew it keeps the tapped point
    assert.ok(at.wide || at.tall, `${label}: a double tap zooms past the view`);
    if (at.wide) assert.ok(Math.abs(kept.x - part.x) < 0.03, `${label}: a double tap zooms in around the tapped point (across) ${JSON.stringify({ part, kept })}`);
    if (at.tall) assert.ok(Math.abs(kept.y - part.y) < 0.03, `${label}: a double tap zooms in around the tapped point (down) ${JSON.stringify({ part, kept })}`);
  } else {
    // a mouse: Ctrl+wheel zooms, a press drags, a double click fits again and zooms back in
    await page.mouse.move(middle.x, middle.y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -400);
    await page.keyboard.up("Control");
    await page.waitForFunction(() => Number.parseInt(document.querySelector(".zoom-controls-level")?.textContent ?? "0", 10) > 150);
    await settle(page);
    at = await view(page);
    assert.ok(at.wide || at.tall, `${label}: Ctrl+wheel zooms the image past the view`);
    const start = { left: at.left, top: at.top };
    await page.mouse.move(at.area.x + at.area.width / 2, at.area.y + at.area.height / 2);
    await page.mouse.down();
    await page.mouse.move(at.area.x + at.area.width / 2 - 90, at.area.y + at.area.height / 2 - 90, { steps: 5 });
    await page.mouse.up();
    at = await view(page);
    assert.ok(at.left > start.left + 20 || at.top > start.top + 20, `${label}: a mouse drags the zoomed image ${JSON.stringify({ start, now: { left: at.left, top: at.top } })}`);
    assert.equal(await page.locator(".image-scroll[data-dragging]").count(), 0, `${label}: the drag ends with the button`);
    await page.mouse.dblclick(at.area.x + at.area.width / 2, at.area.y + at.area.height / 2);
    await page.waitForFunction(() => document.querySelector(".zoom-controls-level")?.textContent === "100%");
    await page.mouse.dblclick(middle.x, middle.y);
    await page.waitForFunction(() => document.querySelector(".zoom-controls-level")?.textContent === "250%");
  }
  // the buttons: zoom in steps up from there, the level fits the screen again
  const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
  const fit = page.getByRole("button", { name: "Fit to screen", exact: true });
  if (cdp !== null) await zoomIn.tap(); else await zoomIn.click();
  await page.waitForFunction(() => Number.parseInt(document.querySelector(".zoom-controls-level")?.textContent ?? "0", 10) > 250);
  if (cdp !== null) await fit.tap(); else await fit.click();
  await page.waitForFunction(() => document.querySelector(".zoom-controls-level")?.textContent === "100%");
  at = await view(page);
  assert.equal(at.wide || at.tall, false, `${label}: fitted again, nothing to scroll`);
  assert.equal(await page.getByRole("button", { name: "Zoom out", exact: true }).isDisabled(), true, `${label}: no zooming out past fit`);
}

async function checkLayout(): Promise<void> {
  const fixture = mkdtempSync(join(tmpdir(), "herdr-web-ui-viewer-layout-"));
  const repo = join(import.meta.dir, "..");
  const sharedCss = readFileSync(join(repo, "src/styles.css"), "utf8");
  const viewerCss = readFileSync(process.env.FILE_VIEWER_CSS ?? join(repo, "src/components/FileViewer.css"), "utf8")
    + readFileSync(join(repo, "src/components/ImageView.css"), "utf8") + readFileSync(join(repo, "src/components/ZoomControls.css"), "utf8");
  const entry = join(fixture, "entry.ts");
  // Render the actual component, with only its HTTP file data supplied by the fixture.
  writeFileSync(entry, `
    import React from ${JSON.stringify(join(repo, "node_modules/react/index.js"))};
    import { createRoot } from ${JSON.stringify(join(repo, "node_modules/react-dom/client.js"))};
    import { FileViewer } from ${JSON.stringify(join(repo, "src/components/FileViewer.tsx"))};
    import { SettingsProvider } from ${JSON.stringify(join(repo, "src/lib/settings.ts"))};
    const query = new URLSearchParams(location.search);
    const name = "image-" + "very-long-unbroken-name-".repeat(30) + ".svg";
    const path = "/workspace/" + "long-directory/".repeat(40) + name;
    const height = query.get("height");
    if (height) document.documentElement.style.setProperty("--app-height", height + "px");
    function Demo() {
      const [open, setOpen] = React.useState(true);
      return React.createElement(SettingsProvider, null, open
        ? React.createElement(FileViewer, { path, paneId: null, onClose: () => setOpen(false) })
        : React.createElement("p", { id: "closed" }, "Viewer closed"));
    }
    createRoot(document.getElementById("root")).render(React.createElement(Demo));
  `);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const bundle = await Bun.build({
      entrypoints: [entry], target: "browser", define: { "process.env.NODE_ENV": JSON.stringify("development") },
      plugins: [{ name: "fixture-styles", setup(build) {
        // Serve the real stylesheets explicitly, including optional pre-fix CSS.
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "css" }));
      } }],
    });
    assert.ok(bundle.success, String(bundle.logs));
    const js = bundle.outputs.find((output) => output.path.endsWith(".js"));
    assert.ok(js, "fixture bundle contains JavaScript");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/entry.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/styles.css") {
        const insets = url.searchParams.get("safe") === "portrait"
          ? { top: 59, right: 0, bottom: 34, left: 0 }
          : url.searchParams.get("safe") === "landscape"
            ? { top: 0, right: 59, bottom: 21, left: 59 }
            : { top: 0, right: 0, bottom: 0, left: 0 };
        const css = `${sharedCss}\n${viewerCss}`.replace(/env\(safe-area-inset-(top|right|bottom|left),\s*0px\)/g,
          (_, side: keyof typeof insets) => `${insets[side]}px`);
        return new Response(css, { headers: { "content-type": "text/css" } });
      }
      if (url.pathname === "/api/fs/stat") {
        const path = url.searchParams.get("path")!;
        return Response.json({ path, name: path.split("/").pop(), kind: "image", mime: "image/svg+xml", size: 2048 });
      }
      if (url.pathname === "/api/fs/file") {
        const image = new URL(request.headers.get("referer")!).searchParams.get("image");
        // a photo outgrows the view both ways once zoomed
        const [width, height] = image === "wide" ? [6000, 400] : image === "photo" ? [1600, 1200] : [400, 6000];
        return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="teal"/></svg>`,
          { headers: { "content-type": "image/svg+xml" } });
      }
      return new Response(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/styles.css?safe=${url.searchParams.get("safe") ?? "none"}"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } });
    } });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    const cases = [
      { name: "portrait", width: 393, height: 852, touch: true, safe: "none", top: 0, side: 0, bottom: 0 },
      { name: "portrait-notch", width: 393, height: 852, touch: true, safe: "portrait", top: 59, side: 0, bottom: 34 },
      { name: "landscape", width: 852, height: 393, touch: true, safe: "none", top: 0, side: 0, bottom: 0 },
      { name: "landscape-notch", width: 852, height: 393, touch: true, safe: "landscape", top: 0, side: 59, bottom: 21 },
      { name: "portrait-keyboard", width: 393, height: 852, appHeight: 300, touch: true, safe: "portrait", top: 59, side: 0, bottom: 34 },
      { name: "landscape-keyboard", width: 852, height: 393, appHeight: 200, touch: true, safe: "landscape", top: 0, side: 59, bottom: 21 },
      { name: "desktop", width: 1440, height: 900, touch: false, safe: "none", top: 0, side: 0, bottom: 0 },
      { name: "desktop-short", width: 1024, height: 240, touch: false, safe: "none", top: 0, side: 0, bottom: 0 },
    ];
    for (const scenario of cases.filter((item) => !process.env.FILE_VIEWER_CASE || item.name === process.env.FILE_VIEWER_CASE)) {
      const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, isMobile: scenario.touch, hasTouch: scenario.touch, locale: "en-US" });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.setDefaultTimeout(10_000);
        const zooms = scenario.name === "portrait" || scenario.name === "desktop";
        for (const image of zooms ? ["tall", "wide", "photo"] : ["tall", "wide"]) {
          const label = `${scenario.name}/${image}`;
          const limit = "appHeight" in scenario ? scenario.appHeight! : scenario.height;
          await page.goto(`http://127.0.0.1:${server.port}/?safe=${scenario.safe}&image=${image}&height=${"appHeight" in scenario ? scenario.appHeight : ""}`);
          await page.waitForFunction(() => {
            const image = document.querySelector<HTMLImageElement>(".image-view-img");
            return image?.complete && image.naturalWidth > 0 && image.style.width !== "1px" && document.querySelector(".image-toolbar") !== null;
          });
          // a phone's sheet rises into place first (sheet-in): measure where it comes to rest
          await page.locator(".file-viewer").evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
          const geometry = await page.evaluate(() => {
            const rect = (element: Element) => {
              const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
              return { x, y, width, height, right, bottom };
            };
            const dialog = document.querySelector<HTMLElement>(".file-viewer")!;
            const header = document.querySelector<HTMLElement>(".file-viewer-header")!;
            const body = document.querySelector<HTMLElement>(".file-viewer-body")!;
            const title = document.querySelector<HTMLElement>(".file-viewer-title .modal-title")!;
            const controls = [...header.querySelectorAll<HTMLElement>(".icon-button")].map((element) => {
              const bounds = rect(element);
              // Rounded button corners do not belong to the hit target.
              const points = [[bounds.x + 8, bounds.y + 8], [bounds.right - 8, bounds.y + 8], [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], [bounds.x + 8, bounds.bottom - 8], [bounds.right - 8, bounds.bottom - 8]];
              const hits = points.map(([x, y]) => document.elementFromPoint(x!, y!));
              return { ...bounds, unobstructed: hits.every((hit) => element.contains(hit)) };
            });
            return { dialog: rect(dialog), header: rect(header), body: rect(body), controls,
              title: { ...rect(title), scrollWidth: title.scrollWidth, clientWidth: title.clientWidth, overflow: getComputedStyle(title).textOverflow },
              documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight };
          });
          assert.equal(geometry.controls.length, 3, label);
          assert.ok(geometry.dialog.x >= -1 && geometry.dialog.right <= scenario.width + 1, `${label}: dialog fits width`);
          assert.ok(geometry.dialog.y >= -1 && geometry.dialog.bottom <= limit + 1, `${label}: dialog fits usable height ${JSON.stringify(geometry.dialog)}`);
          for (const control of geometry.controls) {
            assert.ok(control.x >= scenario.side && control.right <= scenario.width - scenario.side, `${label}: full control inside safe width ${JSON.stringify(control)}`);
            assert.ok(control.y >= scenario.top && control.bottom <= limit - scenario.bottom, `${label}: full control inside safe height ${JSON.stringify(control)}`);
            assert.ok(control.unobstructed, `${label}: control hit-test inside rounded corners and center ${JSON.stringify(control)}`);
            if (scenario.touch) assert.ok(control.width >= 44 && control.height >= 44, `${label}: tappable target`);
            assert.ok(control.y >= geometry.header.y && control.bottom <= geometry.header.bottom + 1, `${label}: header cannot collapse around controls`);
          }
          assert.equal(geometry.title.overflow, "ellipsis", `${label}: title truncation`);
          assert.ok(geometry.title.scrollWidth > geometry.title.clientWidth, `${label}: long title is constrained`);
          assert.ok(geometry.documentWidth <= scenario.width && geometry.documentHeight <= scenario.height, `${label}: no document scrolling`);
          if (zooms) {
            await checkZoom(page, scenario.touch ? await context.newCDPSession(page) : null, label);
            console.log(`PASS ${label}: ${scenario.touch ? "pinch, a finger's drag, double tap" : "Ctrl+wheel, a mouse's drag, double click"} and the buttons zoom the image`);
          }
          // Stress overflowing content beyond the ordinary fitted preview: only the image's view scrolls.
          await page.locator(".image-view-img").evaluate((element) => {
            (element as HTMLElement).style.height = "4000px";
          });
          const scrolling = await page.locator(".image-scroll").evaluate((element) => {
            const header = document.querySelector(".file-viewer-header")!;
            const before = header.getBoundingClientRect().y;
            element.scrollTop = 2000;
            return { scrollTop: element.scrollTop, headerMoved: header.getBoundingClientRect().y !== before, documentTop: document.documentElement.scrollTop, pageHeight: document.documentElement.scrollHeight };
          });
          assert.ok(scrolling.scrollTop > 0, `${label}: tall content scrolls in the image's view`);
          assert.equal(scrolling.headerMoved, false, `${label}: header remains fixed`);
          assert.equal(scrolling.documentTop, 0, `${label}: page does not scroll`);
          assert.ok(scrolling.pageHeight <= scenario.height, `${label}: oversized content cannot grow page`);
          const close = page.getByRole("button", { name: "Close file", exact: true });
          if (scenario.touch) await close.tap(); else await close.click();
          await page.locator("#closed").waitFor();
          assert.equal(await page.getByRole("dialog").count(), 0, `${label}: actual close callback removes dialog`);
          assert.deepEqual(errors, [], label);
          console.log(`PASS ${label}: safe, tappable controls; body-only scroll; actual close`);
        }
      } finally { await context.close(); }
    }
  } finally {
    await browser?.close();
    server?.stop();
    rmSync(fixture, { recursive: true, force: true });
  }
}

await checkLayout();
