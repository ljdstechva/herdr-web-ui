import { afterEach, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserStreamId, handleBrowserRequest, type BrowserViewService } from "./browser-view-api.ts";
import { BrowserViewError, BrowserViews, displayTitle, frontBrowser, parseXrandr, phoneSize } from "./browser-view.ts";
import { FakeX } from "./x11.fake.ts";

const linux = process.platform === "linux";
const open: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of open.splice(0).reverse()) await close(); });

const CHROME = "Chromium-browser";
const window = (id: number, width: number, height: number, className = CHROME, title = "") => ({ id, x: 0, y: 0, width, height, className, title });

it("takes the topmost browser window and passes over helpers and other programs", () => {
  expect(frontBrowser([window(1, 1280, 720), window(2, 900, 600, "XTerm"), window(3, 10, 10, "Chrome")])?.id).toBe(1);
  expect(frontBrowser([window(1, 1280, 720), window(2, 800, 600, "firefox")])?.id).toBe(2);
  expect(frontBrowser([window(2, 900, 600, "XTerm")])).toBeNull();
});

it("shows a page's title without the browser's name", () => {
  expect(displayTitle("Future Lawns - Google Chrome for Testing")).toBe("Future Lawns");
  expect(displayTitle("Inbox — Mozilla Firefox")).toBe("Inbox");
  expect(displayTitle("A - B")).toBe("A - B");
  expect(displayTitle(" - Chromium")).toBe("- Chromium");
});

it("reads the output, the mode in use and the limit from xrandr", () => {
  const text = "Screen 0: minimum 1 x 1, current 412 x 880, maximum 1280 x 900\nscreen connected 412x880+0+0 0mm x 0mm\n   1280x900       0.00  \n   herdr-412x880      0.00* \n";
  expect(parseXrandr(text)).toEqual({ output: "screen", mode: "herdr-412x880", modes: ["1280x900", "herdr-412x880"], max: { width: 1280, height: 900 } });
  expect(parseXrandr("Can't open display :9\n")).toBeNull();
  expect(parseXrandr("Screen 0: minimum 1 x 1, current 1 x 1, maximum 1280 x 900\nscreen disconnected\n")).toBeNull();
});

it("sizes a phone layout to what was asked, within what the display can be", () => {
  const max = { width: 1280, height: 900 };
  expect(phoneSize({ width: 411.6, height: 780.2 }, max)).toEqual({ width: 412, height: 780 });
  expect(phoneSize({ width: 820, height: 1180 }, max)).toEqual({ width: 820, height: 900 });
  expect(phoneSize({ width: 40, height: 100 }, max)).toEqual({ width: 280, height: 280 });
  expect(phoneSize({ width: 400, height: 400 }, { width: 200, height: 900 })).toEqual({ width: 200, height: 400 });
});

it("names the display of a stream path only", () => {
  expect(browserStreamId("/api/browsers/95/stream")).toBe("95");
  expect(browserStreamId("/api/browsers/95/layout")).toBeNull();
  expect(browserStreamId("/api/browsers/../stream")).toBeNull();
  expect(browserStreamId("/api/browsers/123456/stream")).toBeNull();
});

function service(overrides: Partial<BrowserViewService> = {}): BrowserViewService & { asked: unknown[] } {
  const asked: unknown[] = [];
  const info = { id: "95", title: "Inbox", layout: "desktop" as const, width: 1280, height: 900, phone_layout: true };
  return {
    asked,
    available: true,
    list: async () => [info],
    setLayout: async (id, request) => { asked.push([id, request]); return { ...info, layout: request.layout }; },
    open: async () => { throw new Error("not used"); },
    ...overrides,
  };
}

const post = (path: string, body: unknown, headers: Record<string, string> = { "x-herdr-browser": "1" }): Request =>
  new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

async function answer(response: Response): Promise<[number, unknown]> {
  return [response.status, await response.json()];
}

it("answers the list, and 404 where the view cannot be offered", async () => {
  expect(await answer(await handleBrowserRequest(new Request("http://localhost/api/browsers"), "/api/browsers", service(), false)))
    .toEqual([200, { browsers: [{ id: "95", title: "Inbox", layout: "desktop", width: 1280, height: 900, phone_layout: true }] }]);
  for (const views of [undefined, service({ available: false })]) {
    const [status, body] = await answer(await handleBrowserRequest(new Request("http://localhost/api/browsers"), "/api/browsers", views, false));
    expect(status).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe("not_available");
  }
});

it("refuses a watch device everything, the list included", async () => {
  const views = service();
  const [status, body] = await answer(await handleBrowserRequest(new Request("http://localhost/api/browsers"), "/api/browsers", views, true));
  expect(status).toBe(403);
  expect((body as { error: { code: string } }).error.code).toBe("read_only");
  expect((await handleBrowserRequest(post("/api/browsers/95/layout", { layout: "desktop" }), "/api/browsers/95/layout", views, true)).status).toBe(403);
  expect(views.asked).toEqual([]);
});

it("changes a layout only for a well-formed request from the app", async () => {
  const views = service();
  const path = "/api/browsers/95/layout";
  const code = async (request: Request): Promise<unknown> => ((await (await handleBrowserRequest(request, path, views, false)).json()) as { error?: { code: string } }).error?.code;
  expect(await code(post(path, { layout: "desktop" }, {}))).toBe("missing_header");
  expect(await code(post(path, "{"))).toBe("invalid_json");
  expect(await code(post(path, { layout: "tablet" }))).toBe("invalid_body");
  expect(await code(post(path, { layout: "phone", width: 412 }))).toBe("invalid_body");
  expect(await code(post(path, { layout: "phone", width: 412, height: -1 }))).toBe("invalid_body");
  expect(views.asked).toEqual([]);
  expect(await answer(await handleBrowserRequest(post(path, { layout: "phone", width: 412, height: 780, extra: 1 }), path, views, false)))
    .toEqual([200, { id: "95", title: "Inbox", layout: "phone", width: 1280, height: 900, phone_layout: true }]);
  expect(views.asked).toEqual([["95", { layout: "phone", width: 412, height: 780 }]]);
});

it("answers the service's own refusals and unknown routes in the error envelope", async () => {
  const views = service({ setLayout: async () => { throw new BrowserViewError(409, "layout_unavailable", "This display cannot be resized"); } });
  expect(await answer(await handleBrowserRequest(post("/api/browsers/95/layout", { layout: "desktop" }), "/api/browsers/95/layout", views, false)))
    .toEqual([409, { error: { code: "layout_unavailable", message: "This display cannot be resized" } }]);
  expect((await handleBrowserRequest(new Request("http://localhost/api/browsers/95"), "/api/browsers/95", views, false)).status).toBe(404);
  expect((await handleBrowserRequest(new Request("http://localhost/api/browsers/95/layout"), "/api/browsers/95/layout", views, false)).status).toBe(404);
});

/**
 * A display (the fake X server), an xrandr that keeps the mode in a file, and a state directory.
 * The fake display reads its size from that file, as a real one follows its mode.
 */
async function host(windows = [window(7, 1280, 720, CHROME, "Future Lawns - Google Chrome for Testing")]) {
  const root = mkdtempSync(join(tmpdir(), "herdr-browser-view-"));
  const sockets = join(root, "x11");
  const stateDir = join(root, "state");
  mkdirSync(sockets);
  const modeFile = join(root, "mode");
  const calls = join(root, "calls");
  writeFileSync(modeFile, "1280x900\n");
  writeFileSync(join(root, "modes"), "");
  writeFileSync(calls, "");
  const xrandr = join(root, "xrandr");
  writeFileSync(xrandr, `#!/bin/bash
cd ${JSON.stringify(root)}
echo "$*" >> calls
shift 2
case "$1" in
  --query)
    echo "Screen 0: minimum 1 x 1, current 1 x 1, maximum 1280 x 900"
    echo "screen connected 1x1+0+0 0mm x 0mm"
    for mode in 1280x900 $(cat modes); do
      if [ "$mode" = "$(cat mode)" ]; then echo "   $mode       0.00* "; else echo "   $mode       0.00  "; fi
    done ;;
  --newmode) echo "$2" >> modes ;;
  --output) echo "$4" > mode ;;
  --rmmode) grep -vx -- "$2" modes > modes.next; mv modes.next modes ;;
esac
`);
  chmodSync(xrandr, 0o755);
  const fake = new FakeX();
  fake.windows = windows;
  fake.size = () => {
    const [width, height] = readFileSync(modeFile, "utf8").trim().replace("herdr-", "").split("x").map(Number);
    return { width: width!, height: height! };
  };
  await fake.listen(join(sockets, "X5"));
  const made: BrowserViews[] = [];
  open.push(async () => { for (const views of made) await views.stop(); await fake.close(); rmSync(root, { recursive: true, force: true }); });
  const views = (restoreAfterMs = 60_000): BrowserViews => {
    const created = new BrowserViews({ stateDir, x11vnc: "/bin/true", xrandr, socketDirectory: sockets, restoreAfterMs });
    made.push(created);
    return created;
  };
  const stateFile = join(stateDir, "browser-view.json");
  return { fake, views, stateFile, mode: () => readFileSync(modeFile, "utf8").trim(), calls: () => readFileSync(calls, "utf8").trim().split("\n").map((line) => line.replace(/^--display :5 /, "")) };
}

async function until(what: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("the condition did not come true in time");
    await Bun.sleep(20);
  }
}

it.skipIf(!linux)("lists a display that shows a browser and leaves out one that does not", async () => {
  const { fake, views } = await host();
  const service = views();
  expect(await service.list()).toEqual([{ id: "5", title: "Future Lawns", layout: "desktop", width: 1280, height: 900, phone_layout: true }]);
  fake.windows = [window(9, 800, 600, "XTerm")];
  expect(await service.list()).toEqual([]);
});

it.skipIf(!linux)("is not offered without x11vnc", async () => {
  const { stateFile } = await host();
  const none = new BrowserViews({ stateDir: join(stateFile, ".."), x11vnc: null, xrandr: null });
  expect(none.available).toBe(false);
  await expect(none.open("5", { data: () => true, end: () => undefined })).rejects.toMatchObject({ code: "not_available" });
});

it.skipIf(!linux)("lays a browser out for a phone and puts back exactly what was there", async () => {
  const { fake, views, stateFile, mode, calls } = await host();
  fake.windows[0]!.x = 20;
  fake.windows[0]!.y = 30;
  const service = views();
  const phone = await service.setLayout("5", { layout: "phone", width: 412.3, height: 780 });
  expect(phone).toEqual({ id: "5", title: "Future Lawns", layout: "phone", width: 412, height: 780, phone_layout: true });
  expect(mode()).toBe("herdr-412x780");
  expect(fake.moved.at(-1)).toEqual({ id: 7, x: 0, y: 0, width: 412, height: 780 });
  // what to put back was on disk before anything moved
  expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({ displays: { "5": { mode: "1280x900", window: { id: 7, x: 20, y: 30, width: 1280, height: 720 } } } });

  // a keyboard opening on the phone: a new size, the same thing to put back, the old mode removed
  await service.setLayout("5", { layout: "phone", width: 412, height: 460 });
  expect(mode()).toBe("herdr-412x460");
  expect(calls()).toContain("--rmmode herdr-412x780");
  expect(JSON.parse(readFileSync(stateFile, "utf8")).displays["5"].window).toEqual({ id: 7, x: 20, y: 30, width: 1280, height: 720 });

  const desktop = await service.setLayout("5", { layout: "desktop" });
  expect(desktop).toEqual({ id: "5", title: "Future Lawns", layout: "desktop", width: 1280, height: 900, phone_layout: true });
  expect(mode()).toBe("1280x900");
  expect(fake.moved.at(-1)).toEqual({ id: 7, x: 20, y: 30, width: 1280, height: 720 });
  expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({ displays: {} });
  expect(calls()).toContain("--rmmode herdr-412x460");
});

it.skipIf(!linux)("never moves a window for a desktop request when no phone layout is on", async () => {
  const { fake, views, calls, stateFile } = await host();
  await views().setLayout("5", { layout: "desktop" });
  expect(fake.moved).toEqual([]);
  expect(calls()).toEqual([""]);
  expect(existsSync(stateFile)).toBe(false);
});

it.skipIf(!linux)("puts a phone layout back by itself once nobody watches", async () => {
  const { fake, views, mode } = await host();
  await views(30).setLayout("5", { layout: "phone", width: 400, height: 700 });
  expect(mode()).toBe("herdr-400x700");
  await until(() => mode() === "1280x900" && fake.windows[0]!.width === 1280);
  expect(fake.windows[0]).toMatchObject({ x: 0, y: 0, width: 1280, height: 720 });
});

it.skipIf(!linux)("puts back what a server that died left phone-sized", async () => {
  const { fake, views, mode, stateFile } = await host();
  // the first server is not stopped (stop() would put the display back): it simply is no more
  const dead = new BrowserViews({ stateDir: join(stateFile, ".."), x11vnc: "/bin/true", xrandr: join(stateFile, "..", "..", "xrandr"), socketDirectory: join(stateFile, "..", "..", "x11"), restoreAfterMs: 60_000 });
  await dead.setLayout("5", { layout: "phone", width: 400, height: 700 });
  expect(mode()).toBe("herdr-400x700");
  views(30);
  await until(() => mode() === "1280x900" && fake.windows[0]!.width === 1280);
  expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({ displays: {} });
  await dead.stop();
});

it.skipIf(!linux)("puts the display back when the server stops", async () => {
  const { fake, views, mode } = await host();
  const service = views();
  await service.setLayout("5", { layout: "phone", width: 400, height: 700 });
  await service.stop();
  expect(mode()).toBe("1280x900");
  expect(fake.windows[0]).toMatchObject({ width: 1280, height: 720 });
});

it.skipIf(!linux)("gives the window of a browser that restarted the place its predecessor had", async () => {
  const { fake, views, mode } = await host();
  const service = views();
  await service.setLayout("5", { layout: "phone", width: 400, height: 700 });
  // the browser closed and came back as another window, at its own size
  fake.windows = [window(8, 1280, 720, CHROME, "New Tab - Google Chrome for Testing")];
  expect(await service.list()).toEqual([{ id: "5", title: "New Tab", layout: "phone", width: 400, height: 700, phone_layout: true }]);
  expect(fake.windows[0]).toMatchObject({ id: 8, width: 400, height: 700 });
  await service.setLayout("5", { layout: "desktop" });
  expect(mode()).toBe("1280x900");
  expect(fake.windows[0]).toMatchObject({ id: 8, x: 0, y: 0, width: 1280, height: 720 });
});

it.skipIf(!linux)("refuses a layout where no browser is open, and a phone layout without xrandr", async () => {
  const { fake, views, stateFile } = await host();
  await expect(views().setLayout("6", { layout: "phone", width: 400, height: 700 })).rejects.toMatchObject({ status: 404, code: "browser_not_found" });
  const bare = new BrowserViews({ stateDir: join(stateFile, ".."), x11vnc: "/bin/true", xrandr: null, socketDirectory: join(stateFile, "..", "..", "x11") });
  expect((await bare.list())[0]?.phone_layout).toBe(false);
  await expect(bare.setLayout("5", { layout: "phone", width: 400, height: 700 })).rejects.toMatchObject({ status: 409, code: "layout_unavailable" });
  expect(fake.moved).toEqual([]);
  await bare.stop();
});
