import { lstatSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { crc32 } from "node:zlib";

import { resolveFilePath } from "./file-view.ts";

/**
 * A folder as a .zip the browser saves: what "Download" means for a folder, on a phone that has
 * no other way to take a folder off the PC.
 *
 * Written here, with no archiver beside it: the format is small when nothing is compressed, and
 * a PC is not asked to have `zip` installed. Stored, not deflated: what an agent's folder holds
 * (images, video, PDFs, office files) is compressed already, and the server's CPU is the
 * terminals'. Each file is read once and sent as it is read, its checksum and length following
 * it (a data descriptor), so nothing is held but the list of names; the archive is ZIP64 where a
 * file, the archive or the entry count passes what the old fields hold.
 *
 * Links are left out, as the usage walk leaves them out, and so is a volume mounted inside. A
 * file that could not be read is named in a note at the end of the archive rather than left out
 * unsaid.
 */

/** More entries than this is not a download: the answer says so before any byte is sent. */
export const ARCHIVE_MAX_ENTRIES = 100_000;
/** Archives streaming at once; each one reads the disk for as long as its download takes. */
export const ARCHIVE_MAX_ACTIVE = 2;
const READ_BYTES = 256 * 1024;
const TURN_MS = 8;
/** The old 32-bit fields end here; a value at or past it goes in a ZIP64 field. */
const FOUR_GB = 0xffff_ffff;
const NOTE_NAME = "_NOT IN THIS ZIP.txt";

export interface ArchiveEntry {
  /** the name inside the archive: the folder's own name first, `/` between parts, a folder ending in `/` */
  name: string;
  /** where it is read from; null for a folder */
  path: string | null;
  size: number;
  modified: Date;
  mode: number;
  folder: boolean;
}

export interface ArchivePlan {
  /** the file name the browser saves it under */
  name: string;
  entries: ArchiveEntry[];
  /** what the walk could not read, relative to the folder */
  unread: string[];
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * What goes into the archive of the folder `input` (absolute or `~/…`): every folder and regular
 * file under it, in the order the folders list them. Null when it is not a readable folder;
 * `too_many_files` past `maxEntries`.
 */
export async function planArchive(input: string, maxEntries = ARCHIVE_MAX_ENTRIES): Promise<ArchivePlan | "too_many_files" | null> {
  const asked = resolveFilePath(input, null);
  if (asked === null) return null;
  let root: string;
  let rootStat: Stats;
  try {
    root = realpathSync(asked);
    rootStat = statSync(root);
  } catch {
    return null;
  }
  if (!rootStat.isDirectory()) return null;
  // a folder at the top of the archive, so unpacking makes one folder and not its contents loose
  const top = basename(root) || "files";
  const entries: ArchiveEntry[] = [{ name: `${top}/`, path: null, size: 0, modified: rootStat.mtime, mode: rootStat.mode, folder: true }];
  const unread: string[] = [];
  const stack: { dir: string; name: string }[] = [{ dir: root, name: `${top}/` }];
  let turnStarted = performance.now();
  while (stack.length > 0) {
    const { dir, name: prefix } = stack.pop()!;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      unread.push(prefix);
      continue;
    }
    const folders: { dir: string; name: string }[] = [];
    for (const name of names) {
      const path = join(dir, name);
      let stat: Stats;
      try { stat = lstatSync(path); } catch { continue; }
      if (stat.isDirectory()) {
        if (stat.dev !== rootStat.dev) continue;
        entries.push({ name: `${prefix}${name}/`, path: null, size: 0, modified: stat.mtime, mode: stat.mode, folder: true });
        folders.push({ dir: path, name: `${prefix}${name}/` });
      } else if (stat.isFile()) {
        entries.push({ name: `${prefix}${name}`, path, size: stat.size, modified: stat.mtime, mode: stat.mode, folder: false });
      }
      if (entries.length > maxEntries) return "too_many_files";
    }
    // the stack gives the last one first: pushed in reverse, folders come out in name order
    for (let index = folders.length - 1; index >= 0; index -= 1) stack.push(folders[index]!);
    if (performance.now() - turnStarted > TURN_MS) {
      await turn();
      turnStarted = performance.now();
    }
  }
  return { name: `${top}.zip`, entries, unread };
}

const encoder = new TextEncoder();

/** A date as the format keeps it: local time, two-second steps, nothing before 1980. */
function dosTime(date: Date): { time: number; day: number } {
  const year = date.getFullYear();
  if (!(year >= 1980)) return { time: 0, day: (1 << 5) | 1 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((Math.min(year, 2107) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

interface Written { entry: ArchiveEntry; name: Uint8Array; crc: number; size: number; offset: number; zip64: boolean }

function localHeader(entry: ArchiveEntry, name: Uint8Array, zip64: boolean): Uint8Array {
  const extra = zip64 ? 20 : 0;
  const bytes = new Uint8Array(30 + name.length + extra);
  const view = new DataView(bytes.buffer);
  const { time, day } = dosTime(entry.modified);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, zip64 ? 45 : 20, true);
  // names are UTF-8 (bit 11); a file's checksum and length follow its bytes (bit 3)
  view.setUint16(6, entry.folder ? 0x0800 : 0x0808, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, time, true);
  view.setUint16(12, day, true);
  view.setUint32(14, 0, true);
  view.setUint32(18, zip64 ? FOUR_GB : 0, true);
  view.setUint32(22, zip64 ? FOUR_GB : 0, true);
  view.setUint16(26, name.length, true);
  view.setUint16(28, extra, true);
  bytes.set(name, 30);
  if (zip64) {
    // the ZIP64 field's presence is what says the descriptor's lengths are 8 bytes each
    view.setUint16(30 + name.length, 0x0001, true);
    view.setUint16(32 + name.length, 16, true);
  }
  return bytes;
}

function descriptor(crc: number, size: number, zip64: boolean): Uint8Array {
  const bytes = new Uint8Array(zip64 ? 24 : 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x08074b50, true);
  view.setUint32(4, crc, true);
  if (zip64) {
    view.setBigUint64(8, BigInt(size), true);
    view.setBigUint64(16, BigInt(size), true);
  } else {
    view.setUint32(8, size, true);
    view.setUint32(12, size, true);
  }
  return bytes;
}

function centralRecord({ entry, name, crc, size, offset, zip64 }: Written): Uint8Array {
  const farOffset = offset >= FOUR_GB;
  const extra = (zip64 ? 16 : 0) + (farOffset ? 8 : 0);
  const bytes = new Uint8Array(46 + name.length + (extra > 0 ? 4 + extra : 0));
  const view = new DataView(bytes.buffer);
  const { time, day } = dosTime(entry.modified);
  view.setUint32(0, 0x02014b50, true);
  // made on Unix (3), so the high half of the external attributes is the file's mode
  view.setUint16(4, (3 << 8) | 45, true);
  view.setUint16(6, extra > 0 ? 45 : 20, true);
  view.setUint16(8, entry.folder ? 0x0800 : 0x0808, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, time, true);
  view.setUint16(14, day, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, zip64 ? FOUR_GB : size, true);
  view.setUint32(24, zip64 ? FOUR_GB : size, true);
  view.setUint16(28, name.length, true);
  view.setUint16(30, extra > 0 ? 4 + extra : 0, true);
  view.setUint32(38, (((entry.mode & 0xffff) << 16) | (entry.folder ? 0x10 : 0)) >>> 0, true);
  view.setUint32(42, farOffset ? FOUR_GB : offset, true);
  bytes.set(name, 46);
  if (extra > 0) {
    let at = 46 + name.length;
    view.setUint16(at, 0x0001, true);
    view.setUint16(at + 2, extra, true);
    at += 4;
    // only the fields whose old place holds the marker, in this order
    if (zip64) {
      view.setBigUint64(at, BigInt(size), true);
      view.setBigUint64(at + 8, BigInt(size), true);
      at += 16;
    }
    if (farOffset) view.setBigUint64(at, BigInt(offset), true);
  }
  return bytes;
}

function ending(count: number, directorySize: number, directoryOffset: number): Uint8Array {
  const zip64 = count >= 0xffff || directorySize >= FOUR_GB || directoryOffset >= FOUR_GB;
  const bytes = new Uint8Array((zip64 ? 56 + 20 : 0) + 22);
  const view = new DataView(bytes.buffer);
  let at = 0;
  if (zip64) {
    view.setUint32(0, 0x06064b50, true);
    view.setBigUint64(4, 44n, true);
    view.setUint16(12, (3 << 8) | 45, true);
    view.setUint16(14, 45, true);
    view.setBigUint64(24, BigInt(count), true);
    view.setBigUint64(32, BigInt(count), true);
    view.setBigUint64(40, BigInt(directorySize), true);
    view.setBigUint64(48, BigInt(directoryOffset), true);
    // where that record is, for a reader that starts from the end
    view.setUint32(56, 0x07064b50, true);
    view.setBigUint64(64, BigInt(directoryOffset + directorySize), true);
    view.setUint32(72, 1, true);
    at = 76;
  }
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, Math.min(count, 0xffff), true);
  view.setUint16(at + 10, Math.min(count, 0xffff), true);
  view.setUint32(at + 12, Math.min(directorySize, FOUR_GB), true);
  view.setUint32(at + 16, Math.min(directoryOffset, FOUR_GB), true);
  return bytes;
}

/**
 * The archive's bytes, in order. A file is read up to the length the plan saw: one that grew
 * since is cut there, so an entry planned without ZIP64 cannot outgrow its fields. A file that
 * cannot be opened now is skipped and named in the note; one that fails part-way ends the
 * stream with its error, since its entry has begun and cannot be taken back.
 */
export async function* archiveBytes(plan: ArchivePlan): AsyncGenerator<Uint8Array, void, void> {
  const written: Written[] = [];
  const unread = [...plan.unread];
  const top = plan.entries[0]?.name ?? "";
  let offset = 0;
  for (const entry of plan.entries) {
    const name = encoder.encode(entry.name);
    if (entry.folder || entry.path === null) {
      const header = localHeader(entry, name, false);
      written.push({ entry, name, crc: 0, size: 0, offset, zip64: false });
      offset += header.length;
      yield header;
      continue;
    }
    let handle;
    try {
      handle = await open(entry.path, "r");
    } catch {
      unread.push(entry.name.slice(top.length));
      continue;
    }
    const zip64 = entry.size >= FOUR_GB;
    const header = localHeader(entry, name, zip64);
    const start = offset;
    offset += header.length;
    yield header;
    let crc = 0;
    let size = 0;
    try {
      while (size < entry.size) {
        const chunk = new Uint8Array(Math.min(READ_BYTES, entry.size - size));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
        if (bytesRead === 0) break;
        const part = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
        crc = crc32(part, crc);
        size += bytesRead;
        yield part;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    const tail = descriptor(crc, size, zip64);
    written.push({ entry, name, crc, size, offset: start, zip64 });
    offset += size + tail.length;
    yield tail;
  }
  if (unread.length > 0) {
    // known only after the last file was tried: the note is the archive's last entry
    const body = encoder.encode(`These could not be read and are not in this archive:\n\n${unread.join("\n")}\n`);
    const entry: ArchiveEntry = { name: `${top}${NOTE_NAME}`, path: null, size: body.length, modified: new Date(), mode: 0o100644, folder: false };
    const name = encoder.encode(entry.name);
    const header = localHeader(entry, name, false);
    const crc = crc32(body);
    const tail = descriptor(crc, body.length, false);
    written.push({ entry, name, crc, size: body.length, offset, zip64: false });
    offset += header.length + body.length + tail.length;
    yield header;
    yield body;
    yield tail;
  }
  const directoryOffset = offset;
  let directorySize = 0;
  let batch: Uint8Array[] = [];
  let batchBytes = 0;
  const flush = (): Uint8Array => {
    const joined = new Uint8Array(batchBytes);
    let at = 0;
    for (const part of batch) { joined.set(part, at); at += part.length; }
    batch = [];
    batchBytes = 0;
    return joined;
  };
  for (const item of written) {
    const record = centralRecord(item);
    directorySize += record.length;
    batch.push(record);
    batchBytes += record.length;
    if (batchBytes >= READ_BYTES) yield flush();
  }
  batch.push(ending(written.length, directorySize, directoryOffset));
  batchBytes += batch[batch.length - 1]!.length;
  yield flush();
}

let active = 0;

/** Whether another archive may start now. */
export function archiveSlotFree(): boolean {
  return active < ARCHIVE_MAX_ACTIVE;
}

/**
 * The archive as a download. The stream asks for bytes only as the browser takes them, so a slow
 * phone holds nothing here but the chunk in hand, and a download that is cancelled closes the
 * file being read.
 */
export function archiveResponse(plan: ArchivePlan): Response {
  const bytes = archiveBytes(plan);
  active += 1;
  let ended = false;
  const end = (): void => { if (!ended) { ended = true; active -= 1; } };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await bytes.next();
        if (next.done) { end(); controller.close(); } else controller.enqueue(next.value);
      } catch (error) {
        end();
        console.error(`archive ${plan.name}: ${error instanceof Error ? error.message : String(error)}`);
        controller.error(error);
      }
    },
    async cancel() {
      end();
      await bytes.return().catch(() => undefined);
    },
  });
  return new Response(stream, { headers: {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(plan.name)}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  } });
}
