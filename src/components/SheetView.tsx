import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import "./SheetView.css";
import { ZoomControls } from "./ZoomControls.tsx";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { useT } from "../lib/i18n.ts";
import type { SheetWorkerAnswer } from "../lib/sheet.worker.ts";
import { columnName, type SheetGrid } from "../lib/sheets.ts";
import { anchoredScroll, clampZoom, useZoomGestures, ZOOM_STEP, type ZoomAnchor } from "../lib/zoomGestures.ts";

/** Larger workbooks are offered as a download: the phone reads one whole before it draws a cell. */
export const MAX_SHEET_BYTES = 40 * 1024 * 1024;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;
/** The row numbers' column, and a row with no height of its own, in CSS px at zoom 1. */
const HEADER_WIDTH = 44;
const ROW_HEIGHT = 22;

export interface SheetViewProps {
  url: string;
  name: string;
  size: number;
}

type Loaded = { sheets: SheetGrid[] } | { problem: "password" | "unreadable" | "too_large" | "unreachable" };

/**
 * A spreadsheet's cells, read in the browser (lib/sheet.worker.ts): column letters and row
 * numbers stay in view, each visible sheet has its tab, and a tapped cell shows its whole text.
 */
export default function SheetView({ url, name, size }: SheetViewProps) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [active, setActive] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  const pendingScroll = useRef<{ left: number; top: number; anchor: ZoomAnchor; ratio: number } | null>(null);

  useEffect(() => {
    setLoaded(null); setActive(0); setSelected(null); setZoom(1);
    if (size > MAX_SHEET_BYTES) { setLoaded({ problem: "too_large" }); return; }
    const abort = new AbortController();
    let worker: Worker | null = null;
    void (async () => {
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error(`${response.status}`);
      const bytes = await response.arrayBuffer();
      if (abort.signal.aborted) return;
      const reader = new Worker(new URL("../lib/sheet.worker.ts", import.meta.url), { type: "module" });
      worker = reader;
      const answer = await new Promise<SheetWorkerAnswer>((resolve, reject) => {
        reader.onmessage = (event: MessageEvent<SheetWorkerAnswer>) => resolve(event.data);
        reader.onerror = (event) => { event.preventDefault(); reject(new Error(event.message || "the sheet reader failed")); };
        reader.postMessage(bytes, [bytes]);
      });
      if (abort.signal.aborted) return;
      setLoaded("sheets" in answer ? { sheets: answer.sheets } : { problem: answer.error });
    })().catch((error: unknown) => {
      if (abort.signal.aborted) return;
      console.warn(`sheet ${name}:`, error);
      setLoaded({ problem: "unreachable" });
    }).finally(() => worker?.terminate());
    return () => { abort.abort(); worker?.terminate(); };
  }, [url, name, size]);

  const grid = loaded !== null && "sheets" in loaded ? loaded.sheets[active] ?? null : null;

  const zoomTo = useCallback((next: number, anchor?: ZoomAnchor) => {
    const root = area.current;
    const old = zoomNow.current;
    const target = clampZoom(next, MIN_ZOOM, MAX_ZOOM);
    if (root === null || Math.abs(target - old) < 1e-6) return;
    pendingScroll.current = { left: root.scrollLeft, top: root.scrollTop, anchor: anchor ?? { x: root.clientWidth / 2, y: root.clientHeight / 2 }, ratio: target / old };
    setZoom(target);
  }, []);
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

  // another sheet starts at its top-left corner, nothing chosen in it
  const showSheet = (index: number) => {
    setActive(index);
    setSelected(null);
    area.current?.scrollTo({ left: 0, top: 0 });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") zoomTo(zoom * ZOOM_STEP);
    else if (event.key === "-") zoomTo(zoom / ZOOM_STEP);
    else if (event.key === "0") zoomTo(1);
    else return;
    event.preventDefault();
  };

  // the tapped cell is marked in place: drawing the table again for it would lay out every cell
  const marked = useRef<HTMLElement | null>(null);
  const onPick = useCallback((event: MouseEvent<HTMLTableElement>) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>("td[data-col]");
    if (cell === null) return;
    marked.current?.classList.remove("is-selected");
    cell.classList.add("is-selected");
    marked.current = cell;
    setSelected({ row: Number(cell.parentElement?.dataset["row"]), col: Number(cell.dataset["col"]) });
  }, []);
  useEffect(() => { marked.current?.classList.remove("is-selected"); marked.current = null; }, [grid]);

  const table = useMemo(() => grid === null ? null : <GridTable grid={grid} zoom={zoom} onPick={onPick} />, [grid, zoom, onPick]);

  const picked = grid !== null && selected !== null ? grid.cells[selected.row]?.[selected.col] : null;
  const pickedName = grid !== null && selected !== null ? `${columnName(grid.cols[selected.col] ?? 0)}${(grid.rows[selected.row] ?? 0) + 1}` : "";
  const cut = grid !== null && ((grid.rows[grid.rows.length - 1] ?? -1) + 1 < grid.totalRows || (grid.cols[grid.cols.length - 1] ?? -1) + 1 < grid.totalCols);

  const message = loaded === null ? null
    : "problem" in loaded
      ? loaded.problem === "password" ? t("This workbook is password protected. Download it to open it.")
        : loaded.problem === "too_large" ? t("This workbook is {size}; download it to view.", { size: formatBytes(size) })
          : loaded.problem === "unreadable" ? t("This workbook could not be read. It may be damaged.")
            : t("The file could not be opened.")
      : grid === null || grid.rows.length === 0 ? t("This sheet is empty.") : null;

  return (
    <div className="sheet-view">
      <div ref={area} className="sheet-scroll" tabIndex={0} aria-label={name} aria-busy={loaded === null} onKeyDown={onKeyDown}>
        {loaded === null
          ? <p className="file-viewer-note">{t("Opening…")}</p>
          : message !== null
            ? <p className="file-viewer-note" role={"problem" in loaded ? "alert" : undefined}>{message}</p>
            : <div ref={content} className="sheet-content">{table}</div>}
      </div>
      {grid !== null && (
        <div className="sheet-bar">
          {cut && <p className="sheet-cut">{t("Showing the first {rows} rows and {columns} columns. Download the file to see all of it.", { rows: grid.rows.length, columns: grid.cols.length })}</p>}
          {selected !== null && picked !== undefined && (
            <p className="sheet-cell" aria-live="polite">
              <span className="sheet-cell-name">{pickedName}</span>
              <span className="sheet-cell-text">{picked ? picked.t : ""}</span>
            </p>
          )}
          <div className="sheet-bar-row">
            {loaded !== null && "sheets" in loaded && loaded.sheets.length > 1
              ? <div className="sheet-tabs" role="tablist" aria-label={t("Sheets")}>
                  {loaded.sheets.map((sheet, index) => (
                    <button key={`${index}-${sheet.name}`} type="button" role="tab" aria-selected={index === active} className="sheet-tab" onClick={() => showSheet(index)}>{sheet.name}</button>
                  ))}
                </div>
              : <span className="sheet-name">{grid.name}</span>}
            <ZoomControls zoom={zoom} min={MIN_ZOOM} max={MAX_ZOOM} onZoom={(next) => zoomTo(next)} />
          </div>
        </div>
      )}
    </div>
  );
}

/** The table: built again only for another sheet or zoom, not for a tapped cell. */
function GridTable({ grid, zoom, onPick }: { grid: SheetGrid; zoom: number; onPick: (event: MouseEvent<HTMLTableElement>) => void }) {
  const width = HEADER_WIDTH * zoom + grid.widths.reduce((sum, w) => sum + w * zoom, 0);
  const style = { "--sheet-zoom": zoom, width } as CSSProperties;
  return (
    <table className="sheet-grid" style={style} onClick={onPick}>
      <colgroup>
        <col style={{ width: HEADER_WIDTH * zoom }} />
        {grid.widths.map((w, index) => <col key={index} style={{ width: w * zoom }} />)}
      </colgroup>
      <thead>
        <tr style={{ height: ROW_HEIGHT * zoom }}>
          <th className="sheet-corner" aria-hidden="true" />
          {grid.cols.map((col) => <th key={col} scope="col">{columnName(col)}</th>)}
        </tr>
      </thead>
      <tbody>
        {grid.cells.map((cells, r) => (
          <tr key={grid.rows[r]} data-row={r} style={{ height: (grid.heights[r] ?? ROW_HEIGHT) * zoom }}>
            <th scope="row">{grid.rows[r]! + 1}</th>
            {cells.map((cell, c) => cell === false ? null : (
              <td key={c} data-col={c} rowSpan={cell?.rs} colSpan={cell?.cs} className={cell?.a === "r" ? "is-number" : cell?.a === "c" ? "is-centered" : undefined}>
                {cell?.t}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
