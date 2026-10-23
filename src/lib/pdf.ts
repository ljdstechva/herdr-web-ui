import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/**
 * The folder the build put pdf.js's own data in (vite.config.ts): the CMaps of CJK text, the 14
 * standard fonts a PDF may leave out, and the JavaScript decoders of scanned images (JBIG2, JPEG
 * 2000, fax). `pdfjs-<version>/`, beside this chunk under /assets/, so it is cached like the
 * bundles and found under any base the app is built for (the demo's is relative).
 */
declare const __PDFJS_DATA__: string;
// read when a PDF opens, not as the module loads: a bundle built without Vite's defines still loads
const pdfjsData = (name: string): string => new URL(`${__PDFJS_DATA__}${name}/`, import.meta.url).href;

let library: Promise<PdfJs> | null = null;

/**
 * pdf.js, imported the first time a PDF opens (it is a large chunk, and its worker a larger one),
 * with one worker for every PDF after it.
 */
function pdfjs(): Promise<PdfJs> {
  if (library === null) {
    const loading = import("pdfjs-dist/legacy/build/pdf.mjs").then((lib) => {
      lib.GlobalWorkerOptions.workerPort ??= new Worker(new URL("./pdf.worker.ts", import.meta.url), { type: "module" });
      return lib;
    });
    // a failed import (the server restarted with a new build) is tried again next time
    loading.catch(() => { if (library === loading) library = null; });
    library = loading;
  }
  return library;
}

/** Why a PDF did not open, for the words the viewer has for each case. */
export type PdfProblem = "password" | "damaged" | "missing" | "other";

export function pdfProblem(error: unknown): PdfProblem {
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") return "password";
  if (name === "InvalidPDFException" || name === "FormatError") return "damaged";
  if (name === "ResponseException" || name === "MissingPDFException") return "missing";
  return "other";
}

/**
 * The PDF at `url` (same-origin, so the session cookie goes along), read in ranges as pages are
 * drawn. `onProgress` gets the fraction read while the first part arrives. Abort stops the load;
 * the caller destroys the document it got.
 */
export async function loadPdf(url: string, signal: AbortSignal, onProgress?: (fraction: number) => void): Promise<PDFDocumentProxy> {
  const lib = await pdfjs();
  if (signal.aborted) throw signal.reason;
  const task = lib.getDocument({
    url,
    cMapUrl: pdfjsData("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: pdfjsData("standard_fonts"),
    wasmUrl: pdfjsData("wasm"),
    // the app's script-src has no 'wasm-unsafe-eval': image decoders run as the JavaScript builds
    useWasm: false,
    enableXfa: false,
  });
  if (onProgress) task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => { if (total > 0) onProgress(Math.min(1, loaded / total)); };
  const stop = () => { void task.destroy(); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await task.promise;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/**
 * The page's text as transparent, selectable spans over its drawing, laid out at scale 1: the
 * page's `--total-scale-factor` sizes it, so a zoom moves no span. Abort cancels it.
 */
export async function drawTextLayer(page: PDFPageProxy, container: HTMLElement, signal: AbortSignal): Promise<void> {
  const lib = await pdfjs();
  if (signal.aborted) return;
  const layer = new lib.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: page.getViewport({ scale: 1 }) });
  const stop = () => layer.cancel();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await layer.render();
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export type { PDFDocumentProxy, PDFPageProxy };
