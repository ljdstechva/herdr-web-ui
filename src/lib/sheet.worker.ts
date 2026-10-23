import { read } from "xlsx";
import { GRID_LIMITS, workbookGrids } from "./sheets.ts";
import type { SheetGrid } from "./sheets.ts";

/**
 * A workbook's bytes in, its sheets as drawn out (lib/sheets.ts): parsing a large workbook takes
 * seconds on a phone, and here it takes them off the page's thread. One file per worker.
 */
export type SheetWorkerAnswer = { sheets: SheetGrid[] } | { error: "password" | "unreadable"; message: string };

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  let answer: SheetWorkerAnswer;
  try {
    const book = read(new Uint8Array(event.data), {
      type: "array",
      dense: true,
      // the column widths and row heights live with the styles
      cellStyles: true,
      cellFormula: false,
      cellHTML: false,
      // rows past what is drawn are not parsed; the sheet's full range still counts them
      sheetRows: GRID_LIMITS.maxRows + 1,
    });
    answer = { sheets: workbookGrids(book) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    answer = { error: /password|encrypt/i.test(message) ? "password" : "unreadable", message };
  }
  self.postMessage(answer);
};
