import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ArchiveCheck, FolderCreated, StorageUsage } from "../shared/protocol.ts";
import { forgetAuthAttempts } from "./auth.ts";
import { createServer } from "./index.ts";
import { MACHINE_PROXY_PATH } from "./machine-api.ts";

/** The Files browser's routes at the HTTP seam: sizes, a new folder, a folder as a .zip. None needs herdr. */
describe("storage routes", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-storage-api-"));
  const files = join(root, "files");
  let server: ReturnType<typeof createServer>;
  let base: string;
  beforeAll(() => {
    forgetAuthAttempts();
    mkdirSync(join(files, "work"), { recursive: true });
    writeFileSync(join(files, "work", "a.bin"), Buffer.alloc(4096));
    writeFileSync(join(files, "note.txt"), "hello");
    server = createServer({ port: 0, stateDir: join(root, "state") });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => { server.stop(); rmSync(root, { recursive: true, force: true }); });
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/fs/folder`, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body) });

  it("GET /api/fs/usage measures a folder and a file, and answers 404 for neither", async () => {
    const folder = await fetch(`${base}/api/fs/usage?path=${encodeURIComponent(files)}`);
    expect(folder.status).toBe(200);
    expect(await folder.json() as StorageUsage).toMatchObject({ kind: "folder", size: 4101, files: 2, folders: 1, partial: false, children: { work: { size: 4096, files: 1 } } });
    const file = await (await fetch(`${base}/api/fs/usage?path=${encodeURIComponent(join(files, "note.txt"))}`)).json() as StorageUsage;
    expect(file).toMatchObject({ kind: "file", size: 5, files: 1 });
    const missing = await fetch(`${base}/api/fs/usage?path=${encodeURIComponent(join(files, "nope"))}`);
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe("not_found");
    expect((await fetch(`${base}/api/fs/usage?path=${encodeURIComponent(files)}`, { method: "POST", headers: { origin: base } })).status).toBe(400);
  });

  it("POST /api/fs/folder makes the folder, and says why when it does not", async () => {
    const made = await post({ path: files, name: "Week A" });
    expect(made.status).toBe(201);
    expect(await made.json() as FolderCreated).toEqual({ path: join(files, "Week A"), name: "Week A" });
    expect(statSync(join(files, "Week A")).isDirectory()).toBe(true);
    const codes = async (body: unknown): Promise<[number, string]> => { const answer = await post(body); return [answer.status, (await answer.json() as { error: { code: string } }).error.code]; };
    expect(await codes({ path: files, name: "week a" })).toEqual([409, "exists"]);
    expect(await codes({ path: files, name: "a/b" })).toEqual([400, "invalid_name"]);
    expect(await codes({ path: join(files, "nope"), name: "x" })).toEqual([404, "not_found"]);
    expect(await codes({ name: "x" })).toEqual([400, "invalid_body"]);
    expect(await codes([])).toEqual([400, "invalid_body"]);
  });

  it("refuses a folder, a walk and an archive asked from another site", async () => {
    const elsewhere = { "sec-fetch-site": "cross-site" };
    expect((await post({ path: files, name: "from-elsewhere" }, { origin: "https://example.com" })).status).toBe(403);
    expect((await fetch(`${base}/api/fs/usage?path=${encodeURIComponent(files)}`, { headers: elsewhere })).status).toBe(403);
    expect((await fetch(`${base}/api/fs/archive?path=${encodeURIComponent(files)}`, { headers: elsewhere })).status).toBe(403);
  });

  it("GET /api/fs/archive sends the folder as a .zip to save", async () => {
    const answer = await fetch(`${base}/api/fs/archive?path=${encodeURIComponent(files)}`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/zip");
    expect(answer.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''files.zip");
    expect(answer.headers.get("content-encoding")).toBeNull();
    const zip = new Uint8Array(await answer.arrayBuffer());
    // a local header first, the end record last
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect([...zip.subarray(zip.length - 22, zip.length - 18)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    expect(Buffer.from(zip).includes("files/work/a.bin")).toBe(true);
    // asked first, it says what the archive will be instead of sending it
    const check = await fetch(`${base}/api/fs/archive?check=1&path=${encodeURIComponent(files)}`);
    expect(check.headers.get("content-type")).toContain("application/json");
    expect(await check.json() as ArchiveCheck).toMatchObject({ name: "files.zip", size: 4101 });
    const file = await fetch(`${base}/api/fs/archive?path=${encodeURIComponent(join(files, "note.txt"))}`);
    expect(file.status).toBe(404);
  });

  it("reaches another PC through the proxy, like the routes beside them", () => {
    for (const path of ["fs/usage", "fs/folder", "fs/archive"]) expect(MACHINE_PROXY_PATH.test(path)).toBe(true);
    expect(MACHINE_PROXY_PATH.test("fs/remove")).toBe(false);
  });
});
