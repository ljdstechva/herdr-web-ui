/**
 * Ctrl+V with the focus outside any text field. On a desktop the focus leaves the composer
 * as soon as the chat is clicked (to read, to select, a Copy button, the sidebar): the
 * browser still fires `paste`, but at the chat or the body, where nothing takes it, and the
 * paste was lost in silence. The current pane takes such a stray paste: the chat's composer
 * in chat view, the terminal in terminal view (components/PaneTerminal.tsx).
 *
 * A clipboard with text and a picture (Word, Excel, Outlook and OneNote put a picture of the
 * copied cells or lines beside their text) pastes its text: a file is taken only when the
 * clipboard holds no text, as the terminal already did.
 */

interface ElementLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "password", "tel", "number"]);

/** A field that takes a paste itself: an input box, a textarea (xterm's own included), editable text. */
export function takesPasteItself(target: EventTarget | ElementLike | null | undefined): boolean {
  if (target === null || target === undefined || typeof target !== "object" || !("tagName" in target)) return false;
  const element = target as ElementLike;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") return TEXT_INPUT_TYPES.has((element.type ?? "").toLowerCase());
  return false;
}

export interface ClipboardLike {
  getData: (format: string) => string;
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile: () => File | null }> | null;
}

/** What a paste brings: its text, else its files. Text wins over a picture of the same text. */
export function pasteContent(data: ClipboardLike | null | undefined): { text: string } | { files: File[] } | null {
  if (!data) return null;
  const text = data.getData("text/plain");
  if (text) return { text };
  const files = pastedFiles(data);
  return files.length > 0 ? { files } : null;
}

/** The files of a paste: from `items` where the browser has them (a pasted screenshot), else `files`. */
export function pastedFiles(data: ClipboardLike): File[] {
  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return fromItems.length > 0 ? fromItems : Array.from(data.files ?? []);
}
