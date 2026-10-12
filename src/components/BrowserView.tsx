import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Globe, Keyboard, Monitor, Smartphone, X } from "lucide-react";
import type RFB from "@novnc/novnc";

import "./BrowserView.css";

import { MIN_PHONE_SIZE, type BrowserInfo, type BrowserLayout } from "../../shared/browser-view.ts";
import {
  browserStreamUrl,
  BUTTON_MASK,
  HOLD_MS,
  KEYBOARD_FILL,
  NAMED_KEYS,
  setBrowserLayout,
  TouchGestures,
  typedKeysyms,
  useBrowsers,
  wheelMasks,
} from "../lib/browserView.ts";
import { useT } from "../lib/i18n.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { usePageVisible } from "../lib/visibility.ts";

/** the app's own phone breakpoint (the sidebar is a drawer below it) */
const PHONE_QUERY = "(max-width: 768px)";
/** a screen area that keeps changing (a keyboard sliding in) is measured once it rests */
const MEASURE_REST_MS = 250;
const RETRY_MS = [1000, 2000, 5000] as const;

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The sidebar's way into the browsers open on the server: an icon that is only there while one
 * is open, and the view it opens (components/BrowserView.tsx owns both).
 */
export function BrowserViewButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { browsers, unavailable, refresh } = useBrowsers(open);
  if (unavailable || (!browsers.length && !open)) return null;
  return <>
    <button type="button" className="icon-button browser-view-open" aria-label={t("Open the server's browser")} title={t("Open the server's browser")} onClick={() => setOpen(true)}><Globe aria-hidden="true" /></button>
    {open && createPortal(<BrowserViewer browsers={browsers} refresh={refresh} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

type Phase = "connecting" | "connected" | "lost";

function BrowserViewer({ browsers, refresh, onClose }: { browsers: BrowserInfo[]; refresh(): void; onClose(): void }) {
  const t = useT();
  const narrow = useMediaQuery(PHONE_QUERY);
  const touch = useMediaQuery("(pointer: coarse)");
  const visible = usePageVisible();
  const [selectedId, setSelectedId] = useState<string | null>(browsers[0]?.id ?? null);
  const browser = browsers.find((entry) => entry.id === selectedId) ?? browsers[0] ?? null;
  const id = browser?.id ?? null;
  // what this device asks for: its own shape as it opens, then what its button says. `turn`
  // makes a second press of the same answer a new request (another device changed it since).
  const [want, setWant] = useState<{ layout: BrowserLayout; turn: number }>(() => ({ layout: narrow ? "phone" : "desktop", turn: 0 }));
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  /** the browser whose layout was asked for at least once: its stream opens after that, not on the wrong shape */
  const [laidOut, setLaidOut] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [typing, setTyping] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const rfb = useRef<RFB | null>(null);
  const failures = useRef(0);
  /** what the phone keyboard's text was when its last change was sent */
  const sent = useRef(KEYBOARD_FILL);
  const serverLayout = useRef<BrowserLayout | null>(null);
  serverLayout.current = browser?.layout ?? null;

  const layout: BrowserLayout = want.layout === "phone" && browser?.phone_layout !== false ? "phone" : "desktop";

  // a phone turned on its side crosses the breakpoint: the layout follows the device again
  const firstShape = useRef(true);
  useEffect(() => {
    if (firstShape.current) { firstShape.current = false; return; }
    setWant((current) => ({ layout: narrow ? "phone" : "desktop", turn: current.turn + 1 }));
  }, [narrow]);

  // the focus goes back to the sidebar's icon when the view closes
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    surface.current?.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    const target = screen.current;
    if (!target) return;
    let timer: number | undefined;
    const measure = (): void => {
      const width = Math.round(target.clientWidth);
      const height = Math.round(target.clientHeight);
      if (width < MIN_PHONE_SIZE / 2 || height < MIN_PHONE_SIZE / 2) return;
      setSize((current) => current && current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(measure, MEASURE_REST_MS);
    });
    observer.observe(target);
    return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, []);

  useEffect(() => { if (!id || !visible) setLaidOut(null); }, [id, visible]);

  const phoneWidth = layout === "phone" ? size?.width ?? 0 : 0;
  const phoneHeight = layout === "phone" ? size?.height ?? 0 : 0;
  useEffect(() => {
    if (!id || !visible) return;
    if (layout === "phone" && (!phoneWidth || !phoneHeight)) return;
    let stale = false;
    // desktop only undoes a phone layout: a window nobody resized is never touched
    const asked = layout === "phone" ? setBrowserLayout(id, { layout, width: phoneWidth, height: phoneHeight })
      : serverLayout.current === "phone" ? setBrowserLayout(id, { layout }) : null;
    void (asked ?? Promise.resolve(null))
      .then((changed) => { if (changed && !stale) refresh(); })
      .catch((reason: unknown) => { if (!stale) setError(message(reason)); })
      .finally(() => { if (!stale) setLaidOut(id); });
    return () => { stale = true; };
  }, [id, visible, layout, want.turn, phoneWidth, phoneHeight, attempt, refresh]);

  useEffect(() => {
    const target = screen.current;
    if (!id || !visible || laidOut !== id || !target) return;
    let disposed = false;
    let instance: RFB | null = null;
    let retry: number | undefined;
    setPhase("connecting");
    void import("@novnc/novnc").then(({ default: Rfb }) => {
      if (disposed) return;
      instance = new Rfb(target, browserStreamUrl(id), { shared: true });
      // the picture fits the area it is given; the display's size is the layout's to decide
      instance.scaleViewport = true;
      instance.resizeSession = false;
      instance.background = "transparent";
      rfb.current = instance;
      instance.addEventListener("connect", () => {
        if (disposed) return;
        failures.current = 0;
        setPhase("connected");
        setError(null);
      });
      instance.addEventListener("disconnect", () => {
        if (disposed) return;
        rfb.current = null;
        setPhase("lost");
        // the list says whether the browser itself closed
        refresh();
        const wait = RETRY_MS[Math.min(failures.current, RETRY_MS.length - 1)]!;
        failures.current += 1;
        retry = window.setTimeout(() => setAttempt((count) => count + 1), wait);
      });
    }).catch((reason: unknown) => {
      if (disposed) return;
      setPhase("lost");
      setError(message(reason));
    });
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      rfb.current = null;
      // an already closed connection refuses to be closed again
      try { instance?.disconnect(); } catch { /* closed */ }
      target.replaceChildren();
    };
  }, [id, visible, laidOut, attempt, refresh]);

  // One finger drives the remote mouse (lib/browserView.ts). The listeners take the touch in
  // the capture phase and stop it there, so noVNC's own gestures (a stroke that drags instead of
  // scrolling) never see it, and the phone makes no mouse events of its own from it.
  useEffect(() => {
    const target = screen.current;
    if (!target) return;
    let holdTimer: number | undefined;
    let buttons = 0;
    const send = (x: number, y: number, mask: number): void => {
      const connection = rfb.current;
      const canvas = connection?._canvas;
      if (!connection?._sendMouse || !canvas) return;
      const box = canvas.getBoundingClientRect();
      connection._sendMouse(Math.max(0, Math.min(box.width - 1, x - box.left)), Math.max(0, Math.min(box.height - 1, y - box.top)), mask);
    };
    const gestures = new TouchGestures((action) => {
      if (action.type === "scroll") {
        for (const mask of wheelMasks(action.dx, action.dy)) send(action.x, action.y, buttons | mask);
        return;
      }
      if (action.type === "down") buttons |= BUTTON_MASK[action.button];
      else if (action.type === "up") buttons &= ~BUTTON_MASK[action.button];
      send(action.x, action.y, buttons);
    });
    const take = (event: TouchEvent): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onStart = (event: TouchEvent): void => {
      take(event);
      window.clearTimeout(holdTimer);
      const first = event.touches[0];
      if (!first) return;
      gestures.start(first.clientX, first.clientY, event.touches.length, performance.now());
      if (!gestures.waiting) return;
      holdTimer = window.setTimeout(() => {
        gestures.hold();
        // the phone answers the hold, as it does for its own long press
        try { navigator.vibrate?.(15); } catch { /* not allowed here */ }
      }, HOLD_MS);
    };
    const onMove = (event: TouchEvent): void => {
      take(event);
      const first = event.touches[0];
      if (!first) return;
      gestures.move(first.clientX, first.clientY);
      if (!gestures.waiting) window.clearTimeout(holdTimer);
    };
    const onEnd = (event: TouchEvent): void => {
      take(event);
      window.clearTimeout(holdTimer);
      if (event.touches.length === 0) gestures.end(performance.now());
    };
    const onCancel = (event: TouchEvent): void => {
      take(event);
      window.clearTimeout(holdTimer);
      gestures.cancel();
    };
    const options = { capture: true, passive: false } as const;
    target.addEventListener("touchstart", onStart, options);
    target.addEventListener("touchmove", onMove, options);
    target.addEventListener("touchend", onEnd, options);
    target.addEventListener("touchcancel", onCancel, options);
    return () => {
      window.clearTimeout(holdTimer);
      gestures.cancel();
      target.removeEventListener("touchstart", onStart, options);
      target.removeEventListener("touchmove", onMove, options);
      target.removeEventListener("touchend", onEnd, options);
      target.removeEventListener("touchcancel", onCancel, options);
    };
  }, []);

  const refill = (): void => {
    const field = keys.current;
    if (!field) return;
    field.value = KEYBOARD_FILL;
    sent.current = KEYBOARD_FILL;
    try { field.setSelectionRange(KEYBOARD_FILL.length, KEYBOARD_FILL.length); } catch { /* not focused yet */ }
  };

  // what the phone's keyboard did to its own text, said to the remote field as key presses
  const onInput = (event: FormEvent<HTMLTextAreaElement>): void => {
    const value = event.currentTarget.value;
    for (const keysym of typedKeysyms(sent.current, value)) rfb.current?.sendKey(keysym, null);
    sent.current = value;
    // a word still being composed is the keyboard's to rewrite: its text is left alone until then
    if ((event.nativeEvent as InputEvent).isComposing) return;
    if (value.includes("\n") || value.length < KEYBOARD_FILL.length / 2 || value.length > KEYBOARD_FILL.length * 4) refill();
  };

  // Enter, Backspace and the keys a keyboard sends as keys: pressed remotely, never written here
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const keysym = NAMED_KEYS[event.key];
    if (keysym === undefined || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    rfb.current?.sendKey(keysym, null);
  };

  const toggleKeyboard = (): void => {
    const field = keys.current;
    if (!field) return;
    if (document.activeElement === field) field.blur();
    else field.focus({ preventScroll: true });
  };

  const showsPhone = browser?.layout === "phone";
  const layoutLabel = showsPhone ? t("Switch to the desktop layout") : t("Switch to the phone layout");
  const keyboardLabel = typing ? t("Hide the keyboard") : t("Show the keyboard");
  const status = !browser ? t("No browser is open on the server right now.")
    : phase === "connected" ? null
    : phase === "lost" ? t("Reconnecting…") : t("Connecting…");

  return <div ref={surface} className="browser-view" role="dialog" aria-modal="true" aria-label={t("Browser on the server")} tabIndex={-1}>
    <header className="browser-view-bar">
      <Globe aria-hidden="true" className="browser-view-mark" />
      {browsers.length > 1
        ? <select className="select browser-view-pick" aria-label={t("Browser")} value={id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
          {browsers.map((entry) => <option key={entry.id} value={entry.id}>{entry.title || `:${entry.id}`}</option>)}
        </select>
        : <span className="browser-view-title">{browser?.title || t("Browser")}</span>}
      {browser?.phone_layout && <button type="button" className="icon-button" aria-label={layoutLabel} title={layoutLabel} onClick={() => setWant((current) => ({ layout: showsPhone ? "desktop" : "phone", turn: current.turn + 1 }))}>
        {showsPhone ? <Monitor aria-hidden="true" /> : <Smartphone aria-hidden="true" />}
      </button>}
      {/* pressing the button must not take the focus the keyboard hangs on */}
      {touch && <button type="button" className="icon-button" aria-label={keyboardLabel} title={keyboardLabel} aria-pressed={typing} disabled={phase !== "connected"} onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={toggleKeyboard}><Keyboard aria-hidden="true" /></button>}
      <button type="button" className="icon-button" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <div className="browser-view-body">
      <div ref={screen} className="browser-view-screen" />
      {status && <p className="browser-view-status" role="status">{status}</p>}
      {error && <p className="browser-view-error" role="alert">{error}</p>}
      <textarea ref={keys} className="browser-view-keys" aria-label={t("Type into the browser")} rows={1} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="enter"
        onFocus={() => { refill(); setTyping(true); }} onBlur={() => setTyping(false)} onInput={onInput} onKeyDown={onKeyDown} onCompositionEnd={() => { if (sent.current.length > KEYBOARD_FILL.length * 4) refill(); }} />
    </div>
  </div>;
}
