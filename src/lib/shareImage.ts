/**
 * Sending a chat image to Messenger (or any app) as the picture itself, never as a link. A web page
 * cannot name the app it hands a file to, nor send without the person: the phone's share sheet is
 * where Messenger and its recent chats are picked. On a computer, where that sheet rarely lists it,
 * the image goes to the clipboard for a paste into messenger.com.
 */

/** What Messenger takes as a photo. Anything else is redrawn as a PNG first, as it might arrive as a file or not at all. */
const SENDS_AS_IT_IS = new Set(["image/jpeg", "image/png", "image/gif"]);
const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif" };

/** How the image left, or why it has not yet. */
export type ShareOutcome =
  /** the share sheet took it */
  | "shared"
  /** the person closed the sheet: nothing to say */
  | "cancelled"
  /** the browser wants a fresh tap (reading a big file outlasted the first one) */
  | "tap-again"
  /** on the clipboard, to paste */
  | "copied"
  /** saved to the device, where neither a sheet nor the clipboard is there */
  | "saved";

/** The name the file arrives under: its own, in plain characters, with the extension its type has. */
export function shareFileName(path: string, type: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const stem = name.replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  return `${stem === "" ? "image" : stem}.${EXTENSIONS[type] ?? "png"}`;
}

/** The picture redrawn as a PNG, at its own size (an SVG with no size of its own gets this one). */
const SVG_SIZE = 1600;
export async function asPng(blob: Blob): Promise<Blob> {
  const address = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = address;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || SVG_SIZE;
    canvas.height = image.naturalHeight || SVG_SIZE;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no canvas to draw on");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((png) => { if (png === null) reject(new Error("the image could not be redrawn")); else resolve(png); }, "image/png"));
  } finally {
    URL.revokeObjectURL(address);
  }
}

/** The image as a file an app takes as a photo. Fails with a reason when it cannot be read. */
export async function imageFileFor(url: string, path: string, redraw: (blob: Blob) => Promise<Blob> = asPng): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the image could not be read (${response.status})`);
  const blob = await response.blob();
  const type = blob.type.split(";")[0]!.trim().toLowerCase();
  if (SENDS_AS_IT_IS.has(type)) return new File([blob], shareFileName(path, type), { type });
  if (!type.startsWith("image/")) throw new Error(`this file is not an image (${type || "no type"})`);
  return new File([await redraw(blob)], shareFileName(path, "image/png"), { type: "image/png" });
}

/** A finger's device shares through its sheet; a mouse's goes to the clipboard, ready to paste. */
export function prefersShareSheet(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

interface ShareNavigator {
  share?: (data: { files: File[] }) => Promise<void>;
  canShare?: (data: { files: File[] }) => boolean;
  userActivation?: { isActive: boolean };
  clipboard?: { write?: (items: ClipboardItem[]) => Promise<void> };
}

export interface ShareDevice {
  navigator: ShareNavigator;
  sheet: boolean;
  /** an image on the clipboard must be a PNG */
  toPng: (blob: Blob) => Promise<Blob>;
  save: (file: File) => void;
}

/** The browser's own save of a file already read. */
export function saveFile(file: File): void {
  const address = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = address;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(address), 60_000);
}

const isNamed = (error: unknown, name: string): boolean => error instanceof Error && error.name === name || (error as { name?: unknown } | null)?.name === name;

/**
 * Sends the file on. The share carries `files` and nothing else: with a title, text or address beside
 * the file, an app may send those instead of the picture or as a second message.
 */
export async function deliverImage(file: File, device: ShareDevice): Promise<ShareOutcome> {
  const { navigator: nav } = device;
  const payload = { files: [file] };
  if (device.sheet && typeof nav.share === "function" && (nav.canShare?.(payload) ?? false)) {
    // reading the file used up the tap: the file is kept, and the next tap sends it at once
    if (nav.userActivation?.isActive === false) return "tap-again";
    try {
      await nav.share(payload);
      return "shared";
    } catch (error) {
      if (isNamed(error, "AbortError")) return "cancelled";
      if (isNamed(error, "NotAllowedError")) return "tap-again";
      throw error;
    }
  }
  if (typeof nav.clipboard?.write === "function" && typeof ClipboardItem === "function") {
    try {
      const png = file.type === "image/png" ? file : await device.toPng(file);
      await nav.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return "copied";
    } catch { /* a page out of focus, or a clipboard refused: the file can still be saved */ }
  }
  device.save(file);
  return "saved";
}
