import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import "./ImageView.css";
import { ZoomControls } from "./ZoomControls.tsx";
import { useT } from "../lib/i18n.ts";
import { clampZoom, flickSpeed, glide, imageFit, imagePoint, imageZoomMax, scrollToPoint, useZoomGestures, ZOOM_STEP, type ZoomAnchor } from "../lib/zoomGestures.ts";

/** A double tap or double click zooms this far in (or to the most there is). */
const TAP_ZOOM = 2.5;
/** A drag let go faster than this (px/ms) glides on, until it is slower than the stop speed. */
const GLIDE_START = 0.25;
const GLIDE_STOP = 0.02;
/** until its size is known the image takes no room, so the view does not jump as it arrives */
const LOADING = { position: "absolute", width: 1, height: 1, opacity: 0 } as const;

interface Size {
  width: number;
  height: number;
}

/** the image's place in the view's content: the stage starts at the content's top-left corner */
const boxOf = (image: HTMLImageElement) => ({ left: image.offsetLeft, top: image.offsetTop, width: image.offsetWidth, height: image.offsetHeight });

/**
 * An image in the file viewer, fitted to the view (never past its own pixels): two fingers pinch
 * it, one drags it about once it is bigger than the view (any way, and a flick glides on), a double
 * tap zooms in around the tapped point and back, and the buttons, Ctrl+wheel and + - 0 do the same.
 * A mouse drags a zoomed image too, and its double click zooms. A finger's long press opens no
 * image menu (a finger that rests before it drags is moving the image): Download is in the header.
 */
export function ImageView({ url, name }: { url: string; name: string }) {
  const t = useT();
  const area = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // the room the image is fitted into: the view without the stage's padding
  const [room, setRoom] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  const picture = useRef<HTMLImageElement>(null);
  const pendingScroll = useRef<{ anchor: ZoomAnchor; point: ZoomAnchor } | null>(null);
  const [dragging, setDragging] = useState(false);
  // a finger's double tap is useZoomGestures'; only a mouse's double click zooms here
  const pressedWith = useRef("");

  useLayoutEffect(() => {
    const element = area.current;
    const stage = content.current;
    if (element === null || stage === null) return;
    const measure = () => {
      const style = getComputedStyle(stage);
      const px = (value: string) => Number.parseFloat(value) || 0;
      setRoom({
        width: Math.max(0, element.clientWidth - px(style.paddingLeft) - px(style.paddingRight)),
        height: Math.max(0, element.clientHeight - px(style.paddingTop) - px(style.paddingBottom)),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = natural === null ? 1 : imageFit(natural, room);
  const max = imageZoomMax(fit);
  const maxNow = useRef(max);
  maxNow.current = max;
  // a turned phone fits the image anew: a zoom past the new limit comes back to it
  useLayoutEffect(() => { if (zoom > max) setZoom(max); }, [zoom, max]);
  const shown = natural !== null && room.width > 0 && room.height > 0;
  const drawn = shown ? { width: natural.width * fit * zoom, height: natural.height * fit * zoom } : null;
  const pannable = drawn !== null && (drawn.width > room.width + 1 || drawn.height > room.height + 1);

  const zoomTo = useCallback((next: number, anchor?: ZoomAnchor) => {
    const root = area.current;
    const image = picture.current;
    const old = zoomNow.current;
    const target = clampZoom(next, 1, maxNow.current);
    if (root === null || image === null || Math.abs(target - old) < 1e-6) return;
    const at = anchor ?? { x: root.clientWidth / 2, y: root.clientHeight / 2 };
    // the image sits in the middle of the view until it outgrows it: the point is kept as a part of the image
    pendingScroll.current = { anchor: at, point: imagePoint(boxOf(image), root.scrollLeft, root.scrollTop, at) };
    setZoom(target);
  }, []);
  // what was under the fingers (or the middle) stays there once the image is laid out at the new zoom
  useLayoutEffect(() => {
    const root = area.current;
    const image = picture.current;
    const pending = pendingScroll.current;
    if (root === null || image === null || pending === null) return;
    pendingScroll.current = null;
    const { left, top } = scrollToPoint(boxOf(image), pending.point, pending.anchor);
    root.scrollLeft = left;
    root.scrollTop = top;
  }, [zoom]);
  useZoomGestures(area, content, zoom, { min: 1, max, tap: Math.min(max, TAP_ZOOM) }, zoomTo);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "+" || event.key === "=") zoomTo(zoom * ZOOM_STEP);
    else if (event.key === "-") zoomTo(zoom / ZOOM_STEP);
    else if (event.key === "0") zoomTo(1);
    else return;
    event.preventDefault();
  };
  const local = (event: MouseEvent<HTMLElement>): ZoomAnchor => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  // one finger (or a mouse) drags a zoomed image about in any direction and a flick glides on; the
  // browser's own touch scroll would keep to one axis once a stroke leans that way
  const pan = useRef<{ pointer: number; x: number; y: number; left: number; top: number; trail: { at: number; x: number; y: number }[] } | null>(null);
  const fingers = useRef(new Set<number>());
  const glideFrame = useRef(0);
  const stopGlide = () => { cancelAnimationFrame(glideFrame.current); glideFrame.current = 0; };
  useEffect(() => stopGlide, []);
  const startGlide = (element: HTMLElement, flick: ZoomAnchor) => {
    let speed = flick;
    // where it is, to the fraction: the view may keep its scroll in whole pixels
    const at = { left: element.scrollLeft, top: element.scrollTop };
    let last: number | null = null;
    const step = (now: number) => {
      // the first frame only starts the clock: its time can be from before the finger lifted
      if (last !== null) {
        const ms = Math.max(0, Math.min(64, now - last));
        const across = glide(speed.x, ms);
        const down = glide(speed.y, ms);
        at.left -= across.distance;
        at.top -= down.distance;
        element.scrollLeft = at.left;
        element.scrollTop = at.top;
        // an edge stops it that way
        const edge = { x: Math.abs(element.scrollLeft - at.left) > 1, y: Math.abs(element.scrollTop - at.top) > 1 };
        if (edge.x) at.left = element.scrollLeft;
        if (edge.y) at.top = element.scrollTop;
        speed = { x: edge.x ? 0 : across.speed, y: edge.y ? 0 : down.speed };
      }
      last = now;
      glideFrame.current = Math.hypot(speed.x, speed.y) > GLIDE_STOP ? requestAnimationFrame(step) : 0;
    };
    glideFrame.current = requestAnimationFrame(step);
  };
  const endPan = (event: PointerEvent<HTMLDivElement> | null) => {
    const from = pan.current;
    pan.current = null;
    setDragging(false);
    if (from === null || event === null) return;
    const speed = flickSpeed(from.trail, event.timeStamp);
    if (Math.hypot(speed.x, speed.y) > GLIDE_START) startGlide(event.currentTarget, speed);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    pressedWith.current = event.pointerType;
    stopGlide();
    if (event.pointerType !== "mouse") {
      if (event.isPrimary) fingers.current.clear();
      fingers.current.add(event.pointerId);
      // a second finger pinches (useZoomGestures): no drag until every finger is up
      if (fingers.current.size > 1) { endPan(null); return; }
    }
    if ((event.pointerType === "mouse" && event.button !== 0) || !pannable) return;
    if (event.pointerType === "mouse") event.preventDefault();
    element.setPointerCapture(event.pointerId);
    pan.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop, trail: [{ at: event.timeStamp, x: event.clientX, y: event.clientY }] };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const from = pan.current;
    if (from === null || from.pointer !== event.pointerId) return;
    event.currentTarget.scrollLeft = from.left - (event.clientX - from.x);
    event.currentTarget.scrollTop = from.top - (event.clientY - from.y);
    from.trail.push({ at: event.timeStamp, x: event.clientX, y: event.clientY });
    if (from.trail.length > 12) from.trail.shift();
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    fingers.current.delete(event.pointerId);
    if (pan.current?.pointer === event.pointerId) endPan(event.type === "pointerup" ? event : null);
  };

  return (
    <div className="image-view">
      <div ref={area} className="image-scroll" tabIndex={0} role={failed ? undefined : "img"} aria-label={name} aria-busy={!shown && !failed}
        data-zoomed={zoom > 1 + 1e-6 ? "" : undefined} data-pannable={pannable ? "" : undefined} data-dragging={dragging ? "" : undefined}
        onKeyDown={onKeyDown} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
        onDoubleClick={(event) => { if (pressedWith.current === "mouse") zoomTo(zoom > 1.05 ? 1 : Math.min(max, TAP_ZOOM), local(event)); }}
        onContextMenu={(event) => { if (pressedWith.current !== "mouse") event.preventDefault(); }}>
        <div ref={content} className="image-stage">
          {failed
            ? <p className="file-viewer-note" role="alert">{t("The file could not be opened.")}</p>
            : <img ref={picture} className="image-view-img" src={url} alt="" draggable={false} style={drawn ?? LOADING}
                onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1 })}
                onError={() => setFailed(true)} />}
          {!shown && !failed && <p className="file-viewer-note image-view-note">{t("Opening…")}</p>}
        </div>
      </div>
      {shown && (
        <div className="image-toolbar">
          <ZoomControls zoom={zoom} min={1} max={max} onZoom={(next) => zoomTo(next)} fitLabel={t("Fit to screen")} />
        </div>
      )}
    </div>
  );
}
