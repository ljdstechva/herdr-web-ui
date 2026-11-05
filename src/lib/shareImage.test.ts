import { afterEach, describe, expect, it } from "bun:test";
import { deliverImage, imageFileFor, shareFileName, type ShareDevice } from "./shareImage.ts";

const photo = new File(["x"], "a.jpg", { type: "image/jpeg" });
const named = (name: string): Error => Object.assign(new Error(name), { name });

function device(over: Partial<ShareDevice> & { share?: (data: { files: File[] }) => Promise<void>; active?: boolean; canShare?: boolean } = {}): ShareDevice & { saved: File[] } {
  const saved: File[] = [];
  return {
    navigator: {
      ...(over.share ? { share: over.share, canShare: () => over.canShare ?? true } : {}),
      ...(over.active === undefined ? {} : { userActivation: { isActive: over.active } }),
    },
    sheet: over.sheet ?? true,
    toPng: over.toPng ?? (async (blob) => blob),
    save: over.save ?? ((file) => { saved.push(file); }),
    saved,
  };
}

describe("sending an image on", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("gives the sheet the file and nothing else, so an app sends the picture and no link", async () => {
    const seen: unknown[] = [];
    const outcome = await deliverImage(photo, device({ share: async (data) => { seen.push(data); }, active: true }));
    expect(outcome).toBe("shared");
    expect(seen).toEqual([{ files: [photo] }]);
    expect(Object.keys(seen[0] as object)).toEqual(["files"]);
  });

  it("asks for another tap when reading the file used up the first one, without calling the sheet", async () => {
    let calls = 0;
    expect(await deliverImage(photo, device({ share: async () => { calls += 1; }, active: false }))).toBe("tap-again");
    expect(calls).toBe(0);
    // a browser with no userActivation refuses in the share call itself
    expect(await deliverImage(photo, device({ share: async () => { throw named("NotAllowedError"); } }))).toBe("tap-again");
  });

  it("says nothing when the person closes the sheet, and surfaces any other failure", async () => {
    expect(await deliverImage(photo, device({ share: async () => { throw named("AbortError"); } }))).toBe("cancelled");
    await expect(deliverImage(photo, device({ share: async () => { throw named("DataError"); } }))).rejects.toThrow("DataError");
  });

  it("saves the file where there is no way to share or copy it", async () => {
    const target = device({ share: async () => { throw new Error("not this way"); }, canShare: false });
    expect(await deliverImage(photo, target)).toBe("saved");
    expect(target.saved).toEqual([photo]);
    const mouse = device({ share: async () => { throw new Error("not this way"); }, sheet: false });
    expect(await deliverImage(photo, mouse)).toBe("saved");
  });

  it("copies a PNG to the clipboard for a mouse's paste", async () => {
    const realItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    class Item { constructor(public items: Record<string, Blob>) {} }
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = Item;
    try {
      const written: Item[] = [];
      const png = new Blob(["p"], { type: "image/png" });
      const target = device({ sheet: false, toPng: async () => png });
      target.navigator.clipboard = { write: async (items) => { written.push(...(items as unknown as Item[])); } };
      expect(await deliverImage(photo, target)).toBe("copied");
      expect(written[0]!.items["image/png"]).toBe(png);
      // a refused clipboard still leaves the file
      target.navigator.clipboard = { write: async () => { throw named("NotAllowedError"); } };
      expect(await deliverImage(photo, target)).toBe("saved");
    } finally {
      if (realItem === undefined) delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
      else (globalThis as { ClipboardItem?: unknown }).ClipboardItem = realItem;
    }
  });

  it("names the file plainly, by the type it has", () => {
    expect(shareFileName("/opt/work/03 Social/final shot (1).JPG", "image/jpeg")).toBe("final-shot-1.jpg");
    expect(shareFileName("/tmp/logo.svg", "image/png")).toBe("logo.png");
    expect(shareFileName("/tmp/.jpg", "image/jpeg")).toBe("image.jpg");
    expect(shareFileName("C:\\x\\café.png", "image/png")).toBe("café.png");
  });

  it("reads the image, redraws what Messenger may not take, and fails out loud", async () => {
    const answer = (type: string, status = 200) => { globalThis.fetch = (async () => new Response(new Blob(["x"], { type }), { status })) as unknown as typeof fetch; };
    answer("image/jpeg");
    let redrawn = 0;
    const redraw = async () => { redrawn += 1; return new Blob(["p"], { type: "image/png" }); };
    const jpeg = await imageFileFor("/f", "/w/a b.jpeg", redraw);
    expect([jpeg.name, jpeg.type, redrawn]).toEqual(["a-b.jpg", "image/jpeg", 0]);
    answer("image/webp");
    const webp = await imageFileFor("/f", "/w/c.webp", redraw);
    expect([webp.name, webp.type, redrawn]).toEqual(["c.png", "image/png", 1]);
    answer("image/jpeg", 404);
    await expect(imageFileFor("/f", "/w/gone.jpg", redraw)).rejects.toThrow("404");
    answer("text/plain");
    await expect(imageFileFor("/f", "/w/note.jpg", redraw)).rejects.toThrow("not an image");
  });
});
