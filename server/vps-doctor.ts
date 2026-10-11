/**
 * The VPS Doctor: what fixes an issue server/vps.ts found.
 *
 * Built in, it offers fixed, reviewed actions and runs only the ones the user ticks: cleanup
 * items a scan measured (the browser names an item by its id, never by a path: the paths stay
 * here), and stopping a process or closing the herdr pane that runs it. With an AI engine it
 * opens a "VPS Doctor" workspace and starts Claude Code or Codex there, with the model and
 * effort the user picked, on a brief that holds the numbers and says to ask before changing
 * anything.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize } from "node:path";

import type {
  DiskCandidate,
  DiskCleanItem,
  DiskCleanResult,
  DiskFolder,
  DiskScan,
  DoctorAgentRequest,
  DoctorAgentResult,
  DoctorEngineInfo,
  DoctorModel,
  DoctorOptions,
  DoctorPane,
  DoctorProcess,
  DoctorProcesses,
  ProcessAction,
  ProcessActionResult,
  VpsDisk,
  VpsStatus,
} from "../shared/vps.ts";
import { herdrRpc, paneClose, sessionSnapshot, workspaceCreate } from "./herdr/client.ts";
import { formatBytes, type ProcessRow, type VpsMonitor } from "./vps.ts";

export class DoctorError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export interface DoctorContext {
  monitor: VpsMonitor;
  stateDir: string;
  /** the user's home; tests point it elsewhere */
  home?: string;
  codexHome?: string;
  /** starts an agent in a pane herdr just made (index.ts `agentLaunch`) */
  launchAgent(paneId: string, agent: { kind: string; args: string[] }): Promise<{ agent_started: boolean; error?: { code: string; message: string } }>;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A bounded child process; a missing program answers code null rather than throwing. */
export async function run(argv: string[], timeoutMs = 60_000): Promise<CommandResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C" } });
  } catch (error) {
    return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Sizes the `du` CLI measures, keyed by path; what it cannot read counts what it could. */
async function du(paths: string[], root: boolean): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (let start = 0; start < paths.length; start += 200) {
    const chunk = paths.slice(start, start + 200);
    const result = await run([...(root ? ["sudo", "-n"] : []), "du", "-sb", "--", ...chunk], 120_000);
    for (const line of result.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0) sizes.set(line.slice(tab + 1), Number(line.slice(0, tab)));
    }
  }
  return sizes;
}

function sum(sizes: Map<string, number>): number {
  let total = 0;
  for (const value of sizes.values()) total += value;
  return total;
}

function listDir(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

function isDir(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

/** Regular files under `root` last written before `cutoff`, with their sizes. */
function oldFiles(root: string, cutoff: number, keep: (path: string) => boolean = () => true, limit = 200_000): { paths: string[]; bytes: number } {
  const paths: string[] = [];
  let bytes = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || paths.length >= limit) return;
    for (const name of listDir(dir)) {
      const path = join(dir, name);
      let stats;
      try { stats = lstatSync(path); } catch { continue; }
      if (stats.isDirectory()) { if (keep(path)) walk(path, depth + 1); continue; }
      if (!stats.isFile() || stats.mtimeMs >= cutoff || !keep(path)) continue;
      paths.push(path);
      bytes += stats.size;
    }
  };
  walk(root, 0);
  return { paths, bytes };
}

/** Parses the sizes docker prints ("502.4MB", "1.2GB", "0B"). */
export function parseDockerSize(value: string): number {
  const match = /^([\d.]+)\s*([kKMGT]?)i?B/.exec(value.trim());
  if (!match) return 0;
  const scale: Record<string, number> = { "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
  return Math.round(Number(match[1]) * (scale[match[2] ?? ""] ?? 1));
}

/** Parses `journalctl --disk-usage` ("... take up 169.7M in the file system."). */
export function parseJournalUsage(text: string): number {
  const match = /take up ([\d.]+)([BKMGT])/.exec(text);
  if (!match) return 0;
  const scale: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.round(Number(match[1]) * (scale[match[2] ?? "B"] ?? 1));
}

/** What a journal vacuum keeps */
const JOURNAL_KEEP_BYTES = 200 * 1024 ** 2;
/** files at least this big are listed one by one for the user to judge */
const LARGE_FILE_BYTES = 200 * 1024 ** 2;
const LARGE_FILES = 15;
const TMP_DAYS = 7;
/** never listed, never deleted: the system, live mounts, container stores and swap */
const PROTECTED_PREFIXES = ["/proc", "/sys", "/dev", "/run", "/boot", "/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc", "/snap", "/var/lib/docker", "/var/lib/containerd", "/var/lib/dpkg", "/var/lib/apt", "/root/.ssh"];
const TMP_SKIP = ["/tmp/claude-", "/tmp/systemd-private-", "/tmp/snap-private-tmp", "/tmp/.X11-unix", "/tmp/.ICE-unix", "/tmp/tmux-", "/tmp/node-compile-cache"];

function underAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

type Plan =
  | { kind: "paths"; paths: string[]; root: boolean }
  | { kind: "commands"; commands: string[][]; root: boolean };

interface StoredScan {
  at: number;
  plans: Map<string, Plan>;
}

const CLAUDE_MODELS: DoctorModel[] = [
  { id: "fable", label: "Fable (latest)", efforts: [], default_effort: null },
  { id: "opus", label: "Opus", efforts: [], default_effort: null },
  { id: "sonnet", label: "Sonnet", efforts: [], default_effort: null },
  { id: "haiku", label: "Haiku", efforts: [], default_effort: null },
];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_NAMES = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
/** model ids the CLIs take: aliases, slugs and full names, never anything a shell would read */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,80}$/;

export class VpsDoctor {
  private readonly home: string;
  private readonly codexHome: string;
  private scans = new Map<string, StoredScan>();
  private rootChecked: { at: number; ok: boolean } | null = null;

  constructor(private readonly ctx: DoctorContext) {
    this.home = ctx.home ?? homedir();
    this.codexHome = ctx.codexHome ?? process.env["CODEX_HOME"] ?? join(this.home, ".codex");
  }

  /** Whether `sudo` runs without asking for a password (checked at most every five minutes). */
  async root(): Promise<boolean> {
    if (this.rootChecked && Date.now() - this.rootChecked.at < 5 * 60_000) return this.rootChecked.ok;
    const ok = (await run(["sudo", "-n", "true"], 10_000)).code === 0;
    this.rootChecked = { at: Date.now(), ok };
    return ok;
  }

  private log(line: string): void {
    try {
      mkdirSync(this.ctx.stateDir, { recursive: true, mode: 0o700 });
      appendFileSync(join(this.ctx.stateDir, "vps-doctor.log"), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      /* the log is a courtesy; the action's answer says what happened */
    }
  }

  async options(): Promise<DoctorOptions> {
    const engines: DoctorEngineInfo[] = [this.claudeEngine(), this.codexEngine()];
    return { engines, root: await this.root() };
  }

  private claudeEngine(): DoctorEngineInfo {
    let configured: string | null = null;
    try {
      const settings = JSON.parse(readFileSync(join(this.home, ".claude", "settings.json"), "utf8")) as { model?: unknown };
      if (typeof settings.model === "string" && MODEL_ID.test(settings.model)) configured = settings.model;
    } catch {
      /* no settings: the CLI's own default */
    }
    return {
      engine: "claude",
      label: "Claude Code",
      available: Bun.which("claude") !== null,
      default_model: configured,
      models: CLAUDE_MODELS.map((model) => ({ ...model, efforts: CLAUDE_EFFORTS })),
    };
  }

  private codexEngine(): DoctorEngineInfo {
    let defaultModel: string | null = null;
    let defaultEffort: string | null = null;
    try {
      const config = readFileSync(join(this.codexHome, "config.toml"), "utf8");
      // top-level keys only: a profile's model is that profile's
      const top = config.split(/^\[/m)[0] ?? "";
      defaultModel = /^model\s*=\s*"([^"]+)"/m.exec(top)?.[1] ?? null;
      defaultEffort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(top)?.[1] ?? null;
    } catch {
      /* no config */
    }
    const models: DoctorModel[] = [];
    try {
      const cache = JSON.parse(readFileSync(join(this.codexHome, "models_cache.json"), "utf8")) as { models?: unknown };
      for (const entry of Array.isArray(cache.models) ? cache.models : []) {
        const model = entry as { slug?: unknown; display_name?: unknown; visibility?: unknown; supported_reasoning_levels?: unknown; default_reasoning_level?: unknown };
        if (typeof model.slug !== "string" || !MODEL_ID.test(model.slug) || model.visibility === "hide" || model.slug.includes("auto-review")) continue;
        const efforts = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
          .map((level) => (level as { effort?: unknown }).effort)
          .filter((effort): effort is string => typeof effort === "string" && EFFORT_NAMES.has(effort));
        models.push({
          id: model.slug,
          label: typeof model.display_name === "string" ? model.display_name : model.slug,
          efforts,
          default_effort: typeof model.default_reasoning_level === "string" ? model.default_reasoning_level : null,
        });
      }
    } catch {
      /* no cache yet: the configured model alone */
    }
    if (defaultModel && !models.some((model) => model.id === defaultModel)) {
      models.unshift({ id: defaultModel, label: defaultModel, efforts: ["low", "medium", "high", "xhigh"], default_effort: defaultEffort });
    }
    // the configured effort is the default for the configured model
    for (const model of models) if (model.id === defaultModel && defaultEffort && model.efforts.includes(defaultEffort)) model.default_effort = defaultEffort;
    return { engine: "codex", label: "Codex", available: Bun.which("codex") !== null, default_model: defaultModel, models };
  }

  // ── disk ────────────────────────────────────────────────────────────────────────────────

  async scanDisk(olderThanDays: number): Promise<DiskScan> {
    const days = Number.isInteger(olderThanDays) && olderThanDays >= 1 && olderThanDays <= 3650 ? olderThanDays : 30;
    const root = await this.root();
    const cutoff = Date.now() - days * 86_400_000;
    const candidates: DiskCandidate[] = [];
    const plans = new Map<string, Plan>();
    const add = (candidate: Omit<DiskCandidate, "selected"> & { selected?: boolean }, plan: Plan): void => {
      if (candidate.bytes !== null && candidate.bytes <= 0) return;
      candidates.push({ ...candidate, selected: candidate.selected ?? candidate.risk === "safe" });
      plans.set(candidate.id, plan);
    };
    const home = this.home;
    const own = this.ctx.monitor.reader.ownUid();

    const [folders, large] = await Promise.all([this.bigFolders(root), this.largeFiles(root)]);

    // ── system (root) ──
    if (existsSync("/var/cache/apt")) {
      const size = sum(await du(["/var/cache/apt/archives"], false));
      add({ id: "apt-cache", group: "system", label: "Package downloads (apt cache)", detail: "Installer files apt keeps after installing. apt downloads them again if it needs them.", bytes: size, risk: "safe", root: true, preview: ["apt-get clean"] },
        { kind: "commands", commands: [["apt-get", "clean"]], root: true });
    }
    if (Bun.which("journalctl")) {
      const usage = parseJournalUsage((await run([...(root ? ["sudo", "-n"] : []), "journalctl", "--disk-usage"], 30_000)).stdout);
      add({ id: "journal", group: "system", label: "Old system logs (journal)", detail: `Keeps the newest ${formatBytes(JOURNAL_KEEP_BYTES)} of system logs and drops older entries.`, bytes: Math.max(0, usage - JOURNAL_KEEP_BYTES), risk: "safe", root: true, preview: ["journalctl --vacuum-size=200M"] },
        { kind: "commands", commands: [["journalctl", "--vacuum-size=200M"]], root: true });
    }
    if (Bun.which("docker")) {
      const prefix = root ? ["sudo", "-n"] : [];
      const df = await run([...prefix, "docker", "system", "df", "--format", "{{json .}}"], 60_000);
      let build = 0;
      for (const line of df.stdout.split("\n")) {
        try {
          const row = JSON.parse(line) as { Type?: string; Reclaimable?: string };
          if (row.Type === "Build Cache" && row.Reclaimable) build += parseDockerSize(row.Reclaimable);
        } catch { /* not a row */ }
      }
      const dangling = await run([...prefix, "docker", "images", "-f", "dangling=true", "--format", "{{.Size}}"], 60_000);
      const images = dangling.stdout.split("\n").filter(Boolean).reduce((total, size) => total + parseDockerSize(size), 0);
      add({ id: "docker", group: "system", label: "Docker build cache and untagged images", detail: "Leftover layers from builds. Tagged images, containers and volumes are kept.", bytes: build + images, risk: "safe", root: true, preview: ["docker image prune -f", "docker builder prune -f"] },
        { kind: "commands", commands: [["docker", "image", "prune", "-f"], ["docker", "builder", "prune", "-f"]], root: true });
    }
    {
      const tmpCutoff = Date.now() - TMP_DAYS * 86_400_000;
      const keep = (path: string): boolean => !TMP_SKIP.some((skip) => path.startsWith(skip));
      const files = [oldFiles("/tmp", tmpCutoff, keep), oldFiles("/var/tmp", tmpCutoff, keep)];
      // only this user's files: the rest belong to services that may still want them
      const mine = files.flatMap((found) => found.paths).filter((path) => { try { return lstatSync(path).uid === own; } catch { return false; } });
      let bytes = 0;
      for (const path of mine) { try { bytes += lstatSync(path).size; } catch { /* gone */ } }
      add({ id: "tmp-old", group: "system", label: `Temporary files older than ${TMP_DAYS} days`, detail: "Your files in /tmp and /var/tmp nobody has written for a week.", bytes, risk: "safe", root: false, preview: mine.slice(0, 5) },
        { kind: "paths", paths: mine, root: false });
    }

    // ── caches ──
    {
      const paths = [join(home, ".npm", "_cacache"), join(home, ".bun", "install", "cache"), join(home, ".cache", "pip"), join(home, ".cache", "yarn"), join(home, ".cache", "pnpm"), join(home, ".cache", "go-build"), join(home, ".cache", "node-gyp")].filter(isDir);
      const sizes = await du(paths, false);
      add({ id: "package-caches", group: "caches", label: "Package manager caches (npm, bun, pip…)", detail: "Downloaded packages kept for faster installs. They download again when needed.", bytes: sum(sizes), risk: "safe", root: false, preview: paths },
        { kind: "paths", paths, root: false });
    }
    {
      const dir = join(home, ".cache", "ms-playwright");
      const builds = listDir(dir).flatMap((name) => { const match = /^(.*)-(\d+)$/.exec(name); return match ? [{ name, family: match[1]!, revision: Number(match[2]) }] : []; });
      const newest = new Map<string, number>();
      for (const build of builds) newest.set(build.family, Math.max(newest.get(build.family) ?? 0, build.revision));
      const old = builds.filter((build) => build.revision < (newest.get(build.family) ?? 0)).map((build) => join(dir, build.name));
      add({ id: "browser-builds", group: "caches", label: "Old browser builds (Playwright)", detail: "Older Chromium/Firefox builds; the newest of each is kept. A project pinned to an older one downloads it again.", bytes: sum(await du(old, false)), risk: "caution", root: false, preview: old.map((path) => basename(path)) },
        { kind: "paths", paths: old, root: false });
    }
    {
      const old: string[] = [];
      const claudeDir = join(home, ".local", "share", "claude", "versions");
      const claudeVersions = listDir(claudeDir).map((name) => join(claudeDir, name));
      let claudeCurrent: string | null = null;
      try { claudeCurrent = realpathSync(join(home, ".local", "bin", "claude")); } catch { /* not installed that way */ }
      const claudeNewest = [...claudeVersions].sort((a, b) => { try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; } })[0];
      if (claudeCurrent) old.push(...claudeVersions.filter((path) => path !== claudeCurrent && path !== claudeNewest));
      const codexDir = join(this.codexHome, "packages", "standalone", "releases");
      let codexCurrent: string | null = null;
      try { codexCurrent = realpathSync(join(this.codexHome, "packages", "standalone", "current")); } catch { /* not the standalone install */ }
      if (codexCurrent) old.push(...listDir(codexDir).map((name) => join(codexDir, name)).filter((path) => path !== codexCurrent));
      add({ id: "agent-versions", group: "caches", label: "Old Claude Code and Codex versions", detail: "Previous versions their updaters left behind; the one in use is kept.", bytes: sum(await du(old, false)), risk: "safe", root: false, preview: old.map((path) => basename(path)) },
        { kind: "paths", paths: old, root: false });
    }

    // ── history ──
    {
      const sessions = [oldFiles(join(this.codexHome, "sessions"), cutoff), oldFiles(join(this.codexHome, "archived_sessions"), cutoff)];
      const paths = sessions.flatMap((found) => found.paths);
      add({ id: "codex-history", group: "history", label: `Codex conversations older than ${days} days`, detail: "Old Codex sessions can no longer be resumed or read in chat afterwards.", bytes: sessions.reduce((total, found) => total + found.bytes, 0), risk: "caution", root: false, selected: false, preview: paths.slice(0, 5).map((path) => path.replace(home, "~")) },
        { kind: "paths", paths, root: false });
    }
    {
      const projects = join(home, ".claude", "projects");
      const paths: string[] = [];
      const folders: string[] = [];
      let bytes = 0;
      for (const project of listDir(projects)) {
        const dir = join(projects, project);
        for (const name of listDir(dir)) {
          if (!name.endsWith(".jsonl")) continue;
          const path = join(dir, name);
          let stats;
          try { stats = statSync(path); } catch { continue; }
          if (stats.mtimeMs >= cutoff) continue;
          paths.push(path);
          bytes += stats.size;
          // the session's own folder (subagents, tool output) goes with it
          const folder = join(dir, name.slice(0, -".jsonl".length));
          if (isDir(folder)) folders.push(folder);
        }
      }
      bytes += sum(await du(folders, false));
      paths.push(...folders);
      add({ id: "claude-history", group: "history", label: `Claude Code conversations older than ${days} days`, detail: "Old Claude sessions can no longer be resumed or read in chat afterwards.", bytes, risk: "caution", root: false, selected: false, preview: paths.slice(0, 5).map((path) => path.replace(home, "~")) },
        { kind: "paths", paths, root: false });
    }
    {
      const dir = join(this.codexHome, "generated_images");
      const old = listDir(dir).map((name) => join(dir, name)).filter((path) => { try { return statSync(path).mtimeMs < cutoff; } catch { return false; } });
      add({ id: "codex-images", group: "history", label: `Images Codex generated, older than ${days} days`, detail: "Pictures Codex made in past sessions. Copies you saved elsewhere stay.", bytes: sum(await du(old, false)), risk: "caution", root: false, selected: false, preview: old.slice(0, 5).map((path) => path.replace(home, "~")) },
        { kind: "paths", paths: old, root: false });
    }

    // ── large files, one by one ──
    large.forEach((file, index) => {
      const mine = (() => { try { return lstatSync(file.path).uid === own; } catch { return false; } })();
      add({ id: `file:${index}`, group: "large-files", label: file.path.replace(home, "~"), detail: mine ? "A large file. Delete it only if you know you no longer need it." : "A large file owned by another user (deleted with sudo). Delete it only if you know what it is.", bytes: file.bytes, risk: "danger", root: !mine, selected: false, preview: [file.path] },
        { kind: "paths", paths: [file.path], root: !mine });
    });

    const scanId = randomBytes(8).toString("hex");
    this.scans.set(scanId, { at: Date.now(), plans });
    // the last few scans only: an old one names paths that may hold new files by now
    for (const [id, scan] of this.scans) if (Date.now() - scan.at > 30 * 60_000 || this.scans.size > 5) { if (id !== scanId) this.scans.delete(id); }
    return { scan_id: scanId, scanned_at: Date.now(), older_than_days: days, disk: this.rootDisk(), candidates, folders };
  }

  private rootDisk(): VpsDisk | null {
    const disks = this.ctx.monitor.sample().disks;
    return disks.find((disk) => disk.mount === "/") ?? disks[0] ?? null;
  }

  private async bigFolders(root: boolean): Promise<DiskFolder[]> {
    const roots = [this.home, "/opt", "/var", "/srv", "/root"].filter(isDir);
    const result = await run([...(root ? ["sudo", "-n"] : []), "du", "-xb", "-d", "2", "--", ...roots], 180_000);
    const folders: DiskFolder[] = [];
    for (const line of result.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      if (tab <= 0) continue;
      const path = line.slice(tab + 1);
      if (roots.includes(path)) continue;
      folders.push({ path, bytes: Number(line.slice(0, tab)) });
    }
    // a folder whose child holds nearly all of it says nothing the child does not
    folders.sort((a, b) => b.bytes - a.bytes);
    return folders.slice(0, 15);
  }

  private async largeFiles(root: boolean): Promise<{ path: string; bytes: number }[]> {
    const swaps = new Set<string>();
    try { for (const line of readFileSync("/proc/swaps", "utf8").split("\n").slice(1)) { const path = line.split(/\s+/)[0]; if (path) swaps.add(path); } } catch { /* none */ }
    const roots = ["/home", "/opt", "/var", "/srv", "/tmp", "/root", "/mnt", "/data"].filter(isDir);
    const result = await run([...(root ? ["sudo", "-n"] : []), "find", ...roots, "-xdev", "-type", "f", "-size", `+${Math.floor(LARGE_FILE_BYTES / 1024 / 1024)}M`, "-printf", "%s\t%p\n"], 120_000);
    return result.stdout.split("\n").flatMap((line) => {
      const tab = line.indexOf("\t");
      if (tab <= 0) return [];
      const path = line.slice(tab + 1);
      if (swaps.has(path) || underAny(path, PROTECTED_PREFIXES) || /^\/swap/.test(path)) return [];
      return [{ path, bytes: Number(line.slice(0, tab)) }];
    }).sort((a, b) => b.bytes - a.bytes).slice(0, LARGE_FILES);
  }

  /** Whether a path the scan planned may still be deleted: never a protected place or a bare root. */
  private deletable(path: string, root: boolean): boolean {
    if (!isAbsolute(path) || normalize(path) !== path) return false;
    if (underAny(path, PROTECTED_PREFIXES)) return false;
    const bare = new Set(["/", "/home", "/opt", "/var", "/tmp", "/var/tmp", "/srv", "/root", this.home, join(this.home, ".cache"), join(this.home, ".local"), this.codexHome, join(this.home, ".claude")]);
    if (bare.has(path)) return false;
    if (root) return true;
    return underAny(path, [this.home, "/tmp", "/var/tmp", "/opt", "/srv"]);
  }

  async cleanDisk(scanId: string, ids: string[]): Promise<DiskCleanResult> {
    const scan = this.scans.get(scanId);
    if (!scan) throw new DoctorError("scan_expired", "That scan has expired. Scan again.", 409);
    const root = await this.root();
    const available = (): number => this.ctx.monitor.sample().disks.reduce((total, disk) => total + disk.available_bytes, 0);
    const before = available();
    const results: DiskCleanItem[] = [];
    for (const id of ids) {
      const plan = scan.plans.get(id);
      if (!plan) { results.push({ id, ok: false, message: "Not in that scan" }); continue; }
      if (plan.root && !root) { results.push({ id, ok: false, message: "Needs passwordless sudo" }); continue; }
      try {
        if (plan.kind === "commands") {
          const failures: string[] = [];
          for (const command of plan.commands) {
            const result = await run([...(plan.root ? ["sudo", "-n"] : []), ...command], 300_000);
            if (result.code !== 0) failures.push(`${command.join(" ")}: ${(result.stderr || result.stdout).trim().split("\n").at(-1) ?? "failed"}`);
          }
          results.push({ id, ok: failures.length === 0, message: failures.length ? failures.join("; ") : "Done" });
        } else {
          const allowed = plan.paths.filter((path) => this.deletable(path, plan.root));
          let removed = 0;
          const errors: string[] = [];
          if (plan.root) {
            for (let start = 0; start < allowed.length; start += 200) {
              const chunk = allowed.slice(start, start + 200);
              const result = await run(["sudo", "-n", "rm", "-rf", "--", ...chunk], 300_000);
              if (result.code === 0) removed += chunk.length; else errors.push(result.stderr.trim().split("\n").at(-1) ?? "rm failed");
            }
          } else {
            for (const path of allowed) {
              try { rmSync(path, { recursive: true, force: true }); removed += 1; } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
            }
          }
          const skipped = plan.paths.length - allowed.length;
          results.push({ id, ok: errors.length === 0, message: `Removed ${removed} of ${plan.paths.length}${skipped ? ` (${skipped} protected, kept)` : ""}${errors.length ? `; ${errors.slice(0, 2).join("; ")}` : ""}` });
        }
      } catch (error) {
        results.push({ id, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      const last = results.at(-1)!;
      this.log(`clean ${id} ${last.ok ? "ok" : "failed"}: ${last.message}`);
      // a path list is used once: a second click must not delete what was written there since
      scan.plans.delete(id);
    }
    const freed = Math.max(0, available() - before);
    return { freed_bytes: freed, results, disk: this.rootDisk() };
  }

  // ── processes ───────────────────────────────────────────────────────────────────────────

  /** Pane per shell pid, from herdr; empty when herdr does not answer. */
  private async paneShells(): Promise<Map<number, DoctorPane>> {
    const shells = new Map<number, DoctorPane>();
    try {
      const snapshot = await sessionSnapshot();
      const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.workspace_id, workspace.label]));
      await Promise.all(snapshot.panes.map(async (pane) => {
        try {
          const info = await herdrRpc<{ process_info?: { shell_pid?: number } }>("pane.process_info", { pane_id: pane.pane_id });
          const pid = info.process_info?.shell_pid;
          if (typeof pid !== "number") return;
          shells.set(pid, {
            pane_id: pane.pane_id,
            workspace_id: pane.workspace_id,
            workspace: workspaces.get(pane.workspace_id) ?? pane.workspace_id,
            title: pane.terminal_title_stripped ?? pane.terminal_title ?? pane.cwd ?? pane.pane_id,
            agent: pane.agent ?? null,
            status: String(pane.agent_status),
          });
        } catch { /* a pane closing meanwhile */ }
      }));
    } catch {
      /* herdr unreachable: processes without panes */
    }
    return shells;
  }

  private paneOf(row: ProcessRow, parents: Map<number, number>, shells: Map<number, DoctorPane>): DoctorPane | null {
    let pid: number | undefined = row.pid;
    for (let step = 0; pid !== undefined && pid > 1 && step < 64; step += 1) {
      const pane = shells.get(pid);
      if (pane) return pane;
      pid = parents.get(pid);
    }
    return null;
  }

  async processes(): Promise<DoctorProcesses> {
    const monitor = this.ctx.monitor;
    const status: VpsStatus = monitor.status();
    const reader = monitor.reader;
    const rows = reader.processes();
    const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
    const shells = await this.paneShells();
    const own = reader.ownUid();
    const cpu = (row: ProcessRow): number => monitor.cpuOf(row.pid, row.start_ticks);
    const byMemory = [...rows].sort((a, b) => b.rss_bytes - a.rss_bytes).slice(0, 12);
    const byCpu = [...rows].sort((a, b) => cpu(b) - cpu(a)).slice(0, 8);
    const picked = [...new Map([...byMemory, ...byCpu].map((row) => [row.pid, row])).values()];
    const processes: DoctorProcess[] = picked.map((row) => ({
      pid: row.pid,
      user: reader.userName(row.uid),
      name: row.name,
      command: reader.command(row.pid) || `[${row.name}]`,
      cpu_percent: cpu(row),
      rss_bytes: row.rss_bytes,
      own: row.uid === own,
      start_ticks: row.start_ticks,
      pane: this.paneOf(row, parents, shells),
    })).sort((a, b) => b.rss_bytes - a.rss_bytes);
    return { processes, memory: status.memory, swap: status.swap, cpu: status.cpu };
  }

  /** This server, the processes above it and herdr's own server: stopping one takes the app down with it. */
  private untouchable(row: ProcessRow, rows: ProcessRow[]): boolean {
    if (row.pid <= 1 || row.pid === process.pid) return true;
    const parents = new Map(rows.map((entry) => [entry.pid, entry.ppid]));
    for (let pid: number | undefined = process.ppid, step = 0; pid !== undefined && pid > 1 && step < 64; pid = parents.get(pid), step += 1) {
      if (pid === row.pid) return true;
    }
    const command = this.ctx.monitor.reader.command(row.pid) ?? "";
    return /(^|\/)herdr server\b/.test(command) || /herdr-web-ui.*server\/(managed|supervisor|index)\.ts/.test(command);
  }

  async processAction(pid: number, startTicks: number, action: ProcessAction): Promise<ProcessActionResult> {
    const reader = this.ctx.monitor.reader;
    const rows = reader.processes();
    const row = rows.find((entry) => entry.pid === pid && entry.start_ticks === startTicks);
    if (!row) return { ok: false, message: "That process has already exited." };
    if (this.untouchable(row, rows)) return { ok: false, message: "This process keeps herdr or this app running; the Doctor leaves it alone." };
    if (action === "close-pane") {
      const pane = this.paneOf(row, new Map(rows.map((entry) => [entry.pid, entry.ppid])), await this.paneShells());
      if (!pane) return { ok: false, message: "No herdr pane runs this process." };
      await paneClose(pane.pane_id);
      this.log(`close-pane ${pane.pane_id} (${pane.title}) for pid ${pid}`);
      return { ok: true, message: `Closed pane ${pane.title}` };
    }
    if (row.uid !== reader.ownUid()) return { ok: false, message: `It belongs to ${reader.userName(row.uid)}: ask the AI Doctor to look into it.` };
    try {
      process.kill(pid, action === "kill" ? "SIGKILL" : "SIGTERM");
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    this.log(`${action} pid ${pid} (${row.name})`);
    return { ok: true, message: action === "kill" ? `Force-stopped ${row.name}` : `Asked ${row.name} to stop` };
  }

  // ── AI doctor ───────────────────────────────────────────────────────────────────────────

  async startAgent(request: DoctorAgentRequest): Promise<DoctorAgentResult> {
    const options = await this.options();
    const engine = options.engines.find((entry) => entry.engine === request.engine);
    if (!engine) throw new DoctorError("invalid_engine", "engine must be claude or codex");
    if (!engine.available) throw new DoctorError("engine_unavailable", `${engine.label} is not installed on this PC`);
    if (request.model !== null && !MODEL_ID.test(request.model)) throw new DoctorError("invalid_model", "that model name is not one the CLI takes");
    if (request.effort !== null && !EFFORT_NAMES.has(request.effort)) throw new DoctorError("invalid_effort", "effort must be one of minimal, low, medium, high, xhigh, max, ultra");
    const status = this.ctx.monitor.sample();
    const issue = request.issue_id === null ? null : status.issues.find((entry) => entry.id === request.issue_id) ?? null;
    const brief = this.brief(status, issue, request.note.trim().slice(0, 4000), await this.root());
    const dir = join(this.ctx.stateDir, "doctor");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const briefPath = join(dir, `brief-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    writeFileSync(briefPath, brief, { mode: 0o600 });

    const created = await workspaceCreate({ cwd: this.home, label: "VPS Doctor" });
    const paneId = created.root_pane.pane_id;
    const prompt = `You are the VPS Doctor for this server. Read ${briefPath} and follow it.`;
    const args = request.engine === "claude"
      ? [...(request.model ? ["--model", request.model] : []), ...(request.effort ? ["--effort", request.effort] : []), prompt]
      : [...(request.model ? ["-m", request.model] : []), ...(request.effort ? ["-c", `model_reasoning_effort=${request.effort}`] : []), prompt];
    const launched = await this.ctx.launchAgent(paneId, { kind: request.engine, args });
    this.log(`agent ${request.engine} ${request.model ?? "default"}/${request.effort ?? "default"} for ${issue?.id ?? "check-up"} in ${paneId}: ${launched.agent_started ? "started" : launched.error?.message ?? "failed"}`);
    return {
      pane_id: paneId,
      workspace_id: created.workspace.workspace_id,
      agent_started: launched.agent_started,
      brief_path: briefPath,
      ...(launched.error ? { error: launched.error } : {}),
    };
  }

  /** The Markdown brief the agent reads first. */
  brief(status: VpsStatus, issue: VpsStatus["issues"][number] | null, note: string, root: boolean): string {
    const lines: string[] = [];
    const disks = status.disks.map((disk) => `- ${disk.mount} (${disk.device}): ${disk.used_percent}% used, ${formatBytes(disk.available_bytes)} free of ${formatBytes(disk.total_bytes)}`);
    const top = status.top.map((proc) => `- pid ${proc.pid} ${proc.user} ${proc.name}: ${proc.cpu_percent}% CPU, ${formatBytes(proc.rss_bytes)} RSS — ${proc.command.slice(0, 160)}`);
    lines.push(
      "# VPS Doctor brief",
      "",
      `You were started from herdr web ui's VPS status on ${status.hostname} to fix a problem with the server itself. The user follows this pane from a browser or a phone, where your questions show as cards they answer by tapping.`,
      "",
      "## The problem",
      issue ? `**${issue.title}** (${issue.severity}) — ${issue.detail}. First seen ${new Date(issue.since).toISOString()}.` : "No single issue was picked: give the server a general check-up.",
      "",
      "## What the user asked",
      note || "(nothing beyond fixing the problem)",
      "",
      `## Status at ${new Date(status.sampled_at).toISOString()}`,
      `- CPU: ${status.cpu.usage_percent}% now, ${status.cpu.average_percent}% over 5 min, load ${status.cpu.load.join(" ")} on ${status.cpu.cores} cores`,
      `- Memory: ${status.memory.used_percent}% used, ${formatBytes(status.memory.available_bytes)} available of ${formatBytes(status.memory.total_bytes)}`,
      `- Swap: ${status.swap.used_percent}% used (${formatBytes(status.swap.used_bytes)} of ${formatBytes(status.swap.total_bytes)})`,
      ...disks,
      `- Open issues: ${status.issues.length ? status.issues.map((entry) => `${entry.title} (${entry.severity})`).join("; ") : "none"}`,
      "",
      "Heaviest processes:",
      ...top,
      "",
      "## How to work",
      "1. Investigate first with read-only commands (du, df, ps, free, journalctl, docker system df, herdr agent list …). Find the real cause, not only the symptom.",
      "2. Then present a short numbered list of options: what each does, how much it frees or saves, and its risk. **Ask the user which to do and wait for the answer.** Never decide alone.",
      "3. Ask again, naming the exact items, before anything destructive: deleting files, stopping or killing processes, closing herdr panes or agents (`herdr pane close`, `herdr agent list`), restarting services, changing configuration.",
      "4. Never touch, without the user naming that exact item: project and client folders, anything under ~/.ssh, credentials or tokens, databases, Docker volumes or containers that serve production.",
      "5. Never stop the herdr server, herdr web ui, tailscaled or sshd: the user reaches this pane through them.",
      `6. ${root ? "sudo works without a password here; use it only for system items." : "sudo is not available without a password; tell the user when a fix needs root."}`,
      "7. Prefer fixes that can be undone, and say how to undo them.",
      "8. When done, measure again and report the before and after numbers in one short summary.",
    );
    try {
      const notes = readFileSync(join(this.ctx.stateDir, "doctor-notes.md"), "utf8").trim();
      if (notes) lines.push("", "## Notes from the server's owner", notes);
    } catch {
      /* no owner notes */
    }
    return `${lines.join("\n")}\n`;
  }
}
