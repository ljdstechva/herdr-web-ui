/**
 * Sign-in cards: what the agent-login broker on this PC is waiting for from the owner.
 *
 * An agent runs `agent-login login <site>`; when the vault lacks something only the owner has
 * (its passphrase after a reboot, the site's credentials, a one-time code), the broker parks a
 * request and the agent waits. This module shows those requests to the app and carries the
 * owner's answer back over the broker's unix socket. The secrets pass through this process
 * once, in memory, and are never logged, stored or echoed; the agent sees only the outcome.
 *
 * Without a broker (no socket, or another PC) every read says `broker: "offline"` and nothing
 * is shown: the feature is this PC's, and optional.
 */

import { connect } from "node:net";
import { join } from "node:path";
import { badRequest, isJsonObject, jsonResponse } from "./http.ts";

import type { SignInAnswer, SignInKind, SignInList, SignInOutcome, SignInRequest, SignInSite, SignInSites } from "../shared/sign-in.ts";
export type { SignInAnswer, SignInKind, SignInList, SignInOutcome, SignInRequest, SignInSite, SignInSites };

const LONG_POLL_MS = 25_000;
const ANSWER_TIMEOUT_MS = 5 * 60_000;
const MAX_FIELD = 4096;

export function defaultBrokerSocket(env: Record<string, string | undefined> = process.env): string {
  if (env["AGENT_LOGIN_SOCK"]) return env["AGENT_LOGIN_SOCK"];
  const runtime = env["XDG_RUNTIME_DIR"] ?? `/run/user/${typeof process.getuid === "function" ? process.getuid() : 1000}`;
  return join(runtime, "agent-login.sock");
}

export class BrokerUnavailable extends Error {}

/** One newline-delimited JSON exchange with the broker; interim `waiting` lines are skipped. */
export function brokerCall(socketPath: string, request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; socket.destroy(); fn(); } };
    socket.setTimeout(timeoutMs, () => finish(() => reject(new Error("broker timed out"))));
    socket.on("error", (error: NodeJS.ErrnoException) => finish(() => reject(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? new BrokerUnavailable("broker offline") : error)));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message: unknown;
        try { message = JSON.parse(line); } catch { finish(() => reject(new Error("broker sent an unreadable line"))); return; }
        if (!isJsonObject(message)) { finish(() => reject(new Error("broker sent an unreadable line"))); return; }
        if (message["ok"] === true && message["waiting"] === true) continue;
        finish(() => resolve(message)); return;
      }
    });
    socket.on("close", () => finish(() => reject(new BrokerUnavailable("broker closed the connection"))));
    socket.write(JSON.stringify(request) + "\n");
  });
}

function text(value: unknown): string | null { return typeof value === "string" ? value : null; }

function toRequest(value: unknown): SignInRequest | null {
  if (!isJsonObject(value)) return null;
  const id = text(value["id"]); const kind = text(value["kind"]); const site = text(value["site"]);
  if (!id || !site || !(kind === "init" || kind === "unlock" || kind === "credentials" || kind === "code")) return null;
  return {
    id, kind, site,
    username: text(value["username"]), login_url: text(value["loginUrl"]), browser: text(value["browser"]),
    requester: text(value["requester"]), pane: text(value["pane"]), created: text(value["created"]) ?? "", hint: text(value["hint"]),
    reason: value["reason"] === "rejected" || value["reason"] === "change" ? value["reason"] : null,
  };
}

function toSite(value: unknown): SignInSite | null {
  if (!isJsonObject(value)) return null;
  const site = text(value["site"]); const username = text(value["username"]);
  if (!site || username === null) return null;
  return { site, username, browser: text(value["browser"]), login_url: text(value["loginUrl"]), last_login: text(value["lastLogin"]), updated: text(value["updated"]) };
}

/** a site name as the broker spells them */
const SITE = /^[a-z0-9][a-z0-9._-]{0,40}$/;

export class SignInService {
  constructor(private readonly socketPath: string = defaultBrokerSocket(), private readonly call: typeof brokerCall = brokerCall) {}

  /**
   * the open requests; with `wait`, holds up to LONG_POLL_MS until they differ from `seen` (the
   * ids the app shows, comma-joined), so a card's arrival and its removal both come at once
   */
  async list(wait: boolean, seen = ""): Promise<SignInList> {
    try {
      const reply = await this.call(this.socketPath, { cmd: "pending", wait: wait ? LONG_POLL_MS : 0, seen }, LONG_POLL_MS + 5_000);
      if (reply["ok"] !== true) return { broker: "online", requests: [] };
      const raw = Array.isArray(reply["requests"]) ? reply["requests"] : [];
      return { broker: "online", requests: raw.map(toRequest).filter((request): request is SignInRequest => request !== null) };
    } catch (error) {
      if (error instanceof BrokerUnavailable) return { broker: "offline", requests: [] };
      throw error;
    }
  }

  /** the owner's answer; resolves with the login's outcome once the broker has it */
  async answer(id: string, answer: SignInAnswer): Promise<SignInOutcome> {
    const request: Record<string, unknown> = { cmd: "provide", id };
    if (answer.username !== undefined) request["username"] = answer.username;
    if (answer.password !== undefined) request["password"] = answer.password;
    if (answer.totp !== undefined && answer.totp !== "") request["totp"] = answer.totp;
    if (answer.passphrase !== undefined) request["passphrase"] = answer.passphrase;
    if (answer.code !== undefined) request["code"] = answer.code;
    if (answer.login_url !== undefined && answer.login_url !== "") request["loginUrl"] = answer.login_url;
    if (answer.remember !== undefined) request["remember"] = answer.remember;
    const reply = await this.call(this.socketPath, request, ANSWER_TIMEOUT_MS);
    if (reply["ok"] !== true) throw new SignInRefused(text(reply["error"]) ?? "the broker refused the answer");
    const kind = text(reply["kind"]);
    return {
      kind: kind === "init" || kind === "unlock" || kind === "credentials" || kind === "code" ? kind : "credentials",
      site: text(reply["site"]) ?? "", result: text(reply["result"]) ?? "pending", detail: text(reply["detail"]), url: text(reply["url"]),
    };
  }

  /** Settings → Website logins: the sites the vault holds, by name */
  async sites(): Promise<SignInSites> {
    try {
      const reply = await this.call(this.socketPath, { cmd: "sites" }, 10_000);
      if (reply["ok"] !== true) throw new SignInRefused(text(reply["error"]) ?? "the broker refused");
      const raw = Array.isArray(reply["details"]) ? reply["details"] : null;
      const known = Array.isArray(reply["known_flows"]) ? reply["known_flows"].filter((name): name is string => typeof name === "string") : [];
      return { broker: "online", vault: reply["vault"] === true, locked: reply["locked"] === true, sites: raw === null ? null : raw.map(toSite).filter((site): site is SignInSite => site !== null), known };
    } catch (error) {
      if (error instanceof BrokerUnavailable) return { broker: "offline", vault: false, locked: false, sites: null, known: [] };
      throw error;
    }
  }

  /** asks the broker to put up a card that replaces one site's login; the card comes through `list` */
  async change(site: string): Promise<void> {
    const reply = await this.call(this.socketPath, { cmd: "change", site, requester: "phone" }, 10_000);
    if (reply["ok"] !== true) throw new SignInRefused(text(reply["error"]) ?? "the broker refused");
  }

  /** asks the broker to put up the vault's passphrase card (create or unlock) */
  async unlock(): Promise<void> {
    const reply = await this.call(this.socketPath, { cmd: "phone-unlock", requester: "phone" }, 10_000);
    if (reply["ok"] !== true) throw new SignInRefused(text(reply["error"]) ?? "the broker refused");
  }

  async dismiss(id: string): Promise<void> {
    const reply = await this.call(this.socketPath, { cmd: "dismiss", id }, 10_000);
    if (reply["ok"] !== true) throw new SignInRefused(text(reply["error"]) ?? "the broker refused");
  }
}

export class SignInRefused extends Error {}

const ID = /^[a-f0-9]{8,32}$/;

function field(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_FIELD || /[\r\n]/.test(value)) throw new SignInRefused(`${name}: a single line of at most ${MAX_FIELD} characters`);
  return value;
}

/**
 * GET  /api/sign-in[?wait=1&seen=<ids>]   -> SignInList (the ids shown, comma-joined: the wait ends when they change)
 * GET  /api/sign-in/sites                 -> SignInSites
 * POST /api/sign-in/sites/<site>/change   -> {asked: site}   (a card to replace that site's login)
 * POST /api/sign-in/unlock                -> {asked: true}   (the vault's passphrase card)
 * POST /api/sign-in/<id>                  {username?, password?, totp?, passphrase?, code?, login_url?, remember?} -> SignInOutcome
 * POST /api/sign-in/<id>/dismiss          -> {dismissed: id}
 */
export async function handleSignInRequest(request: Request, pathname: string, url: URL, service: SignInService): Promise<Response> {
  if (pathname === "/api/sign-in") {
    if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET /api/sign-in" } }, 405, { allow: "GET" });
    const seen = url.searchParams.get("seen") ?? "";
    if (seen.length > 2048 || !/^[a-f0-9,]*$/.test(seen)) return badRequest("invalid_seen", "seen: request ids, comma-joined");
    return jsonResponse(await service.list(url.searchParams.get("wait") === "1", seen), 200, { "cache-control": "no-store" });
  }
  if (pathname === "/api/sign-in/sites") {
    if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET /api/sign-in/sites" } }, 405, { allow: "GET" });
    return jsonResponse(await service.sites(), 200, { "cache-control": "no-store" });
  }
  const owner = /^\/api\/sign-in\/(?:sites\/([^/]+)\/change|(unlock))$/.exec(pathname);
  if (owner) {
    if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "Use POST" } }, 405, { allow: "POST" });
    const site = owner[1] === undefined ? null : decodeURIComponent(owner[1]);
    if (site !== null && !SITE.test(site)) return badRequest("invalid_site", "a site name is letters, digits, . _ - (at most 41 characters)");
    try {
      if (site === null) { await service.unlock(); return jsonResponse({ asked: true }, 200, { "cache-control": "no-store" }); }
      await service.change(site);
      return jsonResponse({ asked: site }, 200, { "cache-control": "no-store" });
    } catch (error) {
      if (error instanceof SignInRefused) return jsonResponse({ error: { code: "refused", message: error.message } }, 409);
      if (error instanceof BrokerUnavailable) return jsonResponse({ error: { code: "broker_offline", message: "The sign-in broker on this PC is not running" } }, 503);
      throw error;
    }
  }
  const match = /^\/api\/sign-in\/([^/]+)(\/dismiss)?$/.exec(pathname);
  if (!match) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  const id = match[1] ?? "";
  if (!ID.test(id)) return badRequest("invalid_id", "not a sign-in request id");
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "Use POST" } }, 405, { allow: "POST" });
  try {
    if (match[2]) { await service.dismiss(id); return jsonResponse({ dismissed: id }, 200, { "cache-control": "no-store" }); }
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "send a JSON object"); }
    if (!isJsonObject(body)) return badRequest("invalid_json", "send a JSON object");
    const answer: SignInAnswer = {
      username: field(body, "username"), password: field(body, "password"), totp: field(body, "totp"), passphrase: field(body, "passphrase"),
      code: field(body, "code"), login_url: field(body, "login_url"), remember: typeof body["remember"] === "boolean" ? body["remember"] : undefined,
    };
    const outcome = await service.answer(id, answer);
    return jsonResponse(outcome, 200, { "cache-control": "no-store" });
  } catch (error) {
    if (error instanceof SignInRefused) return jsonResponse({ error: { code: "refused", message: error.message } }, 409);
    if (error instanceof BrokerUnavailable) return jsonResponse({ error: { code: "broker_offline", message: "The sign-in broker on this PC is not running" } }, 503);
    throw error;
  }
}
