import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

import { ARCHIVE_MAX_ACTIVE, archiveBytes, archiveResponse, archiveSlotFree, planArchive, type ArchivePlan } from "./archive.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = (): string => { const root = mkdtempSync(join(tmpdir(), "herdr-archive-")); roots.push(root); return root; };

async function bytesOf(plan: ArchivePlan): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of archiveBytes(plan)) parts.push(part);
  return Buffer.concat(parts);
}

/** The archive as a reader finds it: from the end record, through the central directory, to each entry's bytes. */
function read(zip: Uint8Array): Map<string, { body: Uint8Array; crc: number; mode: number }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  let count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff) {
    expect(view.getUint32(end - 20, true)).toBe(0x07064b50);
    const record = Number(view.getBigUint64(end - 12, true));
    expect(view.getUint32(record, true)).toBe(0x06064b50);
    count = Number(view.getBigUint64(record + 32, true));
    at = Number(view.getBigUint64(record + 48, true));
  }
  const entries = new Map<string, { body: Uint8Array; crc: number; mode: number }>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const mode = view.getUint32(at + 38, true) >>> 16;
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    entries.set(name, { body: zip.subarray(start, start + size), crc, mode });
    at += 46 + nameLength + extraLength;
  }
  return entries;
}

describe("a folder as a .zip", () => {
  it("holds every folder and file under the folder's own name, each with its checksum", async () => {
    const root = temp();
    const folder = join(root, "Client ñ 2026");
    mkdirSync(join(folder, "work", "drafts"), { recursive: true });
    mkdirSync(join(folder, "empty"));
    writeFileSync(join(folder, "brief.md"), "# brief\n");
    writeFileSync(join(folder, "work", "big.bin"), Buffer.alloc(700_000, 3));
    writeFileSync(join(folder, "work", "drafts", "한글.txt"), "초안");
    writeFileSync(join(folder, ".hidden"), "");
    symlinkSync(join(folder, "brief.md"), join(folder, "link.md"));
    symlinkSync(folder, join(folder, "work", "loop"));
    const plan = (await planArchive(folder)) as ArchivePlan;
    expect(plan.name).toBe("Client ñ 2026.zip");
    expect(plan.unread).toEqual([]);
    const zip = await bytesOf(plan);
    const entries = read(zip);
    // links are left out; a folder's own entries come before what its folders hold
    expect([...entries.keys()]).toEqual([
      "Client ñ 2026/", "Client ñ 2026/.hidden", "Client ñ 2026/brief.md", "Client ñ 2026/empty/", "Client ñ 2026/work/",
      "Client ñ 2026/work/big.bin", "Client ñ 2026/work/drafts/", "Client ñ 2026/work/drafts/한글.txt",
    ]);
    expect(new TextDecoder().decode(entries.get("Client ñ 2026/brief.md")!.body)).toBe("# brief\n");
    expect(new TextDecoder().decode(entries.get("Client ñ 2026/work/drafts/한글.txt")!.body)).toBe("초안");
    const big = entries.get("Client ñ 2026/work/big.bin")!;
    expect(big.body.length).toBe(700_000);
    expect(big.crc).toBe(crc32(big.body));
    expect(entries.get("Client ñ 2026/.hidden")!.body.length).toBe(0);
    // a folder unpacks as a folder, a file as a file
    expect(entries.get("Client ñ 2026/work/")!.mode & 0o170000).toBe(0o040000);
    expect(big.mode & 0o170000).toBe(0o100000);
  });

  it.skipIf(Bun.which("python3") === null)("opens in another program's reader", async () => {
    const root = temp();
    mkdirSync(join(root, "docs", "sub"), { recursive: true });
    writeFileSync(join(root, "docs", "a.txt"), "alpha");
    writeFileSync(join(root, "docs", "sub", "b.bin"), Buffer.alloc(300_000, 9));
    const zip = join(root, "out.zip");
    await Bun.write(zip, await bytesOf((await planArchive(join(root, "docs"))) as ArchivePlan));
    const check = Bun.spawnSync(["python3", "-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(sorted(z.namelist()));print(z.read('docs/a.txt').decode(), z.getinfo('docs/sub/b.bin').file_size)", zip]);
    expect(check.stderr.toString()).toBe("");
    expect(check.stdout.toString()).toBe("['docs/', 'docs/a.txt', 'docs/sub/', 'docs/sub/b.bin']\nalpha 300000\n");
  });

  it("names what it could not read in a note, instead of leaving it out unsaid", async () => {
    if (process.getuid?.() === 0) return;
    const root = temp();
    const folder = join(root, "mixed");
    mkdirSync(join(folder, "locked"), { recursive: true });
    writeFileSync(join(folder, "ok.txt"), "fine");
    writeFileSync(join(folder, "secret.txt"), "no");
    chmodSync(join(folder, "secret.txt"), 0);
    chmodSync(join(folder, "locked"), 0);
    try {
      const plan = (await planArchive(folder)) as ArchivePlan;
      expect(plan.unread).toEqual(["mixed/locked/"]);
      const entries = read(await bytesOf(plan));
      expect(entries.has("mixed/secret.txt")).toBe(false);
      expect(new TextDecoder().decode(entries.get("mixed/ok.txt")!.body)).toBe("fine");
      const note = new TextDecoder().decode(entries.get("mixed/_NOT IN THIS ZIP.txt")!.body);
      expect(note).toContain("mixed/locked/\nsecret.txt\n");
    } finally {
      chmodSync(join(folder, "locked"), 0o755);
    }
  });

  it("is ZIP64 past the old entry count, and still found from its end", async () => {
    const stamp = new Date(2026, 10, 11, 9, 30, 0);
    const plan: ArchivePlan = { name: "many.zip", unread: [], entries: Array.from({ length: 70_000 }, (_, n) => ({ name: `many/d${n}/`, path: null, size: 0, modified: stamp, mode: 0o040755, folder: true })) };
    const entries = read(await bytesOf(plan));
    expect(entries.size).toBe(70_000);
    expect(entries.has("many/d69999/")).toBe(true);
  });

  it("answers null for a file or nothing, and refuses more entries than it will pack", async () => {
    const root = temp();
    writeFileSync(join(root, "file"), "");
    expect(await planArchive(join(root, "file"))).toBeNull();
    expect(await planArchive(join(root, "nope"))).toBeNull();
    for (let n = 0; n < 6; n++) writeFileSync(join(root, `f${n}`), "");
    expect(await planArchive(root, 5)).toBe("too_many_files");
    expect(await planArchive(root, 8)).not.toBe("too_many_files");
  });

  it("streams as a download, and gives its slot back when it ends or is cancelled", async () => {
    const root = temp();
    mkdirSync(join(root, "send"));
    writeFileSync(join(root, "send", "a.txt"), "alpha");
    const plan = (await planArchive(join(root, "send"))) as ArchivePlan;
    const held = Array.from({ length: ARCHIVE_MAX_ACTIVE }, () => archiveResponse(plan));
    expect(archiveSlotFree()).toBe(false);
    expect(held[0]!.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''send.zip");
    expect(held[0]!.headers.get("content-type")).toBe("application/zip");
    expect(read(new Uint8Array(await held[0]!.arrayBuffer())).has("send/a.txt")).toBe(true);
    expect(archiveSlotFree()).toBe(true);
    for (const response of held.slice(1)) await response.body!.cancel();
    const more = Array.from({ length: ARCHIVE_MAX_ACTIVE }, () => archiveResponse(plan));
    expect(archiveSlotFree()).toBe(false);
    for (const response of more) await response.body!.cancel();
    expect(archiveSlotFree()).toBe(true);
  });
});
