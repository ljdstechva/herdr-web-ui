import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileInfo } from "./file-view.ts";
import { DocumentPreviews, findSoffice, PreviewError, previewable, previewId, previewResponse } from "./file-preview.ts";

/**
 * A stand-in for soffice: it prints `source.<ext>` in --outdir to `source.pdf` after `delay`
 * seconds, and counts its runs in `runs`. `output: false` prints nothing, as LibreOffice does
 * for a file it cannot open (exiting 0 all the same).
 */
function fakeSoffice(root: string, { delay = 0, output = true } = {}): { path: string; runs: () => number } {
  const path = join(root, `soffice-${Math.random().toString(36).slice(2)}`);
  const counter = `${path}.runs`;
  writeFileSync(path, `#!/bin/sh
echo run >> "${counter}"
out=""; last=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--outdir" ]; then out="$2"; shift; fi
  last="$1"; shift
done
echo $$ > "${path}.pid"
sleep ${delay}
${output ? `name=$(basename "$last"); printf '%%PDF-1.4 fake of %s\\n' "$name" > "$out/\${name%.*}.pdf"` : ":"}
exit 0
`);
  chmodSync(path, 0o755);
  return { path, runs: () => (existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0) };
}

describe.skipIf(process.platform === "win32")("document previews", () => {
  const roots: string[] = [];
  const services: DocumentPreviews[] = [];
  afterEach(() => {
    for (const service of services.splice(0)) service.stop();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const temp = () => { const root = mkdtempSync(join(tmpdir(), "herdr-file-preview-")); roots.push(root); return root; };
  const service = (options: ConstructorParameters<typeof DocumentPreviews>[0]) => { const made = new DocumentPreviews(options); services.push(made); return made; };
  // an Office Open XML file is a zip: the stand-in reads no further than its signature
  const document = (root: string, name = "report.docx", body: string | Buffer = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("a document")])) => {
    const path = join(root, name);
    writeFileSync(path, body);
    return fileInfo(path)!;
  };

  it("tells office files by extension, an RTF too", () => {
    const root = temp();
    expect(document(root, "a.docx").kind).toBe("document");
    expect(document(root, "b.RTF", "{\\rtf1 hi}").kind).toBe("document");
    expect(document(root, "c.xlsx").kind).toBe("spreadsheet");
    expect(document(root, "d.ods").kind).toBe("spreadsheet");
    expect(document(root, "e.pptx").kind).toBe("presentation");
    expect(document(root, "f.csv", "a,b\n1,2\n").kind).toBe("text");
    expect(previewable(document(root, "g.ppt"))).toBe(true);
    expect(previewable(document(root, "h.txt", "words"))).toBe(false);
  });

  it("converts in a folder of its own, keeps the PDF private and leaves nothing beside the file", async () => {
    const root = temp();
    const docs = join(root, "docs");
    mkdirSync(docs);
    const info = document(docs);
    const soffice = fakeSoffice(root);
    const previews = service({ directory: join(root, "previews"), soffice: soffice.path });
    const answer = await previews.preview(info, 5_000);
    expect(answer).toEqual({ state: "ready", id: previewId(info), size: expect.any(Number) });
    const pdf = previews.pdfPath(previewId(info))!;
    expect(readFileSync(pdf, "utf8")).toStartWith("%PDF-1.4 fake of source.docx");
    expect(statSync(pdf).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "previews")).mode & 0o777).toBe(0o700);
    // no lock file, no output and no job folder anywhere but the PDF
    expect(readdirSync(docs)).toEqual(["report.docx"]);
    expect(readdirSync(join(root, "previews")).filter((name) => name.startsWith("job-"))).toEqual([]);
  });

  it("opens a converted file again at once, and converts a changed one again", async () => {
    const root = temp();
    const info = document(root);
    const soffice = fakeSoffice(root);
    const previews = service({ directory: join(root, "previews"), soffice: soffice.path });
    const first = await previews.preview(info, 5_000);
    expect(await previews.preview(info, 5_000)).toEqual(first);
    expect(soffice.runs()).toBe(1);
    const later = new Date(Date.now() + 5_000);
    utimesSync(info.path, later, later);
    const changed = fileInfo(info.path)!;
    const second = await previews.preview(changed, 5_000);
    expect(second.state === "ready" && second.id).not.toBe(first.state === "ready" && first.id);
    expect(soffice.runs()).toBe(2);
  });

  it("shares one conversion between asks, and answers `converting` while it outlasts the wait", async () => {
    const root = temp();
    const info = document(root);
    const soffice = fakeSoffice(root, { delay: 1 });
    const previews = service({ directory: join(root, "previews"), soffice: soffice.path });
    expect(await previews.preview(info, 50)).toEqual({ state: "converting" });
    const [a, b] = await Promise.all([previews.preview(info, 5_000), previews.preview(info, 5_000)]);
    expect(a.state).toBe("ready");
    expect(b).toEqual(a);
    expect(soffice.runs()).toBe(1);
  });

  it("runs conversions one at a time", async () => {
    const root = temp();
    const soffice = fakeSoffice(root, { delay: 0.3 });
    const previews = service({ directory: join(root, "previews"), soffice: soffice.path });
    const started = Date.now();
    const answers = await Promise.all(["a.docx", "b.pptx", "c.xlsx"].map((name) => previews.preview(document(root, name), 10_000)));
    expect(answers.every((answer) => answer.state === "ready")).toBe(true);
    // three 0.3 s runs back to back, not side by side
    expect(Date.now() - started).toBeGreaterThanOrEqual(850);
  });

  it("tells a file LibreOffice cannot open, also to the next poll, and tries again after that", async () => {
    const root = temp();
    const info = document(root);
    const soffice = fakeSoffice(root, { delay: 0.3, output: false });
    const previews = service({ directory: join(root, "previews"), soffice: soffice.path });
    // the poll that started it is gone by the time it fails: the next one is told
    expect(await previews.preview(info, 10)).toEqual({ state: "converting" });
    await Bun.sleep(600);
    const told = await previews.preview(info, 5_000).catch((error: unknown) => error);
    expect(told).toBeInstanceOf(PreviewError);
    expect((told as PreviewError).code).toBe("preview_failed");
    expect(soffice.runs()).toBe(1);
    // asked again by hand, it is tried again
    const again = await previews.preview(info, 5_000).catch((error: unknown) => error);
    expect((again as PreviewError).status).toBe(422);
    expect(soffice.runs()).toBe(2);
  });

  it("kills a conversion that outlasts its deadline", async () => {
    const root = temp();
    const info = document(root);
    const soffice = fakeSoffice(root, { delay: 30 });
    const previews = service({ directory: join(root, "previews"), soffice: soffice.path, timeoutMs: 300 });
    const error = await previews.preview(info, 5_000).catch((reason: unknown) => reason);
    expect((error as PreviewError).code).toBe("preview_timeout");
    const pid = Number(readFileSync(`${soffice.path}.pid`, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("moves on from a conversion whose child outlives the kill and holds its pipe", async () => {
    const root = temp();
    const info = document(root);
    // a child in a session of its own escapes the group kill and keeps stderr open
    const escaped = join(root, "escaped.pid");
    const soffice = join(root, "soffice-escaping");
    writeFileSync(soffice, `#!/bin/sh\nsetsid sh -c 'echo $$ > "${escaped}"; exec sleep 30' &\nsleep 30\n`);
    chmodSync(soffice, 0o755);
    const previews = service({ directory: join(root, "previews"), soffice, timeoutMs: 200 });
    const started = Date.now();
    try {
      const error = await previews.preview(info, 20_000).catch((reason: unknown) => reason);
      expect((error as PreviewError).code).toBe("preview_timeout");
      expect(Date.now() - started).toBeLessThan(9_000);
    } finally {
      try { process.kill(Number(readFileSync(escaped, "utf8")), "SIGKILL"); } catch { /* gone */ }
    }
  }, 15_000);

  it("calls a soffice that is not there no LibreOffice, not a damaged file", async () => {
    expect(findSoffice({ HERDR_WEB_SOFFICE: "/nowhere/soffice" })).toBeNull();
    expect(findSoffice({ HERDR_WEB_SOFFICE: "no-such-office-command" })).toBeNull();
    const root = temp();
    const previews = service({ directory: join(root, "previews"), soffice: "/nowhere/soffice" });
    expect(((await previews.preview(document(root), 5_000).catch((error: unknown) => error)) as PreviewError).code).toBe("preview_unavailable");
  });

  it("refuses without LibreOffice, a file too large, and what is no office file", async () => {
    const root = temp();
    const none = service({ directory: join(root, "previews"), soffice: null });
    expect(((await none.preview(document(root), 1_000).catch((error: unknown) => error)) as PreviewError).code).toBe("preview_unavailable");
    const previews = service({ directory: join(root, "previews"), soffice: fakeSoffice(root).path });
    const huge = document(root, "huge.pptx");
    expect(((await previews.preview({ ...huge, size: 200 * 1024 * 1024 }, 1_000).catch((error: unknown) => error)) as PreviewError).code).toBe("preview_too_large");
    expect(((await previews.preview(document(root, "notes.txt", "words"), 1_000).catch((error: unknown) => error)) as PreviewError).status).toBe(415);
  });

  it("refuses a damaged or protected file before LibreOffice opens it", async () => {
    const root = temp();
    const soffice = fakeSoffice(root);
    const previews = service({ directory: join(root, "previews"), soffice: soffice.path });
    const noise = await previews.preview(document(root, "noise.xlsx", "not a zip at all"), 1_000).catch((error: unknown) => error);
    expect((noise as PreviewError).code).toBe("preview_failed");
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const locked = await previews.preview(document(root, "locked.pptx", ole), 1_000).catch((error: unknown) => error);
    expect((locked as PreviewError).code).toBe("preview_protected");
    expect(soffice.runs()).toBe(0);
    // the older formats are not zips, and a .doc is often RTF or HTML: LibreOffice decides
    expect((await previews.preview(document(root, "old.doc", "{\\rtf1 hi}"), 5_000)).state).toBe("ready");
  });

  it("keeps the PDF it just made, however large, while pruning older ones", async () => {
    const root = temp();
    const previews = service({ directory: join(root, "previews"), soffice: fakeSoffice(root).path });
    const first = await previews.preview(document(root, "a.docx"), 5_000);
    // a stand-in that prints a PDF larger than all the PDFs kept together (sparse: no disk is used)
    const huge = join(root, "soffice-huge");
    writeFileSync(huge, `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "--outdir" ]; then out="$2"; shift; fi; shift; done\nprintf '%%PDF' > "$out/source.pdf"\ntruncate -s 200M "$out/source.pdf"\n`);
    chmodSync(huge, 0o755);
    const large = service({ directory: join(root, "previews"), soffice: huge });
    const answer = await large.preview(document(root, "big.pptx"), 5_000);
    expect(answer.state === "ready" && answer.size).toBe(200 * 1024 * 1024);
    // the older one makes room for it
    expect(first.state === "ready" && previews.pdfPath(first.id)).toBeNull();
  });

  it("names nothing outside its folder by id", () => {
    const root = temp();
    const previews = service({ directory: join(root, "previews"), soffice: null });
    expect(previews.pdfPath("../../etc/passwd")).toBeNull();
    expect(previews.pdfPath("a".repeat(64))).toBeNull();
  });

  it("serves the PDF inline under the document's name", async () => {
    const root = temp();
    const pdf = join(root, "x.pdf");
    writeFileSync(pdf, "%PDF-1.4");
    const response = previewResponse(pdf, "Quarterly report.docx");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''Quarterly%20report.pdf");
    expect(await response.text()).toBe("%PDF-1.4");
  });

  // LibreOffice itself, where it is installed: an RTF needs no Office to write
  it.skipIf(findSoffice() === null)("converts a real document with LibreOffice", async () => {
    const root = temp();
    const info = document(root, "memo.rtf", "{\\rtf1\\ansi{\\fonttbl\\f0\\fswiss Helvetica;}\\f0\\pard Effluent BOD 32 mg/L\\par}");
    const previews = service({ directory: join(root, "previews") });
    let answer = await previews.preview(info, 60_000);
    for (let tries = 0; answer.state === "converting" && tries < 6; tries += 1) answer = await previews.preview(info, 20_000);
    expect(answer.state).toBe("ready");
    const pdf = previews.pdfPath(previewId(info))!;
    expect(readFileSync(pdf).subarray(0, 5).toString()).toBe("%PDF-");
    expect(readdirSync(root).sort()).toEqual(["memo.rtf", "previews"]);
  }, 180_000);
});
