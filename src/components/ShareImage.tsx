import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Send } from "lucide-react";

import { useT, type Translate } from "../lib/i18n.ts";
import { asPng, deliverImage, imageFileFor, prefersShareSheet, saveFile, type ShareOutcome } from "../lib/shareImage.ts";

/** How long a word on the button stays before it reads Share again. */
const NOTE_MS = 6000;
/** How long a file read for a second tap waits for it. */
const READY_MS = 60_000;

type Shown = "idle" | "reading" | "failed" | ShareOutcome;

function noteOf(shown: Shown, t: Translate): string | null {
  switch (shown) {
    case "tap-again": return t("Ready, tap again to send");
    case "copied": return t("Copied. Paste it in Messenger");
    case "saved": return t("Saved. Attach it in Messenger");
    case "failed": return t("Couldn't share this image");
    default: return null;
  }
}

/**
 * Sends an image to Messenger or any other app as the picture itself: the phone's share sheet takes
 * the file, never a link (lib/shareImage.ts). `icon` is the viewer's header button; in the chat it is
 * a pill on the image.
 */
export function ShareImage({ url, path, icon = false }: { url: string; path: string; icon?: boolean }) {
  const t = useT();
  const [shown, setShown] = useState<Shown>("idle");
  // kept once read: a second tap must reach the sheet at once, with the tap still fresh
  const file = useRef<File | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = useRef(false);

  useEffect(() => { file.current = null; setShown("idle"); }, [url]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const send = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    clearTimeout(timer.current);
    let next: Shown;
    try {
      if (file.current === null) {
        setShown("reading");
        file.current = await imageFileFor(url, path);
      }
      next = await deliverImage(file.current, { navigator, sheet: prefersShareSheet(), toPng: asPng, save: saveFile });
    } catch (error) {
      console.warn("share image", error);
      next = "failed";
    }
    busy.current = false;
    // only a waiting second tap holds the file: the next send reads it again, a re-exported image included
    if (next !== "tap-again") file.current = null;
    if (next === "shared" || next === "cancelled") {
      setShown("idle");
      return;
    }
    setShown(next);
    timer.current = setTimeout(() => { file.current = null; setShown("idle"); }, next === "tap-again" ? READY_MS : NOTE_MS);
  }, [url, path]);

  const note = noteOf(shown, t);
  const glyph = shown === "reading"
    ? <LoaderCircle className="share-image-spin" aria-hidden="true" />
    : shown === "copied" || shown === "saved" ? <Check aria-hidden="true" /> : <Send aria-hidden="true" />;
  const label = t("Share image");
  if (icon) {
    return <span className="share-image-header">
      <button type="button" className="icon-button" aria-label={label} title={label} aria-busy={shown === "reading"} onClick={() => void send()}>{glyph}</button>
      {note !== null && <span className={`share-image-note${shown === "failed" ? " is-failed" : ""}`} role="status">{note}</span>}
    </span>;
  }
  return <button type="button" className={`share-image-pill${shown === "failed" ? " is-failed" : ""}${shown === "tap-again" ? " is-ready" : ""}`} aria-label={note ?? label} title={label} aria-busy={shown === "reading"} onClick={() => void send()}>
    {glyph}<span role="status">{note ?? t("Share")}</span>
  </button>;
}
