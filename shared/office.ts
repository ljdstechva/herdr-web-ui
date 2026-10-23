import type { FileKind } from "./protocol.ts";

/**
 * Office files, told by their extension: the viewer shows a spreadsheet as its cells and the
 * others as the pages LibreOffice prints them to (server/file-preview.ts). By extension, because
 * an RTF is `text/rtf` and its markup shown as text is no preview of it.
 *
 * Shared because both sides tell them: the server in GET /api/fs/stat, and the viewer for a PC
 * whose server is from before these kinds and calls such a file `binary` (an RTF, `text`).
 */
const OFFICE_KINDS = new Map<string, FileKind>([
  ...["doc", "docx", "docm", "dot", "dotx", "odt", "rtf"].map((ext): [string, FileKind] => [ext, "document"]),
  ...["xls", "xlsx", "xlsm", "xlsb", "ods"].map((ext): [string, FileKind] => [ext, "spreadsheet"]),
  ...["ppt", "pptx", "pptm", "pps", "ppsx", "pot", "potx", "odp"].map((ext): [string, FileKind] => [ext, "presentation"]),
]);

/** The office kind a file name says, or null for any other file. */
export function officeKind(name: string): FileKind | null {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? null : OFFICE_KINDS.get(name.slice(dot + 1).toLowerCase()) ?? null;
}
