import { describe, expect, it } from "bun:test";
import { read, utils, write } from "xlsx";

import { columnName, GRID_LIMITS, rangeEnd, sheetGrid, workbookGrids } from "./sheets.ts";

/** A workbook written and read back as the viewer reads it (lib/sheet.worker.ts). */
function roundTrip(build: (book: ReturnType<typeof utils.book_new>) => void, rows = GRID_LIMITS.maxRows + 1) {
  const book = utils.book_new();
  build(book);
  const bytes = write(book, { type: "array", bookType: "xlsx", cellStyles: true });
  return read(new Uint8Array(bytes), { type: "array", dense: true, cellStyles: true, sheetRows: rows });
}

describe("sheets", () => {
  it("names columns as Excel does", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
    expect(rangeEnd("A1:C10")).toEqual({ row: 9, col: 2 });
    expect(rangeEnd("$B$2")).toEqual({ row: 1, col: 1 });
    expect(rangeEnd("nonsense")).toBeNull();
  });

  it("shows values as the file formats them, numbers to the right", () => {
    const book = roundTrip((book) => {
      const sheet = utils.aoa_to_sheet([["Parameter", "Result", "Limit", "Pass"], ["BOD", 32, 50, true], ["pH", 7.25, null, false]]);
      sheet["B3"]!.z = "0.0";
      sheet["C2"]!.z = "#,##0.00";
      utils.book_append_sheet(book, sheet, "Effluent");
    });
    const [grid] = workbookGrids(book);
    expect(grid!.name).toBe("Effluent");
    expect(grid!.cells[0]).toEqual([{ t: "Parameter" }, { t: "Result" }, { t: "Limit" }, { t: "Pass" }]);
    expect(grid!.cells[1]).toEqual([{ t: "BOD" }, { t: "32", a: "r" }, { t: "50.00", a: "r" }, { t: "TRUE", a: "c" }]);
    expect(grid!.cells[2]![1]).toEqual({ t: "7.3", a: "r" });
    expect(grid!.cells[2]![2]).toBeNull();
    expect([grid!.totalRows, grid!.totalCols]).toEqual([3, 4]);
  });

  it("merges, hides and sizes as the file says", () => {
    const book = roundTrip((book) => {
      const sheet = utils.aoa_to_sheet([["Title", null, null], ["a", "secret", "c"], ["d", "e", "f"]]);
      sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
      sheet["!cols"] = [{ wpx: 120 }, { hidden: true }, { wch: 10 }];
      sheet["!rows"] = [{ hpx: 30 }];
      utils.book_append_sheet(book, sheet, "Layout");
    });
    const grid = workbookGrids(book)[0]!;
    // the hidden column B is left out, so the title spans the two columns still shown
    expect(grid.cols).toEqual([0, 2]);
    expect(grid.cells[0]).toEqual([{ t: "Title", cs: 2 }, false]);
    expect(grid.cells[1]).toEqual([{ t: "a" }, { t: "c" }]);
    expect(grid.widths[0]).toBe(120);
    expect(grid.heights[0]).toBe(30);
    expect(grid.heights[1]).toBeNull();
  });

  it("draws the cells in use, not a range that runs on", () => {
    const book = roundTrip((book) => {
      const sheet = utils.aoa_to_sheet([["only"]]);
      sheet["!ref"] = "A1:Z500";
      utils.book_append_sheet(book, sheet, "Sparse");
    });
    const grid = workbookGrids(book)[0]!;
    expect(grid.rows).toEqual([0]);
    expect(grid.cols).toEqual([0]);
  });

  it("cuts a large sheet short and still counts all of it", () => {
    const book = roundTrip((book) => {
      const rows = Array.from({ length: 5_000 }, (_, r) => Array.from({ length: 30 }, (_, c) => r * 100 + c));
      utils.book_append_sheet(book, utils.aoa_to_sheet(rows), "Data");
    });
    const grid = workbookGrids(book)[0]!;
    expect(grid.cols.length).toBe(30);
    expect(grid.rows.length).toBe(Math.floor(GRID_LIMITS.maxCells / 30));
    expect(grid.totalRows).toBe(5_000);
    expect(grid.cells[1]![2]).toEqual({ t: "102", a: "r" });
  });

  it("leaves out hidden sheets unless all are hidden", () => {
    const book = roundTrip((book) => {
      utils.book_append_sheet(book, utils.aoa_to_sheet([[1]]), "Shown");
      utils.book_append_sheet(book, utils.aoa_to_sheet([[2]]), "Hidden");
      book.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
    });
    expect(workbookGrids(book).map((grid) => grid.name)).toEqual(["Shown"]);
    const sheet = utils.aoa_to_sheet([["x"]]);
    expect(sheetGrid("Plain", sheet).cells).toEqual([[{ t: "x" }]]);
  });

  it("reads a CSV and an OpenDocument sheet the same way", () => {
    const csv = read("a,b\n1,2\n", { type: "string", dense: true });
    expect(workbookGrids(csv)[0]!.cells).toEqual([[{ t: "a" }, { t: "b" }], [{ t: "1", a: "r" }, { t: "2", a: "r" }]]);
    const ods = roundTrip((book) => utils.book_append_sheet(book, utils.aoa_to_sheet([["x", 1]]), "S"));
    const bytes = write(ods, { type: "array", bookType: "ods" });
    expect(workbookGrids(read(new Uint8Array(bytes), { type: "array", dense: true }))[0]!.cells[0]).toEqual([{ t: "x" }, { t: "1", a: "r" }]);
  });
});
