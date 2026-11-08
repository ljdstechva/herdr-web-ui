import { describe, expect, it } from "bun:test";
import { pasteContent, pastedFiles, takesPasteItself } from "./strayPaste.ts";

const file = (name: string, type = "image/png"): File => new File(["x"], name, { type });
const clipboard = (data: Record<string, string>, files: File[] = []) => ({
  getData: (format: string) => data[format] ?? "",
  files,
  items: files.map((one) => ({ kind: "file", getAsFile: () => one })),
});

describe("takesPasteItself", () => {
  it("leaves a paste to a text field", () => {
    expect(takesPasteItself({ tagName: "TEXTAREA" })).toBe(true);
    expect(takesPasteItself({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(takesPasteItself({ tagName: "INPUT", type: "" })).toBe(true);
    expect(takesPasteItself({ tagName: "INPUT", type: "Search" })).toBe(true);
    expect(takesPasteItself({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });
  it("takes it where no field would: the chat, a button, the body", () => {
    expect(takesPasteItself({ tagName: "DIV" })).toBe(false);
    expect(takesPasteItself({ tagName: "BUTTON" })).toBe(false);
    expect(takesPasteItself({ tagName: "BODY" })).toBe(false);
    expect(takesPasteItself({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(takesPasteItself(null)).toBe(false);
  });
});

describe("pasteContent", () => {
  it("is the text of a text paste", () => {
    expect(pasteContent(clipboard({ "text/plain": "hello" }))).toEqual({ text: "hello" });
  });
  it("is the text when Office puts a picture of it beside it", () => {
    expect(pasteContent(clipboard({ "text/plain": "a\tb\n1\t2", "text/html": "<table>" }, [file("image.png")]))).toEqual({ text: "a\tb\n1\t2" });
  });
  it("is the files of a picture-only paste (a screenshot)", () => {
    const shot = file("image.png");
    expect(pasteContent(clipboard({}, [shot]))).toEqual({ files: [shot] });
  });
  it("is nothing for an empty clipboard", () => {
    expect(pasteContent(clipboard({}))).toBeNull();
    expect(pasteContent(null)).toBeNull();
  });
});

describe("pastedFiles", () => {
  it("reads files when the browser gives no items", () => {
    const one = file("a.pdf", "application/pdf");
    expect(pastedFiles({ getData: () => "", files: [one], items: [] })).toEqual([one]);
  });
});
