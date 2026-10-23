import { officeKind } from "../../shared/office.ts";
import type { FileInfo, FileKind, PdfPreview } from "../../shared/protocol.ts";
import { ApiError, routeMissing } from "./api.ts";

/**
 * The kind the viewer opens a file as: the server's, or for a PC whose server is from before
 * office files had kinds (it calls one `binary`, an RTF `text`) the one its name says.
 */
export function viewerKind(info: FileInfo): FileKind {
  if (info.kind !== "binary" && info.kind !== "text") return info.kind;
  return officeKind(info.name) ?? info.kind;
}

/**
 * How long a preview is waited for in all: LibreOffice's own deadline is two minutes, and a file
 * can queue behind others. Each ask waits on the server (20 s), so the asks are no busy loop.
 */
export const PREVIEW_DEADLINE_MS = 5 * 60_000;
/** Asks lost to the connection (a phone waking up, a PC's proxy) that are made again before it gives up. */
const PREVIEW_RETRIES = 3;
const PREVIEW_RETRY_MS = 1_000;

export class PreviewDeadline extends Error {
  constructor() {
    super("the preview took too long");
    this.name = "PreviewDeadline";
  }
}

/** An ask lost on the way rather than refused: the conversion goes on, so it is asked about again. */
function lostAsk(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true; // a dropped connection or an ask's own deadline
  return error.code === "machine_timeout" || error.code === "machine_unavailable" || error.code === "preview_busy"
    || (error.code === null && error.status >= 502);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Asks for a preview until it is ready (`converting` answers mean ask again). A lost ask is made
 * again a few times, a little later each time; a refusal ends it, and so does the deadline.
 */
export async function awaitPreview(
  ask: (signal: AbortSignal) => Promise<PdfPreview>,
  signal: AbortSignal,
  { deadlineMs = PREVIEW_DEADLINE_MS, retryMs = PREVIEW_RETRY_MS, now = Date.now }: { deadlineMs?: number; retryMs?: number; now?: () => number } = {},
): Promise<{ id: string; size: number }> {
  const deadline = now() + deadlineMs;
  let lost = 0;
  for (;;) {
    if (signal.aborted) throw signal.reason;
    try {
      const answer = await ask(signal);
      if (answer.state === "ready") return answer;
      lost = 0;
    } catch (error) {
      if (signal.aborted || !lostAsk(error) || ++lost > PREVIEW_RETRIES) throw error;
      await pause(retryMs * lost, signal);
    }
    if (now() >= deadline) throw new PreviewDeadline();
  }
}

/** What went wrong with a preview, in the words the viewer has for each case. */
export type PreviewProblem = "unavailable" | "outdated" | "missing" | "failed" | "protected" | "timeout" | "too_large" | "busy" | "other";

/**
 * Whether the server that described `info` is from before previews: it gave an office file no
 * office kind (`binary`, or `text` for an RTF). Only such a server's 404 means a missing route.
 */
export function olderServer(info: FileInfo): boolean {
  return info.kind !== viewerKind(info);
}

/** `older`: the file's server is from before previews (`olderServer`), so its 404 is the route's, not the file's. */
export function previewProblem(error: unknown, older: boolean): PreviewProblem {
  if (error instanceof PreviewDeadline) return "timeout";
  if (routeMissing(error)) return older ? "outdated" : "missing";
  if (!(error instanceof ApiError)) return "other";
  switch (error.code) {
    case "preview_unavailable": return "unavailable";
    case "preview_failed": return "failed";
    case "preview_protected": return "protected";
    case "preview_timeout": return "timeout";
    case "preview_too_large": return "too_large";
    case "preview_busy": return "busy";
    default: return "other";
  }
}
