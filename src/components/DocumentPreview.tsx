import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { FileInfo } from "../../shared/protocol.ts";
import { awaitPreview, olderServer, previewProblem, type PreviewProblem } from "../lib/documents.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";

const PdfView = lazy(() => import("./PdfView.tsx"));

/** After this long a conversion says that a long document takes a while. */
const SLOW_MS = 8_000;

export interface DocumentPreviewProps {
  info: FileInfo;
  paneId: string | null;
  /** the PDF's address once it is ready (null until then), for the viewer's "Open in a new tab" */
  onPdf?: (url: string | null) => void;
}

/**
 * A Word, PowerPoint or Excel file shown as the PDF LibreOffice prints it to on the PC that has
 * the file (GET /api/fs/preview), drawn by PdfView. A file that cannot be converted says why,
 * and the download stays in the viewer's header.
 */
export function DocumentPreview({ info, paneId, onPdf }: DocumentPreviewProps) {
  const t = useT();
  const { fetchFilePreview, filePreviewUrl } = useMachineApi();
  // a PC whose server is from before previews answers their route with a 404
  const older = olderServer(info);
  const [pdf, setPdf] = useState<string | null>(null);
  const [problem, setProblem] = useState<PreviewProblem | null>(null);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const tell = useRef(onPdf);
  tell.current = onPdf;

  useEffect(() => {
    const abort = new AbortController();
    setPdf(null); setProblem(null); setSlow(false);
    tell.current?.(null);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_MS);
    awaitPreview((signal) => fetchFilePreview(info.path, paneId, signal), abort.signal).then(({ id }) => {
      if (abort.signal.aborted) return;
      const url = filePreviewUrl(id, info.name);
      setPdf(url);
      tell.current?.(url);
    }, (error: unknown) => {
      if (abort.signal.aborted) return;
      console.warn(`preview ${info.name}:`, error);
      setProblem(previewProblem(error, older));
    }).finally(() => clearTimeout(slowTimer));
    return () => {
      abort.abort();
      clearTimeout(slowTimer);
    };
  }, [info.path, info.name, info.modified, paneId, attempt, fetchFilePreview, filePreviewUrl, older]);

  if (problem !== null) {
    const message = {
      unavailable: t("Previewing Word, Excel and PowerPoint files needs LibreOffice on the PC that has them. Download the file to open it."),
      outdated: t("This PC needs an update before it can preview documents. Download the file to open it."),
      missing: t("No readable file at this path."),
      failed: t("LibreOffice could not open this file. It may be damaged or password protected."),
      protected: t("This file is password protected. Download it to open it."),
      timeout: t("Converting this file took too long."),
      too_large: t("This file is too large to preview. Download it instead."),
      busy: t("Too many files are being converted. Try again in a minute."),
      other: t("The file could not be opened."),
    }[problem];
    const retry = problem === "failed" || problem === "timeout" || problem === "busy" || problem === "other";
    return (
      <div className="document-preview-note">
        <p className="file-viewer-note" role="alert">{message}</p>
        {retry && <button type="button" className="btn btn-ghost" onClick={() => setAttempt((n) => n + 1)}>{t("Try again")}</button>}
      </div>
    );
  }
  if (pdf === null) {
    return (
      <div className="document-preview-note" role="status">
        <span className="document-preview-dot" aria-hidden="true" />
        <p className="file-viewer-note">{t("Preparing the preview…")}</p>
        {slow && <p className="file-viewer-note">{t("A long document can take a minute.")}</p>}
      </div>
    );
  }
  return (
    <Suspense fallback={<p className="file-viewer-note">{t("Opening…")}</p>}>
      <PdfView url={pdf} name={info.name} />
    </Suspense>
  );
}
