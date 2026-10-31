/**
 * The chat's activity line on a phone, end to end: a Codex pane (a stand-in process and a store
 * of its own) whose session spawned two subagents. The line says the agent works and what runs
 * beside it, keeps saying it after the agent's turn ended, lists what runs, and goes when the
 * last subagent ends.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-activity-"));
const codexHome = join(root, "codex-home");
const sessions = join(codexHome, "sessions", "2026", "10", "24");
mkdirSync(sessions, { recursive: true });
const parent = "019fe723-896b-77a0-8ac9-13f1407a8594";
const children = [
  { id: "019fe724-0000-7000-8000-000000000001", nickname: "Ada", path: "/root/data_import" },
  { id: "019fe724-0000-7000-8000-000000000002", nickname: "Grace", path: "/root/report_check" },
];
const rollout = (thread: string) => join(sessions, `rollout-2026-10-24T00-00-00-${thread}.jsonl`);
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const turn = (type: string) => line({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type } });
writeFileSync(rollout(parent), line({ type: "session_meta", payload: { id: parent, cwd: root, source: "cli" } }) + turn("task_started"));
const db = new Database(join(codexHome, "state_5.sqlite"));
db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source TEXT NOT NULL,
  cwd TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, first_user_message TEXT NOT NULL DEFAULT '', agent_nickname TEXT, agent_role TEXT, agent_path TEXT, model TEXT, created_at_ms INTEGER)`);
db.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)");
const now = Math.floor(Date.now() / 1000);
db.query("INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, created_at_ms) VALUES (?, ?, ?, ?, 'cli', ?, ?)").run(parent, rollout(parent), now, now, root, Date.now());
for (const child of children) {
  db.query("INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, agent_nickname, agent_path, model, created_at_ms) VALUES (?, ?, ?, ?, '{\"subagent\":{}}', ?, ?, ?, 'gpt-6', ?)")
    .run(child.id, rollout(child.id), now, now, root, child.nickname, child.path, Date.now());
  db.query("INSERT INTO thread_spawn_edges VALUES (?, ?, 'open')").run(parent, child.id);
}
db.close();
const standIn = join(root, "codex");
writeFileSync(standIn, "#!/bin/sh\nsleep 600\n");
chmodSync(standIn, 0o755);

let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-agent-activity" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `${standIn} resume ${parent}\n` });
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: pane });
    if (info.process_info?.foreground_processes?.some((process) => process.argv?.includes(standIn))) break;
    if (attempt === 99) throw new Error("test Codex process did not start");
    await Bun.sleep(50);
  }
  // the subagents write after the process started: they run in it, not in one before it
  for (const child of children) writeFileSync(rollout(child.id), line({ type: "session_meta", payload: { id: child.id, source: { subagent: {} } } }) + turn("task_started"));
  const report = (state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state, agent_session_path: rollout(parent) });
  await report("working");
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}&view=chat`);
  const strip = page.locator(".agent-activity-text");

  await strip.filter({ hasText: "Codex is working · 2 subagents" }).waitFor();
  assert.equal(await page.locator(".agent-activity").count(), 1, "one line, however often it is drawn again");
  console.log("PASS the line says the agent works and what it spawned");

  // the agent's turn ends; its subagents run on
  await report("idle");
  await strip.filter({ hasText: "2 subagents still running" }).waitFor();
  await page.locator("button.agent-activity-bar").tap();
  // the main agent heads the list; the rows under it are what runs beside it
  assert.match(await page.locator(".agent-activity-task.is-main").innerText(), /main agent/);
  const rows = page.locator(".agent-activity-task:not(.is-main) .agent-activity-task-title");
  await rows.first().waitFor();
  assert.deepEqual((await rows.allTextContents()).sort(), ["Ada · data import", "Grace · report check"]);
  assert.match(await page.locator(".agent-activity-task-time").first().textContent() ?? "", /^\d+s$/);
  // the line stays inside the phone's screen, above the box
  const box = await page.locator(".agent-activity").boundingBox();
  const composer = await page.locator(".composer").boundingBox();
  assert.ok(box && composer && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= composer.y + 1, `the line sits over the box: ${JSON.stringify({ box, composer })}`);
  console.log("PASS after the turn the line says what still runs, and opens on it");

  appendFileSync(rollout(children[0]!.id), turn("task_complete"));
  await strip.filter({ hasText: "1 subagent still running" }).waitFor();
  appendFileSync(rollout(children[1]!.id), turn("turn_aborted"));
  await page.locator(".agent-activity").waitFor({ state: "detached" });
  console.log("PASS the line follows each subagent's end, and goes with the last");

  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop();
  if (workspace) await workspaceClose(workspace).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
