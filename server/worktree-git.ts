/**
 * git itself, for what herdr's worktree API does not do: a checkout a tab (not a workspace) opens
 * in, what a checkout holds that the repository's main checkout lacks, the merge of its branch
 * into that checkout, and the checkout's deletion with its branch. herdr still names the
 * repository and its checkouts (`worktree.list`); nothing here opens, closes or reads a pane.
 *
 * Every command is argv, bounded in time, and never asks a terminal anything. A merge that
 * conflicts is taken back before the answer: the main checkout is never left mid-merge.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { WorktreeMerged, WorktreeStatus } from "../shared/protocol.ts";

/** A refusal in git's own words, under a code the client can act on. Answered as a 409. */
export class WorktreeGitError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorktreeGitError";
    this.code = code;
  }
}

const READ_MS = 15_000;
/** `git worktree add` or `remove` on a large checkout, as herdr's own worktree calls allow. */
const CHECKOUT_MS = 60_000;
/** a commit or a merge runs the repository's hooks */
const WRITE_MS = 60_000;
/** how long the size of a checkout is waited for: a status never hangs on a large `node_modules` */
const SIZE_MS = 1_500;
/** names sent with a status; the count is always whole */
const MAX_FILES = 20;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function run(argv: string[], timeoutMs: number): Promise<GitResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
      // no prompt, no editor, git's messages as written; a status read never waits on an index lock an agent holds
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
  } catch (error) {
    throw new WorktreeGitError("git_unavailable", `${argv[0]} could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream<Uint8Array>).text(),
      new Response(child.stderr as ReadableStream<Uint8Array>).text(),
      child.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

const git = (cwd: string, args: string[], timeoutMs = READ_MS): Promise<GitResult> => run(["git", "-C", cwd, ...args], timeoutMs);

/** what git said about a failure, without its `fatal:` and `hint:` dressing, short enough for a dialog */
function said(result: GitResult, fallback: string): string {
  if (result.timedOut) return `${fallback}: git did not finish in time`;
  const lines = `${result.stderr}\n${result.stdout}`.split("\n").map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("hint:"))
    .map((line) => line.replace(/^(?:fatal|error): /, ""));
  const text = lines.join(" ").slice(0, 600);
  return text === "" ? fallback : text;
}

async function must(cwd: string, args: string[], code: string, fallback: string, timeoutMs = READ_MS): Promise<string> {
  const result = await git(cwd, args, timeoutMs);
  if (result.code !== 0 || result.timedOut) throw new WorktreeGitError(code, said(result, fallback));
  return result.stdout.trim();
}

/** The branch a checkout is on; null on a detached HEAD. */
async function currentBranch(checkout: string): Promise<string | null> {
  const result = await git(checkout, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = result.stdout.trim();
  return result.code === 0 && branch !== "" ? branch : null;
}

/** a branch as an argument no git command reads as an option */
const ref = (branch: string): string => `refs/heads/${branch}`;

/** Paths with uncommitted changes, untracked ones included (a directory of them counts once). */
async function changedFiles(checkout: string): Promise<string[]> {
  const output = await must(checkout, ["status", "--porcelain=v1", "-z"], "status_failed", "git status failed");
  const files: string[] = [];
  const entries = output.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    // a rename or a copy is followed by the path it came from
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") index += 1;
  }
  return files;
}

/** A merge, rebase, cherry-pick or revert the checkout is in the middle of. */
async function midOperation(checkout: string): Promise<boolean> {
  const result = await git(checkout, ["rev-parse", "--absolute-git-dir"]);
  const directory = result.stdout.trim();
  if (result.code !== 0 || directory === "") return false;
  return ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].some((name) => existsSync(join(directory, name)));
}

async function checkoutSize(checkout: string): Promise<number | null> {
  try {
    const result = await run(["du", "-sk", checkout], SIZE_MS);
    const kilobytes = Number.parseInt(result.stdout, 10);
    return result.timedOut || !Number.isSafeInteger(kilobytes) ? null : kilobytes * 1024;
  } catch {
    // no `du` (Windows): the size is left out, as it is when it takes too long
    return null;
  }
}

/**
 * What a merge of the checkout into the repository's main checkout would move, and what stands
 * in its way. Nothing is changed: conflicts are read by `git merge-tree`, which merges in the
 * object store alone (git 2.38); an older git leaves them unknown (`null`).
 */
export async function worktreeStatus(main: string, checkout: string): Promise<WorktreeStatus> {
  const [branch, targetBranch, changed, targetChanged, busy, head, targetHead, size] = await Promise.all([
    currentBranch(checkout),
    currentBranch(main),
    changedFiles(checkout),
    changedFiles(main),
    midOperation(main),
    must(checkout, ["rev-parse", "HEAD"], "status_failed", "the worktree has no commit"),
    must(main, ["rev-parse", "HEAD"], "status_failed", "the main checkout has no commit"),
    checkoutSize(checkout),
  ]);
  const counts = (await must(main, ["rev-list", "--left-right", "--count", `${targetHead}...${head}`], "status_failed", "git rev-list failed")).split(/\s+/);
  const behind = Number.parseInt(counts[0] ?? "", 10) || 0;
  const ahead = Number.parseInt(counts[1] ?? "", 10) || 0;
  let conflicts: string[] | null = [];
  // one side contained in the other merges without a conflict: only a true merge is tried
  if (ahead > 0 && behind > 0) {
    const tried = await git(main, ["merge-tree", "--write-tree", "--name-only", "--no-messages", targetHead, head]);
    if (tried.code === 0) conflicts = [];
    else if (tried.code === 1 && !tried.timedOut) conflicts = tried.stdout.split("\n").slice(1).map((line) => line.trim()).filter((line) => line !== "").slice(0, MAX_FILES);
    else conflicts = null;
  }
  return {
    path: checkout,
    branch,
    target: { path: main, branch: targetBranch, changed: targetChanged.length, busy },
    changed: changed.length,
    changed_files: changed.slice(0, MAX_FILES),
    ahead,
    behind,
    conflicts,
    size_bytes: size,
  };
}

/**
 * Merges the checkout's branch into the branch the main checkout is on, as `git merge` there
 * does: a fast-forward when it can be one, a merge commit otherwise. With `commitMessage`, what
 * is uncommitted in the checkout is committed first (`git add -A`), so the merge carries it.
 * A conflict or any other failure after the merge began is taken back with `git merge --abort`.
 */
export async function worktreeMerge(main: string, checkout: string, options: { commitMessage?: string } = {}): Promise<WorktreeMerged> {
  const [branch, targetBranch] = await Promise.all([currentBranch(checkout), currentBranch(main)]);
  if (branch === null) throw new WorktreeGitError("detached_head", "the worktree is on no branch (detached HEAD), so there is no branch to merge");
  if (targetBranch === null) throw new WorktreeGitError("target_detached", "the main checkout is on no branch (detached HEAD), so there is no branch to merge into");
  if (branch === targetBranch) throw new WorktreeGitError("nothing_to_merge", "the worktree is on the branch it would merge into");
  if (await midOperation(main)) throw new WorktreeGitError("target_busy", "the main checkout is in the middle of a merge or a rebase; finish or abort it first");

  let committed = false;
  if (options.commitMessage !== undefined && (await changedFiles(checkout)).length > 0) {
    await must(checkout, ["add", "-A"], "commit_failed", "git add failed", WRITE_MS);
    await must(checkout, ["commit", "--quiet", "-m", options.commitMessage], "commit_failed", "git commit failed", WRITE_MS);
    committed = true;
  }

  const commits = Number.parseInt(await must(main, ["rev-list", "--count", `HEAD..${ref(branch)}`], "merge_failed", "git rev-list failed"), 10) || 0;
  if (commits === 0) throw new WorktreeGitError("nothing_to_merge", `${branch} has no commits that ${targetBranch} lacks`);

  // the full ref is what is merged (a tag of the same name is never taken for it), under the
  // message git itself writes for a branch
  const subject = `Merge branch '${branch}'${targetBranch === "main" || targetBranch === "master" ? "" : ` into ${targetBranch}`}`;
  const merged = await git(main, ["merge", "--no-edit", "-m", subject, ref(branch)], WRITE_MS);
  if (merged.code !== 0 || merged.timedOut) {
    const conflicted = (await git(main, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    if (await midOperation(main)) {
      const aborted = await git(main, ["merge", "--abort"], WRITE_MS);
      if (aborted.code !== 0) throw new WorktreeGitError("merge_abort_failed", `the merge failed and could not be taken back; the main checkout at ${main} is mid-merge: ${said(aborted, "git merge --abort failed")}`);
    }
    if (conflicted.length > 0) {
      const shown = conflicted.slice(0, 5).join(", ");
      throw new WorktreeGitError("merge_conflict", `conflicts in ${shown}${conflicted.length > 5 ? ` and ${conflicted.length - 5} more` : ""}; nothing was changed`);
    }
    throw new WorktreeGitError("merge_refused", said(merged, "git merge failed"));
  }
  const head = await must(main, ["rev-parse", "--short", "HEAD"], "merge_failed", "git rev-parse failed");
  return { ok: true, branch, target_branch: targetBranch, commits, committed, head };
}

/**
 * A new checkout of the repository `source` is in, at `path`: on `branch`, made from `base` (or
 * the source's HEAD) unless it exists. `createdBranch` says which, for a caller that has to
 * take the checkout back.
 */
export async function worktreeAdd(source: string, options: { branch: string; base?: string; path: string }): Promise<{ path: string; branch: string; createdBranch: boolean }> {
  const { branch, base, path } = options;
  if (!isAbsolute(path)) throw new WorktreeGitError("invalid_path", "path must be absolute");
  const named = await git(source, ["check-ref-format", "--branch", branch]);
  if (named.code !== 0) throw new WorktreeGitError("invalid_branch", `${JSON.stringify(branch)} is not a valid branch name`);
  const exists = (await git(source, ["show-ref", "--verify", "--quiet", ref(branch)])).code === 0;
  // a base that looks like an option is never one: it is resolved to a commit first
  const from = exists || base === undefined ? undefined
    : await must(source, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`], "invalid_base", `${JSON.stringify(base)} is not a branch, tag or commit of this repository`);
  const args = exists ? ["worktree", "add", "--", path, branch] : ["worktree", "add", "-b", branch, "--", path, ...(from === undefined ? [] : [from])];
  await must(source, args, "worktree_add_failed", "git worktree add failed", CHECKOUT_MS);
  return { path, branch, createdBranch: !exists };
}

/** Takes back a checkout made a moment ago, and the branch made with it: nothing is in either yet. */
export async function worktreeRollback(source: string, made: { path: string; branch: string; createdBranch: boolean }): Promise<void> {
  await git(source, ["worktree", "remove", "--force", "--", made.path], CHECKOUT_MS);
  if (made.createdBranch) await git(source, ["branch", "-D", "--", made.branch]);
}

/**
 * `git worktree remove`: the folder goes, the branch stays. git refuses a checkout with
 * uncommitted or untracked files without `force`; that refusal carries the code herdr gives its
 * own, so one "Delete anyway" serves both.
 */
export async function worktreeDelete(main: string, checkout: string, force: boolean): Promise<void> {
  const result = await git(main, ["worktree", "remove", ...(force ? ["--force"] : []), "--", checkout], CHECKOUT_MS);
  if (result.code === 0 && !result.timedOut) return;
  const dirty = !force && /use --force|contains modified or untracked files|is dirty/.test(result.stderr);
  throw new WorktreeGitError(dirty ? "dirty_worktree_requires_force" : "worktree_remove_failed", said(result, "git worktree remove failed"));
}

/** `git branch -d`: only a branch whose commits the main checkout's branch already has. False when git keeps it. */
export async function deleteMergedBranch(main: string, branch: string): Promise<boolean> {
  return (await git(main, ["branch", "-d", "--", branch])).code === 0;
}

/** the folder name herdr gives a branch's checkout: the branch with its slashes as dashes */
export function checkoutFolder(branch: string): string {
  return branch.trim().replaceAll("/", "-").replaceAll("\\", "-");
}

/**
 * Where herdr checks worktrees out: `[worktrees] directory` of its config.toml, `~/.herdr/worktrees`
 * unless set. A tab's checkout goes beside the ones herdr makes: `<directory>/<repository>/<branch>`.
 */
export function herdrWorktreeDirectory(configPath = join(process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "herdr", "config.toml")): string {
  try {
    const config = Bun.TOML.parse(readFileSync(configPath, "utf8")) as { worktrees?: { directory?: unknown } };
    const directory = config.worktrees?.directory;
    if (typeof directory === "string" && directory.trim() !== "") {
      const value = directory.trim();
      return value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value);
    }
  } catch { /* no config, or one herdr itself would refuse: its default stands */ }
  return join(homedir(), ".herdr", "worktrees");
}
