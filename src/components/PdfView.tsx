import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import "./PdfView.css";
import { ZoomControls } from "./ZoomControls.tsx";
import { useT } from "../lib/i18n.ts";
import { drawTextLayer, loadPdf, pdfProblem, type PdfProblem, type PDFDocumentProxy } from "../lib/pdf.ts";
import { anchoredScroll, clampZoom, useZoomGestures, ZOOM_STEP, type ZoomAnchor } from "../lib/zoomGestures.ts";

/** The space around and between pages: `--space-3`, which .pdf-pages pads with. */
const GAP = 12;
/** A page fitted to a wide desktop viewer is drawn no larger than this times its printed size. */
const MAX_FIT_SCALE = 1.5;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;
/** A page's drawing holds at most this many pixels (a phone's canvas budget); past it a deep zoom draws coarser. */
const MAX_CANVAS_PIXELS = 8 * 1024 * 1024;
/** Page sizes read per round: a report mixes portrait pages with landscape tables. */
const SIZE_BATCH = 24;

/** A page at scale 1: PDF points as CSS px, its rotation applied. */
interface PageSize {
  width: number;
  height: number;
}

export interface PdfViewProps {
  url: string;
  name: string;
}

/**
 * A PDF drawn in the page with pdf.js, the same on every browser (Chrome on Android has no PDF
 * viewer for a frame). Pages are drawn as they come near the view and let go of when far from it,
 * each fitted to the width; pinch, Ctrl+wheel or the buttons zoom, and the text layer over each
 * drawing selects and copies.
 */
export default function PdfView({ url, name }: PdfViewProps) {
  const t = useT();
  const area = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [problem, setProblem] = useState<PdfProblem | null>(null);
  const [progress, setProgress] = useState(0);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(1);
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set());
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  const pendingScroll = useRef<{ left: number; top: number; anchor: ZoomAnchor; ratio: number } | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    let opened: PDFDocumentProxy | null = null;
    setDoc(null); setSizes([]); setProblem(null); setProgress(0); setZoom(1); setCurrent(1);
    void (async () => {
      const pdf = await loadPdf(url, abort.signal, setProgress);
      opened = pdf;
      if (abort.signal.aborted) return;
      const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
      if (abort.signal.aborted) return;
      // every page at the first one's size until its own is read
      setSizes(Array.from({ length: pdf.numPages }, () => ({ width: first.width, height: first.height })));
      setDoc(pdf);
      for (let start = 2; start <= pdf.numPages; start += SIZE_BATCH) {
        const numbers = Array.from({ length: Math.min(SIZE_BATCH, pdf.numPages - start + 1) }, (_, index) => start + index);
        const batch = await Promise.all(numbers.map(async (number) => {
          const viewport = (await pdf.getPage(number)).getViewport({ scale: 1 });
          return { number, width: viewport.width, height: viewport.height };
        }));
        if (abort.signal.aborted) return;
        setSizes((old) => {
          const changed = batch.filter(({ number, width: w, height: h }) => old[number - 1]?.width !== w || old[number - 1]?.height !== h);
          if (changed.length === 0) return old;
          const next = old.slice();
          for (const { number, width: w, height: h } of changed) next[number - 1] = { width: w, height: h };
          return next;
        });
      }
    })().catch((error: unknown) => {
      if (abort.signal.aborted) return;
      console.warn(`pdf ${name}:`, error);
      setProblem(pdfProblem(error));
    });
    return () => {
      abort.abort();
      void opened?.loadingTask.destroy();
    };
  }, [url, name]);

  // the width pages fit to: the view's, without its scrollbar
  useLayoutEffect(() => {
    const element = area.current;
    if (element === null) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // pages report themselves; the ones within half a screen of the view are drawn
  const intersections = useRef<IntersectionObserver | null>(null);
  const pages = useRef(new Set<HTMLElement>());
  const observe = useCallback((element: HTMLElement) => {
    pages.current.add(element);
    intersections.current?.observe(element);
    return () => {
      pages.current.delete(element);
      intersections.current?.unobserve(element);
    };
  }, []);
  useEffect(() => {
    const root = area.current;
    if (root === null || doc === null) return;
    const visible = new Set<number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const number = Number((entry.target as HTMLElement).dataset["page"]);
        if (entry.isIntersecting) visible.add(number); else visible.delete(number);
      }
      setNear(new Set(visible));
    }, { root, rootMargin: "50% 0px" });
    intersections.current = observer;
    for (const element of pages.current) observer.observe(element);
    return () => {
      observer.disconnect();
      intersections.current = null;
    };
  }, [doc]);

  // the page under the middle of the view, for the counter
  const frame = useRef(0);
  const onScroll = useCallback(() => {
    if (frame.current !== 0) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const root = area.current;
      const list = content.current?.children;
      if (!root || !list || list.length === 0) return;
      const middle = root.scrollTop + root.clientHeight / 2;
      let low = 0;
      let high = list.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if ((list[mid] as HTMLElement).offsetTop <= middle) low = mid; else high = mid - 1;
      }
      setCurrent(low + 1);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const zoomTo = useCallback((next: number, anchor?: ZoomAnchor) => {
    const root = area.current;
    const old = zoomNow.current;
    const target = clampZoom(next, MIN_ZOOM, MAX_ZOOM);
    if (root === null || Math.abs(target - old) < 1e-6) return;
    pendingScroll.current = { left: root.scrollLeft, top: root.scrollTop, anchor: anchor ?? { x: root.clientWidth / 2, y: root.clientHeight / 2 }, ratio: target / old };
    setZoom(target);
  }, []);
  // what was under the fingers (or the middle) stays there once the pages are laid out at the new zoom
  useLayoutEffect(() => {
    const root = area.current;
    const pending = pendingScroll.current;
    if (root === null || pending === null) return;
    pendingScroll.current = null;
    const { left, top } = anchoredScroll(pending.left, pending.top, pending.anchor, pending.ratio);
    root.scrollLeft = left;
    root.scrollTop = top;
  }, [zoom]);
  useZoomGestures(area, content, zoom, { min: MIN_ZOOM, max: MAX_ZOOM }, zoomTo);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") zoomTo(zoom * ZOOM_STEP);
    else if (event.key === "-") zoomTo(zoom / ZOOM_STEP);
    else if (event.key === "0") zoomTo(1);
    else return;
    event.preventDefault();
  };

  const available = Math.max(0, width - 2 * GAP);
  const message = problem === "password" ? t("This PDF is password protected. Download it to open it.")
    : problem === "damaged" ? t("This PDF is damaged and can't be shown.")
      : problem !== null ? t("The file could not be opened.") : null;

  return (
    <div className="pdf-view">
      <div ref={area} className="pdf-scroll" tabIndex={0} role="document" aria-label={name} aria-busy={doc === null && message === null} onScroll={onScroll} onKeyDown={onKeyDown}>
        {message !== null
          ? <p className="file-viewer-note" role="alert">{message}</p>
          : doc === null || available === 0
            ? <div className="pdf-loading">
                <p className="file-viewer-note">{t("Opening…")}</p>
                <div className="pdf-progress" aria-hidden="true"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
              </div>
            : <div ref={content} className="pdf-pages">
                {sizes.map((size, index) => (
                  <PdfPage key={index} doc={doc} number={index + 1} size={size} scale={Math.min(available / size.width, MAX_FIT_SCALE) * zoom}
                    near={near.has(index + 1)} observe={observe} label={t("Page {page}", { page: index + 1 })} />
                ))}
              </div>}
      </div>
      {doc !== null && message === null && (
        <div className="pdf-toolbar">
          <span className="pdf-page-count" aria-live="polite">{t("{page} of {pages}", { page: current, pages: sizes.length })}</span>
          <ZoomControls zoom={zoom} min={MIN_ZOOM} max={MAX_ZOOM} onZoom={(next) => zoomTo(next)} />
        </div>
      )}
    </div>
  );
}

interface PdfPageProps {
  doc: PDFDocumentProxy;
  number: number;
  size: PageSize;
  /** CSS px per PDF point */
  scale: number;
  /** near the view: drawn; else its drawing and text are let go of */
  near: boolean;
  observe: (element: HTMLElement) => () => void;
  label: string;
}

const PdfPage = memo(function PdfPage({ doc, number, size, scale, near, observe, label }: PdfPageProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  useEffect(() => (box.current === null ? undefined : observe(box.current)), [observe]);

  useEffect(() => {
    const target = canvas.current;
    if (target === null) return;
    if (!near) {
      target.width = 0;
      target.height = 0;
      return;
    }
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    void (async () => {
      const page = await doc.getPage(number);
      if (cancelled) return;
      let output = scale * (window.devicePixelRatio || 1);
      const pixels = size.width * size.height * output * output;
      if (pixels > MAX_CANVAS_PIXELS) output *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = page.getViewport({ scale: output });
      // drawn aside first: the page keeps its last drawing (stretched) until the new one is whole
      const drawing = document.createElement("canvas");
      drawing.width = Math.max(1, Math.floor(viewport.width));
      drawing.height = Math.max(1, Math.floor(viewport.height));
      const render = page.render({ canvas: drawing, viewport });
      task = render;
      await render.promise;
      if (cancelled) return;
      target.width = drawing.width;
      target.height = drawing.height;
      target.getContext("2d")?.drawImage(drawing, 0, 0);
      drawing.width = 0;
    })().catch((error: unknown) => {
      if (!cancelled && !(error instanceof Error && error.name === "RenderingCancelledException")) console.warn(`pdf page ${number}:`, error);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, number, near, scale, size.width, size.height]);

  useEffect(() => {
    const layer = text.current;
    if (layer === null || !near) return;
    const abort = new AbortController();
    void (async () => {
      const page = await doc.getPage(number);
      if (!abort.signal.aborted) await drawTextLayer(page, layer, abort.signal);
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) console.warn(`pdf text ${number}:`, error);
    });
    return () => {
      abort.abort();
      layer.replaceChildren();
    };
  }, [doc, number, near]);

  const style = {
    width: Math.floor(size.width * scale),
    height: Math.floor(size.height * scale),
    "--total-scale-factor": scale,
    "--scale-round-x": "1px",
    "--scale-round-y": "1px",
  } as CSSProperties;
  return (
    <div ref={box} className="pdf-page" data-page={number} style={style} role="group" aria-label={label}>
      <canvas ref={canvas} className="pdf-canvas" />
      <div ref={text} className="pdf-text" />
    </div>
  );
});
