import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerCall, handleSignInRequest, SignInService } from "./sign-in.ts";

/** A stand-in broker: answers each JSON line from `replies`, records what it was asked. */
let dir: string;
let socketPath: string;
let server: Server | null;
let asked: Array<Record<string, unknown>>;
let replies: Array<Record<string, unknown> | Array<Record<string, unknown>>>;

function startBroker(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          asked.push(JSON.parse(line) as Record<string, unknown>);
          const reply = replies.shift() ?? { ok: false, error: "no reply scripted" };
          for (const message of Array.isArray(reply) ? reply : [reply]) socket.write(JSON.stringify(message) + "\n");
        }
      });
    });
    server.listen(socketPath, resolve);
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sign-in-"));
  socketPath = join(dir, "broker.sock");
  asked = []; replies = []; server = null;
  await startBroker();
});
afterEach(async () => {
  if (server) await new Promise((resolve) => server?.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const request = (method: string, path: string, body?: unknown) => new Request(`http://local${path}`, {
  method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});
const service = () => new SignInService(socketPath);

describe("brokerCall", () => {
  it("skips interim waiting lines and resolves with the final one", async () => {
    replies.push([{ ok: true, waiting: true, id: "x" }, { ok: true, done: 1 }]);
    expect(await brokerCall(socketPath, { cmd: "login" }, 2_000)).toEqual({ ok: true, done: 1 });
  });
  it("says offline when nothing listens", async () => {
    await expect(new SignInService(join(dir, "none.sock")).list(false)).resolves.toEqual({ broker: "offline", requests: [] });
  });
});

describe("GET /api/sign-in", () => {
  it("lists the broker's open requests in the app's shape", async () => {
    replies.push({ ok: true, requests: [{ id: "ab12cd34", kind: "credentials", site: "canva", username: null, loginUrl: "https://www.canva.com/login", browser: "smarcomms", requester: "laurenz:pid1:w1:p2", pane: "w1:p2", created: "2026-10-28T00:00:00Z", hint: null, status: "open" }, { id: "bad" }] });
    const response = await handleSignInRequest(request("GET", "/api/sign-in?wait=1"), "/api/sign-in", new URL("http://local/api/sign-in?wait=1"), service());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ broker: "online", requests: [{ id: "ab12cd34", kind: "credentials", site: "canva", username: null, login_url: "https://www.canva.com/login", browser: "smarcomms", requester: "laurenz:pid1:w1:p2", pane: "w1:p2", created: "2026-10-28T00:00:00Z", hint: null }] });
    expect(asked[0]).toEqual({ cmd: "pending", wait: 25_000 });
  });
  it("refuses other methods", async () => {
    const response = await handleSignInRequest(request("POST", "/api/sign-in"), "/api/sign-in", new URL("http://local/api/sign-in"), service());
    expect(response.status).toBe(405);
  });
});

describe("POST /api/sign-in/<id>", () => {
  it("forwards the answer under the broker's names and returns the outcome", async () => {
    replies.push({ ok: true, accepted: true, kind: "credentials", site: "canva", result: "logged-in", detail: null, url: "https://www.canva.com/" });
    const response = await handleSignInRequest(request("POST", "/api/sign-in/ab12cd34", { username: "me@x.ph", password: "s3cret", totp: "", login_url: "", remember: false }), "/api/sign-in/ab12cd34", new URL("http://local/api/sign-in/ab12cd34"), service());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "credentials", site: "canva", result: "logged-in", detail: null, url: "https://www.canva.com/" });
    expect(asked[0]).toEqual({ cmd: "provide", id: "ab12cd34", username: "me@x.ph", password: "s3cret", remember: false });
  });
  it("answers a refusal as 409 with the broker's words", async () => {
    replies.push({ ok: false, error: "wrong passphrase" });
    const response = await handleSignInRequest(request("POST", "/api/sign-in/ab12cd34", { passphrase: "nope" }), "/api/sign-in/ab12cd34", new URL("http://local/api/sign-in/ab12cd34"), service());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "refused", message: "wrong passphrase" } });
  });
  it("rejects a multi-line or oversized field before the broker sees it", async () => {
    const response = await handleSignInRequest(request("POST", "/api/sign-in/ab12cd34", { password: "a\nb" }), "/api/sign-in/ab12cd34", new URL("http://local/api/sign-in/ab12cd34"), service());
    expect(response.status).toBe(409);
    expect(asked).toEqual([]);
  });
  it("rejects an id that is not the broker's shape", async () => {
    const response = await handleSignInRequest(request("POST", "/api/sign-in/..", { code: "1" }), "/api/sign-in/..", new URL("http://local/api/sign-in/.."), service());
    expect(response.status).toBe(400);
  });
  it("dismisses", async () => {
    replies.push({ ok: true, dismissed: "ab12cd34" });
    const response = await handleSignInRequest(request("POST", "/api/sign-in/ab12cd34/dismiss"), "/api/sign-in/ab12cd34/dismiss", new URL("http://local/api/sign-in/ab12cd34/dismiss"), service());
    expect(await response.json()).toEqual({ dismissed: "ab12cd34" });
    expect(asked[0]).toEqual({ cmd: "dismiss", id: "ab12cd34" });
  });
  it("says 503 when the broker is not running", async () => {
    const response = await handleSignInRequest(request("POST", "/api/sign-in/ab12cd34", { code: "123456" }), "/api/sign-in/ab12cd34", new URL("http://local/api/sign-in/ab12cd34"), new SignInService(join(dir, "none.sock")));
    expect(response.status).toBe(503);
  });
});
