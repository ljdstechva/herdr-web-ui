import { describe, expect, it } from "bun:test";
import type { FileInfo, PdfPreview } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import { awaitPreview, PreviewDeadline, previewProblem, viewerKind } from "./documents.ts";
import { anchoredScroll, clampZoom } from "./zoomGestures.ts";

const file = (name: string, kind: FileInfo["kind"]): FileInfo => ({ path: `/w/${name}`, name, size: 1, modified: "2026-10-23T00:00:00.000Z", mime: "application/octet-stream", kind });
const refused = (status: number, code: string | null) => new ApiError("/api/fs/preview", status, "no", code);

describe("documents", () => {
  it("opens an office file from an older PC by its name", () => {
    expect(viewerKind(file("report.docx", "binary"))).toBe("document");
    expect(viewerKind(file("memo.RTF", "text"))).toBe("document");
    expect(viewerKind(file("data.xlsx", "binary"))).toBe("spreadsheet");
    expect(viewerKind(file("deck.pptx", "binary"))).toBe("presentation");
    expect(viewerKind(file("notes.txt", "text"))).toBe("text");
    expect(viewerKind(file("blob.bin", "binary"))).toBe("binary");
    expect(viewerKind(file("constructor", "binary"))).toBe("binary");
    // the server's own kind stands
    expect(viewerKind(file("scan.pdf", "pdf"))).toBe("pdf");
  });

  it("asks again while LibreOffice works, and gives the PDF once it is ready", async () => {
    const answers: PdfPreview[] = [{ state: "converting" }, { state: "converting" }, { state: "ready", id: "a".repeat(64), size: 9 }];
    let asks = 0;
    const ready = await awaitPreview(async () => answers[asks++]!, new AbortController().signal);
    expect(ready).toEqual({ state: "ready", id: "a".repeat(64), size: 9 } as never);
    expect(asks).toBe(3);
  });

  it("asks again after a lost connection, but not after a refusal", async () => {
    let asks = 0;
    const ready = await awaitPreview(async () => {
      asks += 1;
      if (asks === 1) throw new TypeError("Failed to fetch");
      if (asks === 2) throw refused(504, "machine_timeout");
      return { state: "ready", id: "b".repeat(64), size: 1 };
    }, new AbortController().signal, { retryMs: 1 });
    expect(ready.id).toBe("b".repeat(64));
    let refusals = 0;
    const error = await awaitPreview(async () => { refusals += 1; throw refused(422, "preview_failed"); }, new AbortController().signal, { retryMs: 1 }).catch((reason: unknown) => reason);
    expect(previewProblem(error, false)).toBe("failed");
    expect(refusals).toBe(1);
  });

  it("gives up on a connection that stays lost, at its deadline, and when cancelled", async () => {
    let asks = 0;
    const lost = await awaitPreview(async () => { asks += 1; throw new TypeError("Failed to fetch"); }, new AbortController().signal, { retryMs: 1 }).catch((reason: unknown) => reason);
    expect(lost).toBeInstanceOf(TypeError);
    expect(asks).toBe(4);
    let clock = 0;
    const late = await awaitPreview(async () => { clock += 60_000; return { state: "converting" }; }, new AbortController().signal, { now: () => clock, deadlineMs: 120_000 }).catch((reason: unknown) => reason);
    expect(late).toBeInstanceOf(PreviewDeadline);
    expect(previewProblem(late, false)).toBe("timeout");
    const abort = new AbortController();
    const cancelled = awaitPreview(async () => { abort.abort(new Error("closed")); return { state: "converting" }; }, abort.signal).catch((reason: unknown) => reason);
    expect(((await cancelled) as Error).message).toBe("closed");
  });

  it("says what went wrong", () => {
    expect(previewProblem(refused(501, "preview_unavailable"), false)).toBe("unavailable");
    expect(previewProblem(refused(413, "preview_too_large"), false)).toBe("too_large");
    expect(previewProblem(refused(503, "preview_busy"), false)).toBe("busy");
    expect(previewProblem(refused(422, "preview_protected"), false)).toBe("protected");
    // another PC's server from before previews has no such route
    expect(previewProblem(refused(404, "not_found"), true)).toBe("outdated");
    expect(previewProblem(refused(404, "not_found"), false)).toBe("other");
  });

  it("keeps the point under the fingers in place across a zoom", () => {
    expect(clampZoom(9, 0.5, 6)).toBe(6);
    expect(clampZoom(0.1, 0.5, 6)).toBe(0.5);
    // at scroll 100/200, the point 50/80 into the view is content 150/280; doubled it is 300/560
    expect(anchoredScroll(100, 200, { x: 50, y: 80 }, 2)).toEqual({ left: 250, top: 480 });
    expect(anchoredScroll(0, 0, { x: 10, y: 10 }, 0.5)).toEqual({ left: 0, top: 0 });
  });
});
