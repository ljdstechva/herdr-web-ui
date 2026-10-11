/**
 * /api/vps routes (catalogue in shared/vps.ts). Behind the token gate like every /api/ route; a
 * watch device is refused the POSTs centrally, and each POST also needs `x-herdr-vps: 1`, which a
 * cross-site form cannot send.
 */

import type { DoctorAgentRequest, ProcessAction } from "../shared/vps.ts";
import { badRequest, errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { DoctorError, type VpsDoctor } from "./vps-doctor.ts";
import type { VpsMonitor } from "./vps.ts";

export interface VpsServices {
  monitor: VpsMonitor;
  doctor: VpsDoctor;
  /** sends a test VPS alert to every subscribed device */
  testAlert(): Promise<void>;
}

const PROCESS_ACTIONS = new Set<ProcessAction>(["terminate", "kill", "close-pane"]);

async function body(request: Request): Promise<Record<string, unknown> | Response> {
  let payload: unknown;
  try { payload = await request.json(); } catch { return badRequest("invalid_json", "request body must be JSON"); }
  return isJsonObject(payload) ? payload : badRequest("invalid_body", "request body must be a JSON object");
}

/** `timeout` raises Bun's idle limit for a request that takes long before its first byte (a disk scan). */
export async function handleVpsRequest(request: Request, pathname: string, services: VpsServices | undefined, timeout: (seconds: number) => void): Promise<Response> {
  if (!services) return jsonResponse({ error: { code: "not_available", message: "VPS status is not available on this server" } }, 404);
  const { monitor, doctor } = services;
  const route = `${request.method} ${pathname}`;
  if (request.method === "POST" && request.headers.get("x-herdr-vps") !== "1") {
    return jsonResponse({ error: { code: "missing_header", message: "x-herdr-vps: 1 is required" } }, 403);
  }
  try {
    switch (route) {
      case "GET /api/vps/status":
        return jsonResponse(monitor.status());
      case "GET /api/vps/config":
        return jsonResponse(monitor.config());
      case "POST /api/vps/config": {
        const payload = await body(request);
        return payload instanceof Response ? payload : jsonResponse(monitor.setConfig(payload));
      }
      case "POST /api/vps/alert/test":
        await services.testAlert();
        return new Response(null, { status: 204 });
      case "GET /api/vps/doctor/options":
        return jsonResponse(await doctor.options());
      case "POST /api/vps/doctor/disk/scan": {
        const payload = await body(request);
        if (payload instanceof Response) return payload;
        timeout(300);
        const days = typeof payload["older_than_days"] === "number" ? payload["older_than_days"] : 30;
        return jsonResponse(await doctor.scanDisk(days));
      }
      case "POST /api/vps/doctor/disk/clean": {
        const payload = await body(request);
        if (payload instanceof Response) return payload;
        const scanId = payload["scan_id"];
        const ids = payload["ids"];
        if (typeof scanId !== "string" || !Array.isArray(ids) || !ids.every((id) => typeof id === "string") || ids.length === 0) {
          return badRequest("invalid_body", "scan_id and a non-empty ids list are required");
        }
        timeout(300);
        return jsonResponse(await doctor.cleanDisk(scanId, ids as string[]));
      }
      case "GET /api/vps/doctor/processes":
        return jsonResponse(await doctor.processes());
      case "POST /api/vps/doctor/process": {
        const payload = await body(request);
        if (payload instanceof Response) return payload;
        const { pid, start_ticks: startTicks, action } = payload;
        if (typeof pid !== "number" || typeof startTicks !== "number" || typeof action !== "string" || !PROCESS_ACTIONS.has(action as ProcessAction)) {
          return badRequest("invalid_body", "pid, start_ticks and action (terminate, kill or close-pane) are required");
        }
        return jsonResponse(await doctor.processAction(pid, startTicks, action as ProcessAction));
      }
      case "POST /api/vps/doctor/agent": {
        const payload = await body(request);
        if (payload instanceof Response) return payload;
        const { engine, model = null, effort = null, issue_id: issueId = null, note = "" } = payload;
        if ((engine !== "claude" && engine !== "codex") || (model !== null && typeof model !== "string") || (effort !== null && typeof effort !== "string")
          || (issueId !== null && typeof issueId !== "string") || typeof note !== "string") {
          return badRequest("invalid_body", "engine (claude or codex), and optional model, effort, issue_id and note strings are required");
        }
        // starting the agent waits for herdr's agent.start, up to a minute
        timeout(90);
        return jsonResponse(await doctor.startAgent({ engine, model: model || null, effort: effort || null, issue_id: issueId, note } satisfies DoctorAgentRequest));
      }
      default:
        return jsonResponse({ error: { code: "not_found", message: `${request.method} ${pathname} is not a VPS route` } }, 404);
    }
  } catch (error) {
    if (error instanceof DoctorError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return errorResponse(error);
  }
}
