/**
 * /api/browsers routes (catalogue in shared/browser-view.ts). Behind the token gate like every
 * /api/ route. A watch device is refused all of them, the list included: the browsers shown are
 * signed in to their owner's accounts. The POST also needs `x-herdr-browser: 1`, which a
 * cross-site form cannot send. The stream is a WebSocket and is upgraded in index.ts.
 */

import type { BrowserLayoutRequest, BrowserList } from "../shared/browser-view.ts";
import { BrowserViewError, type BrowserViews } from "./browser-view.ts";
import { badRequest, errorResponse, isJsonObject, jsonResponse } from "./http.ts";

export type BrowserViewService = Pick<BrowserViews, "available" | "list" | "setLayout" | "open">;

const STREAM_ROUTE = /^\/api\/browsers\/(\d{1,4})\/stream$/;
const LAYOUT_ROUTE = /^\/api\/browsers\/(\d{1,4})\/layout$/;

/** The display a stream path names, or null for any other path. */
export function browserStreamId(pathname: string): string | null {
  return STREAM_ROUTE.exec(pathname)?.[1] ?? null;
}

/** Why this request may not use the browser view at all, or null when it may. */
export function browserViewRefusal(views: BrowserViewService | undefined, readOnly: boolean): Response | null {
  if (!views?.available) return jsonResponse({ error: { code: "not_available", message: "The browser view is not available on this server" } }, 404);
  if (readOnly) return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  return null;
}

function layoutRequest(payload: unknown): BrowserLayoutRequest | null {
  if (!isJsonObject(payload)) return null;
  if (payload["layout"] === "desktop") return { layout: "desktop" };
  const { width, height } = payload;
  if (payload["layout"] !== "phone" || typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 10_000 || height > 10_000) return null;
  return { layout: "phone", width, height };
}

export async function handleBrowserRequest(request: Request, pathname: string, views: BrowserViewService | undefined, readOnly: boolean): Promise<Response> {
  const refusal = browserViewRefusal(views, readOnly);
  if (refusal || !views) return refusal!;
  try {
    if (pathname === "/api/browsers" && request.method === "GET") {
      return jsonResponse({ browsers: await views.list() } satisfies BrowserList);
    }
    const layout = LAYOUT_ROUTE.exec(pathname);
    if (layout && request.method === "POST") {
      if (request.headers.get("x-herdr-browser") !== "1") return jsonResponse({ error: { code: "missing_header", message: "x-herdr-browser: 1 is required" } }, 403);
      let payload: unknown;
      try { payload = await request.json(); } catch { return badRequest("invalid_json", "request body must be JSON"); }
      const wanted = layoutRequest(payload);
      if (!wanted) return badRequest("invalid_body", "layout must be desktop, or phone with a width and a height");
      return jsonResponse(await views.setLayout(layout[1]!, wanted));
    }
    return jsonResponse({ error: { code: "not_found", message: `${request.method} ${pathname} is not a browser route` } }, 404);
  } catch (error) {
    if (error instanceof BrowserViewError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return errorResponse(error);
  }
}
