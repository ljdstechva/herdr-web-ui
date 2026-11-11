import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { folderNameProblem } from "../shared/storage.ts";
import { createFolder, forgetStorageUsage, storageUsage } from "./storage.ts";

const roots: string[] = [];
afterEach(() => { forgetStorageUsage(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), "herdr-storage-")); roots.push(root); return root; };

describe("storageUsage", () => {
  it("adds up a folder at every depth, and says what each of its own folders holds", async () => {
    const root = temp();
    mkdirSync(join(root, "work", "deep", "deeper"), { recursive: true });
    mkdirSync(join(root, "empty"));
    writeFileSync(join(root, "top.txt"), "x".repeat(10));
    writeFileSync(join(root, "work", "a.bin"), Buffer.alloc(5000));
    writeFileSync(join(root, "work", "deep", "deeper", "b.bin"), Buffer.alloc(300));
    writeFileSync(join(root, ".hidden"), "yz");
    const usage = (await storageUsage(root))!;
    expect(usage.kind).toBe("folder");
    expect(usage.size).toBe(5312);
    expect(usage.files).toBe(4);
    expect(usage.folders).toBe(4);
    expect(usage.partial).toBe(false);
    expect(usage.children).toEqual({ work: { size: 5300, files: 2 }, empty: { size: 0, files: 0 } });
    // whole blocks: never less than the bytes written, on a file system that counts them
    expect(usage.disk).toBeGreaterThanOrEqual(usage.size);
    expect(usage.volume!.total).toBeGreaterThan(usage.volume!.free);
    expect(new Date(usage.modified).getTime()).toBe(statSync(root).mtime.getTime());
  });

  it("measures a file as itself", async () => {
    const root = temp();
    writeFileSync(join(root, "report.pdf"), Buffer.alloc(1234));
    const usage = (await storageUsage(join(root, "report.pdf")))!;
    expect(usage).toMatchObject({ kind: "file", name: "report.pdf", size: 1234, files: 1, folders: 0, partial: false });
    expect(usage.children).toBeUndefined();
  });

  it("does not follow a link, and counts a file with two names once on disk", async () => {
    const root = temp();
    const outside = temp();
    writeFileSync(join(outside, "big.bin"), Buffer.alloc(64 * 1024));
    mkdirSync(join(root, "data"));
    writeFileSync(join(root, "data", "one.bin"), Buffer.alloc(8192));
    linkSync(join(root, "data", "one.bin"), join(root, "data", "same.bin"));
    symlinkSync(outside, join(root, "elsewhere"));
    symlinkSync(root, join(root, "data", "loop"));
    const usage = (await storageUsage(root))!;
    // both names are files a download would carry; the link's target is not inside
    expect(usage.size).toBe(16384);
    expect(usage.files).toBe(2);
    expect(usage.children).toEqual({ data: { size: 16384, files: 2 } });
    expect(usage.disk).toBeLessThan(usage.size + 8192);
  });

  it("answers null for nothing there, and a lower bound when it stops early", async () => {
    const root = temp();
    expect(await storageUsage(join(root, "nope"))).toBeNull();
    expect(await storageUsage("")).toBeNull();
    for (let n = 0; n < 40; n++) writeFileSync(join(root, `f${n}`), "abc");
    const cut = (await storageUsage(root, undefined, { deadlineMs: 60_000, maxEntries: 10 }))!;
    expect(cut.partial).toBe(true);
    expect(cut.files).toBe(10);
  });

  it("stops a walk nobody waits for, and gives one walk to everyone who asks", async () => {
    const root = temp();
    writeFileSync(join(root, "a"), "1");
    const gone = new AbortController();
    gone.abort();
    expect(await storageUsage(root, gone.signal)).toBeNull();
    const [first, second] = await Promise.all([storageUsage(root), storageUsage(root)]);
    expect(first).toBe(second!);
    // kept for a moment: the folder is not walked again on the way back to it
    writeFileSync(join(root, "b"), "22");
    expect((await storageUsage(root))!.files).toBe(1);
    forgetStorageUsage();
    expect((await storageUsage(root))!.files).toBe(2);
  });
});

describe("createFolder", () => {
  it("makes one folder in the folder named, and the sizes kept are forgotten", async () => {
    const root = temp();
    expect((await storageUsage(root))!.folders).toBe(0);
    expect(createFolder(root, "  Week A  ")).toEqual({ created: { path: join(root, "Week A"), name: "Week A" } });
    expect(statSync(join(root, "Week A")).isDirectory()).toBe(true);
    expect((await storageUsage(root))!.folders).toBe(1);
  });

  it("refuses a taken name whatever its case, a path, and a missing parent", () => {
    const root = temp();
    mkdirSync(join(root, "Reports"));
    writeFileSync(join(root, "notes"), "");
    expect(createFolder(root, "reports")).toEqual({ refused: "exists" });
    expect(createFolder(root, "Notes")).toEqual({ refused: "exists" });
    expect(createFolder(root, "a/b")).toEqual({ refused: "invalid_name" });
    expect(createFolder(root, "..")).toEqual({ refused: "invalid_name" });
    expect(createFolder(root, 7)).toEqual({ refused: "invalid_name" });
    expect(createFolder(join(root, "nope"), "x")).toEqual({ refused: "not_found" });
    expect(createFolder(join(root, "notes"), "x")).toEqual({ refused: "not_found" });
    expect(createFolder("", "x")).toEqual({ refused: "not_found" });
    expect(existsSync(join(root, "a"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("says so where this user cannot write", () => {
    const root = temp();
    mkdirSync(join(root, "locked"), { mode: 0o555 });
    expect(createFolder(join(root, "locked"), "x")).toEqual({ refused: "not_allowed" });
  });
});

describe("folderNameProblem", () => {
  it("takes ordinary names, spaces and other scripts included", () => {
    for (const name of ["work", "Week A", "2026-11 reports", ".tmp", "한글 폴더", "a.b", "console"]) expect(folderNameProblem(name)).toBeNull();
  });
  it("refuses what no folder, or no Windows mirror of it, can be named", () => {
    expect(folderNameProblem("   ")).toBe("empty");
    for (const name of [".", "..", "a/b", "a\\b", "what?", "a:b", "tab\there", "<x>", "ends."]) expect(folderNameProblem(name)).toBe("characters");
    for (const name of ["CON", "nul", "com1", "LPT9.txt"]) expect(folderNameProblem(name)).toBe("reserved");
    expect(folderNameProblem("x".repeat(256))).toBe("long");
    expect(folderNameProblem("가".repeat(86))).toBe("long");
    expect(folderNameProblem("x".repeat(255))).toBeNull();
  });
});
