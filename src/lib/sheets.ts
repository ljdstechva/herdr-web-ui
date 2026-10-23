import type { CellObject, WorkBook, WorkSheet } from "xlsx";

/**
 * A spreadsheet as the viewer draws it: each visible sheet's cells as the file shows them (its
 * own number and date formats, read by SheetJS in lib/sheet.worker.ts), with the column widths,
 * row heights and merged cells the file sets. Pure, so the worker and the tests share it.
 */

/**
 * A cell: its text as displayed and how it lines up (`r` right for numbers and dates, `c` centred
 * for TRUE/FALSE and errors, else left); `rs`/`cs` when it is the corner of merged cells. `null`
 * is empty, `false` is covered by a merged cell to its upper left.
 */
export type GridCell = { t: string; a?: "r" | "c"; rs?: number; cs?: number } | null | false;

export interface SheetGrid {
  name: string;
  /** the sheet's row index (0-based) of each row shown, hidden rows left out */
  rows: number[];
  /** the sheet's column index (0-based) of each column shown */
  cols: number[];
  /** [shown row][shown column] */
  cells: GridCell[][];
  /** CSS px of each shown column */
  widths: number[];
  /** CSS px of each shown row, or null for the default height */
  heights: (number | null)[];
  /** rows and columns the sheet has in use, hidden ones included: more than shown when it was cut short */
  totalRows: number;
  totalCols: number;
}

/** What is drawn of one sheet: a phone lays out a table of tens of thousands of cells slowly. */
export const GRID_LIMITS = { maxRows: 2_000, maxCols: 80, maxCells: 40_000 };

/** Excel's default column: 8.43 characters, 64 px. */
const DEFAULT_WIDTH = 64;
const MIN_WIDTH = 12;
const MAX_WIDTH = 480;

/** `A`, `B`, … `Z`, `AA`: a column's letters from its 0-based index. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** `A1:C10` (or `C10` alone) as 0-based last row and column; null when it does not read as one. */
export function rangeEnd(ref: string | undefined): { row: number; col: number } | null {
  const match = ref?.match(/^\$?[A-Z]+\$?\d+(?::\$?([A-Z]+)\$?(\d+))?$/i) ?? null;
  if (match === null) return null;
  const end = match[1] !== undefined ? `${match[1]}${match[2]}` : ref!;
  const cell = end.replace(/\$/g, "").match(/^([A-Z]+)(\d+)$/i)!;
  let col = 0;
  for (const letter of cell[1]!.toUpperCase()) col = col * 26 + (letter.charCodeAt(0) - 64);
  return { row: Number(cell[2]) - 1, col: col - 1 };
}

function cellAt(sheet: WorkSheet, row: number, col: number): CellObject | undefined {
  const dense = sheet["!data"] as CellObject[][] | undefined;
  if (dense !== undefined) return dense[row]?.[col];
  return sheet[`${columnName(col)}${row + 1}`] as CellObject | undefined;
}

function cellText(cell: CellObject | undefined): GridCell {
  if (cell === undefined || cell.t === "z") return null;
  const text = cell.w ?? (cell.t === "b" ? (cell.v ? "TRUE" : "FALSE") : cell.v instanceof Date ? cell.v.toISOString().slice(0, 10) : cell.v === undefined ? "" : String(cell.v));
  if (text === "") return null;
  if (cell.t === "n" || cell.t === "d") return { t: text, a: "r" };
  if (cell.t === "b" || cell.t === "e") return { t: text, a: "c" };
  return { t: text };
}

/** Where the cells in use end: a sheet's `!ref` may run to a whole column a format was applied to. */
function usedEnd(sheet: WorkSheet, limit: { row: number; col: number }): { row: number; col: number } {
  let row = -1;
  let col = -1;
  const take = (r: number, c: number) => { if (r > row) row = r; if (c > col) col = c; };
  const dense = sheet["!data"] as CellObject[][] | undefined;
  if (dense !== undefined) {
    for (let r = Math.min(dense.length - 1, limit.row); r >= 0; r -= 1) {
      const cells = dense[r];
      if (!cells) continue;
      for (let c = Math.min(cells.length - 1, limit.col); c >= 0; c -= 1) if (cellText(cells[c]) !== null) { take(r, c); break; }
    }
  } else {
    for (const key of Object.keys(sheet)) {
      if (key.startsWith("!")) continue;
      const at = rangeEnd(key);
      if (at !== null && at.row <= limit.row && at.col <= limit.col && cellText(sheet[key] as CellObject) !== null) take(at.row, at.col);
    }
  }
  for (const merge of sheet["!merges"] ?? []) if (merge.s.r <= limit.row && merge.s.c <= limit.col) take(Math.min(merge.e.r, limit.row), Math.min(merge.e.c, limit.col));
  return { row, col };
}

function columnWidth(sheet: WorkSheet, col: number): number {
  const info = sheet["!cols"]?.[col];
  const px = info?.wpx ?? (info?.wch !== undefined ? info.wch * 7 + 5 : info?.width !== undefined ? info.width * 7 + 5 : DEFAULT_WIDTH);
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px)));
}

/** One sheet as drawn, cut to `limits`. `fullRef` is the range SheetJS read before `sheetRows` cut it. */
export function sheetGrid(name: string, sheet: WorkSheet, limits = GRID_LIMITS): SheetGrid {
  const full = rangeEnd((sheet["!fullref"] as string | undefined) ?? sheet["!ref"]);
  const read = rangeEnd(sheet["!ref"]);
  const end = read === null ? { row: -1, col: -1 } : usedEnd(sheet, read);
  // a sheet cut short by `sheetRows` has rows past what was read: the full range counts them
  const totalRows = Math.max(end.row + 1, full !== null && full.row > (read?.row ?? -1) ? full.row + 1 : 0);
  const totalCols = end.col + 1;
  const hiddenRow = (r: number) => sheet["!rows"]?.[r]?.hidden === true;
  const hiddenCol = (c: number) => sheet["!cols"]?.[c]?.hidden === true;
  const cols: number[] = [];
  for (let c = 0; c <= end.col && cols.length < limits.maxCols; c += 1) if (!hiddenCol(c)) cols.push(c);
  const maxRows = Math.min(limits.maxRows, Math.max(1, Math.floor(limits.maxCells / Math.max(1, cols.length))));
  const rows: number[] = [];
  for (let r = 0; r <= end.row && rows.length < maxRows; r += 1) if (!hiddenRow(r)) rows.push(r);

  const cells: GridCell[][] = rows.map((r) => cols.map((c) => cellText(cellAt(sheet, r, c))));
  // merged cells: the corner spans the shown rows and columns inside the merge, the rest is covered
  const rowAt = new Map(rows.map((r, index) => [r, index]));
  const colAt = new Map(cols.map((c, index) => [c, index]));
  for (const merge of sheet["!merges"] ?? []) {
    const shownRows = rows.filter((r) => r >= merge.s.r && r <= merge.e.r);
    const shownCols = cols.filter((c) => c >= merge.s.c && c <= merge.e.c);
    if (shownRows.length === 0 || shownCols.length === 0) continue;
    const top = rowAt.get(shownRows[0]!)!;
    const left = colAt.get(shownCols[0]!)!;
    // the merge's value is its own top-left cell's, which may be a hidden row or column
    const corner = cellText(cellAt(sheet, merge.s.r, merge.s.c));
    for (let r = 0; r < shownRows.length; r += 1) for (let c = 0; c < shownCols.length; c += 1) cells[top + r]![left + c] = false;
    if (shownRows.length === 1 && shownCols.length === 1) { cells[top]![left] = corner; continue; }
    cells[top]![left] = { ...(corner || { t: "" }), ...(shownRows.length > 1 ? { rs: shownRows.length } : {}), ...(shownCols.length > 1 ? { cs: shownCols.length } : {}) };
  }

  const heights = rows.map((r) => {
    const info = sheet["!rows"]?.[r];
    const px = info?.hpx ?? (info?.hpt !== undefined ? info.hpt * 4 / 3 : undefined);
    return px === undefined ? null : Math.round(Math.min(400, Math.max(8, px)));
  });
  return { name, rows, cols, cells, widths: cols.map((c) => columnWidth(sheet, c)), heights, totalRows, totalCols };
}

/**
 * The workbook's sheets as drawn, in its order. Hidden sheets are left out, as Excel leaves out
 * their tabs, unless every sheet is hidden.
 */
export function workbookGrids(book: WorkBook, limits = GRID_LIMITS): SheetGrid[] {
  const visible = book.SheetNames.filter((_, index) => !book.Workbook?.Sheets?.[index]?.Hidden);
  return (visible.length > 0 ? visible : book.SheetNames).map((name) => sheetGrid(name, book.Sheets[name]!, limits));
}
