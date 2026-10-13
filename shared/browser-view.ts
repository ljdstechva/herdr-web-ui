/**
 * Browser view: the browsers open on this PC's virtual displays (the ones agents drive through
 * Playwright), watched and driven from the app. The server bridges each display's screen with
 * x11vnc; nothing here reaches into the browser itself.
 *
 * Routes (all behind the token gate; a watch device is refused every one, since such a browser
 * holds signed-in sessions):
 *
 * - `GET /api/browsers` → `BrowserList`. 404 `not_available` where the server cannot offer it
 *   (not Linux, or no x11vnc); clients show a retryable unavailable state.
 * - `POST /api/browsers/<id>/layout` with `BrowserLayoutRequest` and `x-herdr-browser: 1`
 *   → `BrowserInfo`. `phone` makes the display and the browser's window the size asked for, so
 *   pages lay themselves out as on a phone; `desktop` puts back what was there before. 409
 *   `layout_unavailable` when the display cannot be resized, 404 `browser_not_found` when the
 *   browser has closed.
 * - `GET /api/browsers/<id>/stream` (WebSocket, binary) → the display's RFB (VNC) byte stream,
 *   both ways. Closed with 1011 when the display's stream ends.
 */

export type BrowserLayout = "desktop" | "phone";

export interface BrowserInfo {
  /** the X display number ("95"): one entry per display that shows a browser window */
  id: string;
  /** the title of the browser's front window */
  title: string;
  layout: BrowserLayout;
  /** the display's size now, in its own pixels */
  width: number;
  height: number;
  /** false when this display cannot be resized, so only `desktop` is offered */
  phone_layout: boolean;
}

export interface BrowserList {
  browsers: BrowserInfo[];
}

export type BrowserLayoutRequest =
  | { layout: "desktop" }
  /** the size of the area the phone shows the browser in, in CSS pixels */
  | { layout: "phone"; width: number; height: number };

/** A phone layout is never asked for smaller than this: below it a browser's own toolbar no longer fits. */
export const MIN_PHONE_SIZE = 280;
