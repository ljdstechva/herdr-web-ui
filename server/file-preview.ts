import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { FileInfo, PdfPreview } from "../shared/protocol.ts";

/**
 * Word, PowerPoint and Excel files opened from the browser: LibreOffice prints them to a PDF on
 * the PC that has them, and the viewer draws that PDF (a phone has no Office to open them with).
 *
 * A conversion takes seconds and LibreOffice runs one at a time per profile, so conversions
 * queue, the same file asked for twice shares one, and the PDF is kept by the file's path, size
 * and modification time: a file opened again opens at once, and a changed file is converted
 * again. LibreOffice works on a copy in a folder of its own, with a profile of its own, so it
 * never leaves a lock file beside the user's document (a folder a laptop may mirror) and never
 * meets a LibreOffice the user has open.
 */

export class PreviewError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "PreviewError";
  }
}

const PREVIEWABLE = new Set<string>(["document", "presentation", "spreadsheet"]);

/** Whether `info` is a file LibreOffice can print to a PDF (file-view.ts tells the kind). */
export function previewable(info: FileInfo): boolean {
  return PREVIEWABLE.has(info.kind);
}

/** Bumped when the conversion changes, so a PDF made the old way is made again. */
const FORMAT = "1";
/** Larger files are offered as a download: LibreOffice would hold them for minutes. */
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 120_000;
/** Conversions waiting behind the running one; past this an ask is refused rather than queued for minutes. */
const MAX_QUEUED = 8;
const KEPT_FILES = 40;
const KEPT_BYTES = 128 * 1024 * 1024;
/** A failed conversion is told to the asks that come after it within this, instead of being tried again by a poll. */
const FAILURE_KEPT_MS = 60_000;
/** A job folder older than this is a conversion that died with its server (one is killed long before). */
const STALE_JOB_MS = 10 * 60_000;
const ID = /^[0-9a-f]{64}$/;
const STDERR_KEPT = 2048;

/** Office Open XML and OpenDocument files are zip archives; the older formats are not checked (a `.doc` is often RTF or HTML). */
const ZIPPED = /\.(?:docx|docm|dotx|xlsx|xlsm|xlsb|pptx|pptm|ppsx|potx|odt|ods|odp)$/i;
const ZIP = [0x50, 0x4b, 0x03, 0x04];
/** An OLE container: what Office writes a password-protected docx, xlsx or pptx as. */
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * Why a file that should be a zip is not one, or null when it is (or need not be): LibreOffice
 * opens anything as text, so a damaged file would show as pages of noise, and it would wait for a
 * password nobody can type in a protected one.
 */
export function unconvertible(path: string): PreviewError | null {
  if (!ZIPPED.test(path)) return null;
  const head = Buffer.alloc(OLE.length);
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    readSync(fd, head, 0, head.length, 0);
  } catch {
    return new PreviewError("preview_failed", "The file could not be read", 422);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (ZIP.every((byte, index) => head[index] === byte)) return null;
  if (OLE.every((byte, index) => head[index] === byte)) return new PreviewError("preview_protected", "This file is password protected", 422);
  return new PreviewError("preview_failed", "This is not a file LibreOffice can open; it may be damaged", 422);
}

/** The PDF's name: the file and the moment it was last changed, so a changed file is a new PDF. */
export function previewId(info: FileInfo): string {
  return createHash("sha256").update(`${FORMAT}\0${info.path}\0${info.size}\0${info.modified}`).digest("hex");
}

/**
 * LibreOffice's `soffice`: HERDR_WEB_SOFFICE, else on PATH, else where its installers put it.
 * Null when there is none.
 */
export function findSoffice(env: Record<string, string | undefined> = process.env): string | null {
  const configured = env["HERDR_WEB_SOFFICE"]?.trim();
  if (configured) return configured;
  for (const name of ["soffice", "libreoffice"]) {
    const found = Bun.which(name);
    if (found) return found;
  }
  const installed = process.platform === "darwin"
    ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
    : process.platform === "win32"
      ? [env["ProgramFiles"], env["ProgramFiles(x86)"]].filter((dir): dir is string => !!dir).map((dir) => join(dir, "LibreOffice", "program", "soffice.exe"))
      : ["/usr/lib/libreoffice/program/soffice", "/opt/libreoffice/program/soffice", "/snap/bin/libreoffice"];
  return installed.find((path) => existsSync(path)) ?? null;
}

export interface DocumentPreviewsOptions {
  /** where the PDFs, the conversions under way and LibreOffice's profile live; created 0700 */
  directory: string;
  /** null: no LibreOffice here (every preview answers `preview_unavailable`); unset: `findSoffice()`, asked again while it finds none */
  soffice?: string | null;
  /** CONVERT_TIMEOUT_MS; tests shorten it */
  timeoutMs?: number;
}

const unavailable = () => new PreviewError("preview_unavailable", "Previewing this file needs LibreOffice on this PC", 501);

export class DocumentPreviews {
  private readonly directory: string;
  private readonly timeoutMs: number;
  private readonly configured: string | null | undefined;
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, { error: PreviewError; at: number }>();
  /** the conversion running, and those behind it, one after another */
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private readonly running = new Set<() => void>();
  private stopped = false;

  constructor(options: DocumentPreviewsOptions) {
    this.directory = options.directory;
    this.timeoutMs = options.timeoutMs ?? CONVERT_TIMEOUT_MS;
    this.configured = options.soffice;
  }

  /** looked up on every ask (a PATH lookup), so a LibreOffice installed while the server runs is found */
  private soffice(): string | null {
    return this.configured !== undefined ? this.configured : findSoffice();
  }

  /**
   * The PDF of `info`, converting it if need be. Waits up to `waitMs` for a conversion and then
   * answers `converting`; the conversion goes on, and the next ask joins it.
   */
  async preview(info: FileInfo, waitMs: number): Promise<PdfPreview> {
    if (!previewable(info)) throw new PreviewError("not_previewable", "This file has no preview", 415);
    if (info.size > MAX_SOURCE_BYTES) throw new PreviewError("preview_too_large", "This file is too large to preview; download it instead", 413);
    // before the kept PDFs too: eight bytes, and one kept from before a file was damaged is not shown
    const refused = unconvertible(info.path);
    if (refused !== null) throw refused;
    const id = previewId(info);
    const ready = this.ready(id);
    if (ready !== null) return ready;
    const failure = this.failures.get(id);
    if (failure !== undefined) {
      this.failures.delete(id);
      if (Date.now() - failure.at < FAILURE_KEPT_MS) throw failure.error;
    }
    const job = this.inflight.get(id) ?? this.enqueue(info, id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const finished = await Promise.race([
        job.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), waitMs); }),
      ]);
      if (!finished) return { state: "converting" };
    } catch (error) {
      // this ask is told; a later one converts again
      this.failures.delete(id);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const done = this.ready(id);
    if (done === null) throw new PreviewError("preview_failed", "The converted file is gone; open it again", 422);
    return done;
  }

  /** The PDF an id names, or null (never made, or since removed). */
  pdfPath(id: string): string | null {
    if (!ID.test(id)) return null;
    const path = join(this.directory, `${id}.pdf`);
    return existsSync(path) ? path : null;
  }

  /** Ends the conversion under way and refuses new ones. */
  stop(): void {
    this.stopped = true;
    for (const kill of this.running) kill();
  }

  private ready(id: string): PdfPreview | null {
    const path = this.pdfPath(id);
    if (path === null) return null;
    try {
      const { size } = statSync(path);
      // the most recently opened PDFs are the ones kept
      const now = new Date();
      utimesSync(path, now, now);
      return { state: "ready", id, size };
    } catch {
      return null;
    }
  }

  private enqueue(info: FileInfo, id: string): Promise<void> {
    if (this.soffice() === null) throw unavailable();
    if (this.queued >= MAX_QUEUED) throw new PreviewError("preview_busy", "Too many files are being converted; try again in a minute", 503);
    this.queued += 1;
    const job = this.tail.then(() => this.convert(info, id));
    this.tail = job.then(() => undefined, () => undefined);
    const tracked = job.finally(() => {
      this.queued -= 1;
      this.inflight.delete(id);
    });
    // kept for the asks that poll after it failed; also what keeps the rejection handled when nobody waits
    tracked.catch((error: unknown) => {
      this.failures.set(id, { error: error instanceof PreviewError ? error : new PreviewError("preview_failed", "The file could not be converted", 422), at: Date.now() });
      for (const [key, failure] of this.failures) if (Date.now() - failure.at >= FAILURE_KEPT_MS) this.failures.delete(key);
    });
    this.inflight.set(id, tracked);
    return tracked;
  }

  private async convert(info: FileInfo, id: string): Promise<void> {
    if (this.stopped) throw new PreviewError("preview_failed", "The server is stopping", 503);
    const soffice = this.soffice();
    if (soffice === null) throw unavailable();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.removeStaleJobs();
    const job = mkdtempSync(join(this.directory, "job-"));
    try {
      // LibreOffice names its output after its input: source.<ext> prints to source.pdf
      const source = join(job, `source${extname(info.path).toLowerCase()}`);
      try {
        copyFileSync(info.path, source);
      } catch (error) {
        console.error(`preview copy ${info.path}: ${error instanceof Error ? error.message : String(error)}`);
        throw new PreviewError("preview_failed", "The file could not be read", 422);
      }
      await this.run(soffice, source, job);
      const pdf = join(job, "source.pdf");
      let size = 0;
      try { size = statSync(pdf).size; } catch { /* no output: told below */ }
      if (size === 0) throw new PreviewError("preview_failed", "LibreOffice could not open this file; it may be damaged or password protected", 422);
      chmodSync(pdf, 0o600);
      renameSync(pdf, join(this.directory, `${id}.pdf`));
      this.prune();
    } finally {
      rmSync(job, { recursive: true, force: true });
    }
  }

  /** One `soffice --convert-to pdf`, at low priority where `nice` exists, killed with its children at the deadline. */
  private run(soffice: string, source: string, job: string): Promise<void> {
    const args = [
      `-env:UserInstallation=${pathToFileURL(join(this.directory, "profile")).href}`,
      "--headless", "--invisible", "--nodefault", "--nologo", "--nolockcheck", "--norestore",
      "--convert-to", "pdf", "--outdir", job, source,
    ];
    const windows = process.platform === "win32";
    const nice = windows ? null : Bun.which("nice");
    const command = nice ? [nice, "-n", "10", soffice, ...args] : [soffice, ...args];
    return new Promise<void>((resolve, reject) => {
      // its own process group, so the deadline ends soffice.bin too and not only the launcher
      const child = spawn(command[0]!, command.slice(1), {
        cwd: job,
        detached: !windows,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, TMPDIR: job, TMP: job, TEMP: job },
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT); });
      let timedOut = false;
      const kill = () => {
        try {
          if (!windows && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch { /* already gone */ }
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, this.timeoutMs);
      this.running.add(kill);
      const settle = () => { clearTimeout(timer); this.running.delete(kill); };
      child.on("error", (error: NodeJS.ErrnoException) => {
        settle();
        console.error(`preview soffice ${soffice}: ${error.message}`);
        reject(error.code === "ENOENT" ? unavailable() : new PreviewError("preview_failed", "LibreOffice could not be started", 422));
      });
      child.on("close", (code, signal) => {
        settle();
        if (timedOut) { reject(new PreviewError("preview_timeout", "LibreOffice took too long to convert this file", 504)); return; }
        if (this.stopped && signal !== null) { reject(new PreviewError("preview_failed", "The server is stopping", 503)); return; }
        // an unreadable file still exits 0: the missing PDF is what tells
        if (code !== 0) console.error(`preview soffice exited ${code ?? signal}: ${stderr.trim()}`);
        resolve();
      });
    });
  }

  /** The least recently opened PDFs go first, past KEPT_FILES or KEPT_BYTES. */
  private prune(): void {
    try {
      const pdfs = readdirSync(this.directory)
        .filter((name) => /^[0-9a-f]{64}\.pdf$/.test(name))
        .flatMap((name) => {
          try {
            const stat = statSync(join(this.directory, name));
            return [{ name, size: stat.size, used: stat.mtimeMs }];
          } catch { return []; }
        })
        .sort((a, b) => b.used - a.used);
      let bytes = 0;
      pdfs.forEach((pdf, index) => {
        bytes += pdf.size;
        if (index >= KEPT_FILES || bytes > KEPT_BYTES) rmSync(join(this.directory, pdf.name), { force: true });
      });
    } catch (error) {
      console.error(`preview prune: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private removeStaleJobs(): void {
    try {
      for (const name of readdirSync(this.directory)) {
        if (!name.startsWith("job-")) continue;
        const path = join(this.directory, name);
        try {
          if (Date.now() - statSync(path).mtimeMs > STALE_JOB_MS) rmSync(path, { recursive: true, force: true });
        } catch { /* another server's, gone meanwhile */ }
      }
    } catch { /* nothing to clear */ }
  }
}

/** The PDF itself, named after the file it was made from. */
export function previewResponse(path: string, name: string | null): Response {
  const stem = basename(name ?? "preview").replace(/\.[^.]*$/, "") || "preview";
  const headers = new Headers({
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(`${stem}.pdf`)}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    // pdf.js reads it a part at a time (file-view.ts says why)
    "accept-ranges": "bytes",
  });
  return new Response(Bun.file(path, { type: "application/pdf" }), { headers });
}
