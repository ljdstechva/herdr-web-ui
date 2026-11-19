/**
 * Claude Code compatibility probe: does the running web UI still read what this Claude Code draws?
 *
 *   bun scripts/claude-compat/probe.ts [--url http://127.0.0.1:7317] [--json out.json] [--keep]
 *                                      [--model claude-haiku-5-5] [--pane-env "NAME=value …"]
 *
 * Opens a throwaway herdr workspace, starts the installed Claude Code there on Haiku (a few short
 * turns of usage), and checks, through the web UI's own API, what a phone would get: the chat
 * transcript, the /model, /effort and switch-model cards, a question card, the plan card (typed
 * feedback must keep Claude planning), and Claude voice. The workspace is closed at the end
 * (--keep leaves it open to look at). Exit 0 when every check passed or was skipped, 1 otherwise.
 *
 * It answers only its own cards in its own workspace. scripts/claude-compat/watch.sh runs it
 * when Claude Code updates itself.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name: string): string | null => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] ?? null : null; };
const BASE = option("--url") ?? "http://127.0.0.1:7317";
const JSON_OUT = option("--json");
const KEEP = args.includes("--keep");
const MODEL = option("--model") ?? "claude-haiku-5-5";
/** `NAME=value …` put before `claude` in the pane: a work tree's recorder and socket folder, for a test server */
const PANE_ENV = option("--pane-env") ?? "";
/** a public LibriSpeech sentence the speech models on this host ship as a test clip */
const CLIP_WAV = option("--clip") ?? join(process.env.HOME ?? "", ".local/share/jarvis-stt/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/test_wavs/0.wav");
const CLIP_WORD = "portrait";

type Outcome = "pass" | "fail" | "skip";
interface Check { name: string; outcome: Outcome; detail: string }
const checks: Check[] = [];
const record = (name: string, outcome: Outcome, detail: string): void => {
  checks.push({ name, outcome, detail });
  console.log(`${outcome === "pass" ? "PASS" : outcome === "fail" ? "FAIL" : "SKIP"}  ${name}${detail ? `: ${detail}` : ""}`);
};

async function herdr(...parts: string[]): Promise<string> {
  const child = Bun.spawn(["herdr", ...parts], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`herdr ${parts[0]} ${parts[1] ?? ""}: ${err.trim() || out.trim()}`);
  return out;
}
const screen = async (pane: string): Promise<string> => herdr("pane", "read", pane, "--source", "visible");
const keys = (pane: string, ...names: string[]) => herdr("pane", "send-keys", pane, ...names);
const text = (pane: string, value: string) => herdr("pane", "send-text", pane, value);
/** types a message and sends it: Claude Code (2.1.318+) ignores a key that comes right after typing */
async function send(pane: string, value: string): Promise<void> {
  await text(pane, value);
  await Bun.sleep(600);
  await keys(pane, "enter");
}

interface Card { id: string; kind: string; question: string; options: { label: string }[]; custom_option_index: number | null; fallback?: boolean }
async function card(pane: string): Promise<Card | null> {
  const response = await fetch(`${BASE}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`);
  if (!response.ok) return null;
  return ((await response.json()) as { prompt: Card | null }).prompt;
}
async function answer(pane: string, body: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${BASE}/api/pane/prompt/answer`, {
    method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ pane_id: pane, ...body }),
  });
  return response.ok ? "ok" : `${response.status} ${await response.text()}`;
}
async function until<T>(read: () => Promise<T | null | false>, ms: number, every = 1000): Promise<T | null> {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    const value = await read().catch(() => null);
    if (value) return value;
    await Bun.sleep(every);
  }
  return null;
}
const lastRows = (value: string, count = 6) => value.split("\n").filter((line) => line.trim()).slice(-count).join(" | ").slice(0, 400);
/** Claude Code's empty prompt at rest: its box, and no spinner's "esc to interrupt" */
const atRest = async (pane: string) => { const shown = await screen(pane); return /^❯/m.test(shown) && !/esc to interrupt/.test(shown) && !(await card(pane)) ? shown : null; };

async function chatText(pane: string): Promise<string> {
  const response = await fetch(`${BASE}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`);
  if (!response.ok) return "";
  const body = await response.json() as { source?: string; turns?: { role: string; parts?: { kind: string; text?: string }[] }[] };
  return `${body.source ?? ""}\n${(body.turns ?? []).map((turn) => `${turn.role}: ${(turn.parts ?? []).map((part) => part.text ?? "").join(" ")}`).join("\n")}`;
}

/** the permission mode Claude Code recorded last in the pane's session transcript */
async function lastMode(pane: string): Promise<string | null> {
  const info = JSON.parse(await herdr("pane", "get", pane)) as { result?: { pane?: { agent_session?: { value?: string } | null } } };
  const id = info.result?.pane?.agent_session?.value;
  if (!id || !/^[\w-]+$/.test(id)) return null;
  const path = [...new Bun.Glob(`*/${id}.jsonl`).scanSync(join(process.env.HOME ?? "", ".claude", "projects"))][0];
  if (!path) return null;
  return lastModeIn(join(process.env.HOME ?? "", ".claude", "projects", path));
}

async function lastModeIn(path: string): Promise<string | null> {
  const modes = [...(await Bun.file(path).text()).matchAll(/"permissionMode":"([a-zA-Z]+)"/g)];
  return modes.at(-1)?.[1] ?? null;
}

async function voiceTake(pane: string): Promise<string> {
  const pcm = join(tmpdir(), `claude-compat-${process.pid}.raw`);
  const convert = Bun.spawn(["ffmpeg", "-loglevel", "error", "-y", "-i", CLIP_WAV, "-ac", "1", "-ar", "16000", "-f", "s16le", pcm]);
  if ((await convert.exited) !== 0) throw new Error("ffmpeg could not read the clip");
  const audio = new Uint8Array(await Bun.file(pcm).arrayBuffer());
  const url = `${BASE.replace(/^http/, "ws")}/api/voice/claude/stream?pane_id=${encodeURIComponent(pane)}`;
  return await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: BASE } } as unknown as string[]);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => { socket.close(); reject(new Error("no final words within 40 s")); }, 40_000);
    socket.onopen = async () => {
      for (let at = 0; at < audio.length; at += 3200) { socket.send(audio.subarray(at, at + 3200)); await Bun.sleep(100); }
      await Bun.sleep(500);
      socket.send(JSON.stringify({ type: "finish" }));
    };
    socket.onmessage = (message) => {
      const event = JSON.parse(String(message.data)) as { type: string; text?: string; code?: string; message?: string };
      if (event.type === "final") { clearTimeout(timer); resolve(event.text ?? ""); }
      if (event.type === "error") { clearTimeout(timer); reject(new Error(`${event.code}: ${event.message}`)); }
    };
    socket.onerror = () => { clearTimeout(timer); reject(new Error("the voice socket failed")); };
  });
}

const version = (await new Response(Bun.spawn(["claude", "--version"], { stdout: "pipe" }).stdout).text()).trim();
console.log(`Claude Code ${version} against ${BASE}`);
const health = await fetch(`${BASE}/api/health`).then((response) => response.json() as Promise<{ web_ui?: { revision?: string } }>).catch(() => null);
if (!health) { record("web UI answers", "fail", `${BASE}/api/health did not answer`); }
const cwd = join(tmpdir(), `claude-compat-${Date.now()}`);
mkdirSync(cwd, { recursive: true });
let workspace = "";
let pane = "";
try {
  if (!health) throw new Error("no web UI");
  const created = JSON.parse(await herdr("workspace", "create", "--cwd", cwd, "--label", "claude-compat", "--no-focus")) as { result: { root_pane: { pane_id: string }; workspace: { workspace_id: string } } };
  workspace = created.result.workspace.workspace_id;
  pane = created.result.root_pane.pane_id;
  await herdr("pane", "run", pane, `${PANE_ENV ? `env ${PANE_ENV} ` : ""}claude --model ${MODEL} --strict-mcp-config --settings '{"voice":{"enabled":true,"mode":"tap"}}'`);
  // a folder Claude Code has not seen asks for trust first: that is a card too
  const first = await until(async () => (await card(pane)) ?? (await atRest(pane) ? "rest" : null), 40_000);
  if (first && first !== "rest") {
    const trust = first as Card;
    record("folder trust card", /trust/i.test(`${trust.question} ${trust.options.map((o) => o.label).join(" ")}`) ? "pass" : "fail", trust.question.slice(0, 120));
    await answer(pane, { prompt_id: trust.id, option_index: 0 });
  }
  if (!(await until(() => atRest(pane), 30_000))) throw new Error(`Claude Code did not start: ${lastRows(await screen(pane))}`);

  // 1. a turn, read back as chat
  await send(pane, "Reply with the single word PINEAPPLE and nothing else.");
  await until(() => atRest(pane), 60_000);
  const chat = await until(async () => { const value = await chatText(pane); return /PINEAPPLE/.test(value) ? value : null; }, 20_000);
  record("chat transcript", chat && /^claude-transcript/.test(chat) ? "pass" : "fail", chat ? "" : `no answer in /api/pane/conversation: ${(await chatText(pane)).slice(0, 160)}`);

  // 2. /model and the switch confirmation
  await send(pane, "/model");
  const models = await until(async () => { const value = await card(pane); return value && /^Select model/.test(value.question) ? value : null; }, 10_000);
  record("/model card", models && models.options.length >= 2 ? "pass" : "fail", models ? `${models.options.length} options` : lastRows(await screen(pane)));
  if (models) {
    const other = models.options.findIndex((model) => /^Sonnet/i.test(model.label));
    if (other >= 0) {
      const result = await answer(pane, { prompt_id: models.id, option_index: other });
      const confirm = await until(async () => { const value = await card(pane); return value && /\?$/.test(value.question) && value.options.length === 2 ? value : null; }, 6_000);
      if (confirm) {
        record("switch-model confirmation card", !confirm.fallback && /^Yes, switch to/.test(confirm.options[0]!.label) ? "pass" : "fail", `${confirm.question} [${confirm.options.map((o) => o.label).join(" / ")}]${confirm.fallback ? " (fallback card)" : ""}`);
        await answer(pane, { prompt_id: confirm.id, option_index: 1 });
      } else record("switch-model confirmation card", "skip", `none shown after the pick (${result}): ${lastRows(await screen(pane), 3)}`);
    }
    await Bun.sleep(800);
    if (await card(pane)) await keys(pane, "esc");
  }
  await until(() => atRest(pane), 10_000);

  // 3. /effort
  await send(pane, "/effort");
  const effort = await until(async () => { const value = await card(pane); return value && /effort/i.test(value.question) ? value : null; }, 10_000);
  record("/effort card", effort && effort.options.some((level) => level.label === "high") ? "pass" : "fail", effort ? effort.options.map((o) => o.label).join(" ") : lastRows(await screen(pane)));
  if (effort) await keys(pane, "esc");
  await until(() => atRest(pane), 10_000);

  // 4. a question
  await send(pane, "Use the AskUserQuestion tool once to ask me which color I like, with the options red, green and blue. Do nothing else.");
  const question = await until(async () => { const value = await card(pane); return value && value.kind === "question" && value.options.length >= 3 ? value : null; }, 60_000, 2000);
  record("question card", question && question.options.some((o) => /green/i.test(o.label)) && !question.fallback ? "pass" : "fail", question ? `${question.question} [${question.options.map((o) => o.label).join(", ")}]` : lastRows(await screen(pane)));
  if (question) await answer(pane, { prompt_id: question.id, option_index: question.options.findIndex((o) => /green/i.test(o.label)) });
  await until(() => atRest(pane), 60_000);

  // 5. the plan card: typed feedback must keep Claude planning, never approve the plan
  for (let tries = 0; tries < 4 && !/plan mode on/.test(await screen(pane)); tries += 1) { await keys(pane, "shift+tab"); await Bun.sleep(700); }
  if (!/plan mode on/.test(await screen(pane))) record("plan card", "skip", "could not reach plan mode with shift+tab");
  else {
    const marker = join(cwd, "hello.txt");
    await send(pane, "Plan how to create a file named hello.txt containing the word hi in this folder. Two steps, then ask me to approve the plan.");
    const plan = await until(async () => { const value = await card(pane); return value && value.kind === "plan" ? value : null; }, 90_000, 2000);
    if (!plan) record("plan card", "fail", lastRows(await screen(pane)));
    else {
      const result = await answer(pane, { prompt_id: plan.id, custom_text: "Add a step that checks the file exists." });
      await Bun.sleep(4000);
      const again = await until(async () => { const value = await card(pane); return value && value.kind === "plan" ? value : (await atRest(pane)) ? { kind: "rest" } as Card : null; }, 90_000, 2000);
      // the footer that says "plan mode on" is under the next plan's dialog: the transcript says the mode
      const stillPlanning = !existsSync(marker) && (again?.kind === "plan" || /plan mode on/.test(await screen(pane))) && (await lastMode(pane)) === "plan";
      record("plan card", result === "ok" && stillPlanning ? "pass" : "fail", `answer ${result}; ${stillPlanning ? "still planning, nothing created" : "the plan was approved or a file was made"}; after: ${again?.kind ?? "nothing"}`);
      if (again?.kind === "plan") await keys(pane, "esc");
    }
    await until(() => atRest(pane), 30_000);
  }

  // 6. Claude voice
  const status = await fetch(`${BASE}/api/voice/claude`).then((response) => response.json() as Promise<{ available: boolean; reason: string | null }>).catch(() => null);
  if (!status?.available) record("Claude voice", "skip", `not available on this server (${status?.reason ?? "no answer"})`);
  else if (!existsSync(CLIP_WAV)) record("Claude voice", "skip", `no test clip at ${CLIP_WAV}`);
  else {
    try {
      const words = await voiceTake(pane);
      const box = await screen(pane);
      record("Claude voice", words.toLowerCase().includes(CLIP_WORD) && !box.includes(words.slice(0, 20)) ? "pass" : "fail", `"${words.slice(0, 120)}"`);
    } catch (error) {
      record("Claude voice", "fail", error instanceof Error ? error.message : String(error));
    }
  }
} catch (error) {
  record("probe", "fail", error instanceof Error ? error.message : String(error));
} finally {
  if (workspace && !KEEP) await herdr("workspace", "close", workspace).catch(() => undefined);
}

const failed = checks.filter((check) => check.outcome === "fail");
const report = { claude_code: version, web_ui: health?.web_ui?.revision ?? null, url: BASE, at: new Date().toISOString(), passed: failed.length === 0, checks };
if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(failed.length === 0 ? "all checks passed" : `${failed.length} check(s) failed`);
process.exit(failed.length === 0 ? 0 : 1);
