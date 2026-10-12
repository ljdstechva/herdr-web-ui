import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeX } from "./x11.fake.ts";
import { classOf, configureWindowRequest, displaySocketPath, encodeRequest, parseSetup, setupRequest, withDisplay, X11Error } from "./x11.ts";

const open: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of open.splice(0)) await close(); });

async function display(): Promise<{ fake: FakeX; path: string }> {
  const directory = mkdtempSync(join(tmpdir(), "herdr-x11-"));
  const fake = new FakeX();
  const path = displaySocketPath("7", directory);
  await fake.listen(path);
  open.push(async () => { await fake.close(); rmSync(directory, { recursive: true, force: true }); });
  return { fake, path };
}

it("names a display's socket", () => {
  expect(displaySocketPath("95")).toBe("/tmp/.X11-unix/X95");
});

it("greets as a little-endian X11 client without authorization", () => {
  expect([...setupRequest()]).toEqual([0x6c, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

it("pads a request to four bytes and counts its length in them", () => {
  const request = encodeRequest(16, 1, Buffer.from("abcde"));
  expect(request.length).toBe(12);
  expect([...request.subarray(0, 4)]).toEqual([16, 1, 3, 0]);
  expect([...request.subarray(9)]).toEqual([0, 0, 0]);
});

it("asks for a window's position and size together", () => {
  const request = configureWindowRequest(0x200003, { x: 0, y: 0, width: 412, height: 862 });
  expect(request.readUInt8(0)).toBe(12);
  expect(request.readUInt16LE(2)).toBe(7);
  expect(request.readUInt32LE(4)).toBe(0x200003);
  expect(request.readUInt16LE(8)).toBe(0x0f);
  expect([request.readInt32LE(12), request.readInt32LE(16), request.readUInt32LE(20), request.readUInt32LE(24)]).toEqual([0, 0, 412, 862]);
});

it("reads the class of a window, not the instance that may carry a profile path", () => {
  expect(classOf(Buffer.from("chromium-browser (/home/u/.profile)\0Chromium-browser\0", "latin1"))).toBe("Chromium-browser");
  expect(classOf(Buffer.alloc(0))).toBe("");
});

it("refuses a setup that names no screen", () => {
  expect(() => parseSetup(Buffer.alloc(40))).toThrow(X11Error);
});

it("lists the mapped windows of a display, lowest first, with class and title", async () => {
  const { fake, path } = await display();
  fake.size = () => ({ width: 800, height: 600 });
  fake.windows = [
    { id: 11, x: 0, y: 0, width: 800, height: 500, className: "Chromium-browser", title: "Inbox – Mail" },
    { id: 12, x: 10, y: 10, width: 10, height: 10, className: "Chrome", mapped: false },
    { id: 13, x: 40, y: 60, width: 200, height: 300, className: "Chromium-browser", overrideRedirect: true },
    { id: 14, x: -5, y: 7, width: 300, height: 200 },
  ];
  const seen = await withDisplay(path, async (connection) => ({ width: connection.width, height: connection.height, windows: await connection.topLevelWindows() }));
  expect(seen.width).toBe(800);
  expect(seen.height).toBe(600);
  expect(seen.windows).toEqual([
    { id: 11, x: 0, y: 0, width: 800, height: 500, className: "Chromium-browser", title: "Inbox – Mail" },
    { id: 14, x: -5, y: 7, width: 300, height: 200, className: "", title: "" },
  ]);
});

it("reads answers that arrive a few bytes at a time", async () => {
  const { fake, path } = await display();
  fake.chunk = 5;
  fake.windows = [{ id: 21, x: 1, y: 2, width: 640, height: 480, className: "firefox", title: "A long enough title to span several pieces" }];
  const windows = await withDisplay(path, (connection) => connection.topLevelWindows());
  expect(windows).toEqual([{ id: 21, x: 1, y: 2, width: 640, height: 480, className: "firefox", title: "A long enough title to span several pieces" }]);
});

it("leaves out a window that closed while it was being asked about", async () => {
  const { fake, path } = await display();
  fake.windows = [{ id: 31, x: 0, y: 0, width: 500, height: 500, className: "Chromium-browser" }, { id: 32, x: 0, y: 0, width: 600, height: 600, className: "Chromium-browser" }];
  fake.vanishing = 31;
  const windows = await withDisplay(path, (connection) => connection.topLevelWindows());
  expect(windows.map((window) => window.id)).toEqual([32]);
});

it("moves a window and reports a window that is not there", async () => {
  const { fake, path } = await display();
  fake.windows = [{ id: 41, x: 0, y: 0, width: 1280, height: 720, className: "Chromium-browser" }];
  await withDisplay(path, (connection) => connection.moveResize(41, { x: 0, y: 0, width: 412, height: 862 }));
  expect(fake.moved).toEqual([{ id: 41, x: 0, y: 0, width: 412, height: 862 }]);
  await expect(withDisplay(path, (connection) => connection.moveResize(99, { x: 0, y: 0, width: 1, height: 1 }))).rejects.toBeInstanceOf(X11Error);
});

it("fails instead of waiting on a display that is not there", async () => {
  await expect(withDisplay(join(tmpdir(), "herdr-x11-none", "X1"), (connection) => connection.topLevelWindows(), 500)).rejects.toThrow();
});
