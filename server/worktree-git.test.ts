import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { WorktreeGitError, checkoutFolder, deleteMergedBranch, herdrWorktreeDirectory, worktreeAdd, worktreeDelete, worktreeMerge, worktreeRollback, worktreeStatus } from "./worktree-git.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function sh(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A repository with one commit on `main`, and a folder beside it for its checkouts. */
function repository(): { main: string; checkouts: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-web-ui-worktree-git-")));
  roots.push(root);
  const main = join(root, "repo");
  expect(Bun.spawnSync(["git", "init", "-q", "-b", "main", main]).exitCode).toBe(0);
  sh(main, "config", "user.name", "Fixture");
  sh(main, "config", "user.email", "fixture@example.invalid");
  sh(main, "config", "commit.gpgsign", "false");
  writeFileSync(join(main, "README.md"), "one\n");
  sh(main, "add", "-A");
  sh(main, "commit", "-q", "-m", "first");
  return { main, checkouts: join(root, "checkouts") };
}

function commit(checkout: string, file: string, content: string, message: string): void {
  writeFileSync(join(checkout, file), content);
  sh(checkout, "add", "-A");
  sh(checkout, "commit", "-q", "-m", message);
}

async function refusal(run: Promise<unknown>): Promise<string> {
  try { await run; } catch (error) {
    if (error instanceof WorktreeGitError) return error.code;
    throw error;
  }
  return "no refusal";
}

describe("worktreeAdd", () => {
  it("checks a new branch out from the source's HEAD, and an existing branch as it is", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "worktree/brave-river-0001", path: join(checkouts, "brave") });
    expect(made).toEqual({ path: join(checkouts, "brave"), branch: "worktree/brave-river-0001", createdBranch: true });
    expect(sh(made.path, "symbolic-ref", "--short", "HEAD")).toBe("worktree/brave-river-0001");
    expect(sh(made.path, "rev-parse", "HEAD")).toBe(sh(main, "rev-parse", "HEAD"));

    sh(main, "branch", "kept");
    const existing = await worktreeAdd(main, { branch: "kept", path: join(checkouts, "kept") });
    expect(existing.createdBranch).toBeFalse();
    expect(sh(existing.path, "symbolic-ref", "--short", "HEAD")).toBe("kept");
  });

  it("starts a new branch at the base it is given", async () => {
    const { main, checkouts } = repository();
    const first = sh(main, "rev-parse", "HEAD");
    commit(main, "second.txt", "two\n", "second");
    const made = await worktreeAdd(main, { branch: "from-first", base: first, path: join(checkouts, "from-first") });
    expect(sh(made.path, "rev-parse", "HEAD")).toBe(first);
  });

  it("refuses a name git would not take, a base that is no commit, and a relative path", async () => {
    const { main, checkouts } = repository();
    expect(await refusal(worktreeAdd(main, { branch: "bad..name", path: join(checkouts, "a") }))).toBe("invalid_branch");
    expect(await refusal(worktreeAdd(main, { branch: "-b", path: join(checkouts, "a") }))).toBe("invalid_branch");
    expect(await refusal(worktreeAdd(main, { branch: "fine", base: "--orphan", path: join(checkouts, "a") }))).toBe("invalid_base");
    expect(await refusal(worktreeAdd(main, { branch: "fine", path: "relative" }))).toBe("invalid_path");
    expect(existsSync(checkouts)).toBeFalse();
    // a branch another checkout is on cannot be checked out twice
    await worktreeAdd(main, { branch: "once", path: join(checkouts, "once") });
    expect(await refusal(worktreeAdd(main, { branch: "once", path: join(checkouts, "twice") }))).toBe("worktree_add_failed");
  });

  it("checks out the branch only a remote has, tracking it, instead of starting a new one of that name", async () => {
    const { main, checkouts } = repository();
    // a second repository stands in for the remote, with a branch this one does not have locally
    const remote = join(checkouts, "..", "remote.git");
    expect(Bun.spawnSync(["git", "clone", "-q", "--bare", main, remote]).exitCode).toBe(0);
    sh(main, "remote", "add", "origin", remote);
    const theirs = join(checkouts, "..", "theirs");
    expect(Bun.spawnSync(["git", "clone", "-q", remote, theirs]).exitCode).toBe(0);
    sh(theirs, "config", "user.name", "Fixture");
    sh(theirs, "config", "user.email", "fixture@example.invalid");
    sh(theirs, "checkout", "-q", "-b", "colleague");
    commit(theirs, "theirs.txt", "theirs\n", "theirs");
    sh(theirs, "push", "-q", "origin", "colleague");
    sh(main, "fetch", "-q", "origin");
    commit(main, "ahead.txt", "ahead\n", "main moved on");

    const made = await worktreeAdd(main, { branch: "colleague", path: join(checkouts, "colleague") });
    expect(made.createdBranch).toBeTrue();
    expect(sh(made.path, "rev-parse", "HEAD")).toBe(sh(theirs, "rev-parse", "HEAD"));
    expect(sh(made.path, "rev-parse", "--abbrev-ref", "colleague@{upstream}")).toBe("origin/colleague");
    // an explicit base still wins over the guess
    const based = await worktreeAdd(main, { branch: "mine", base: "main", path: join(checkouts, "mine") });
    expect(sh(based.path, "rev-parse", "HEAD")).toBe(sh(main, "rev-parse", "HEAD"));
  });

  it("takes a checkout back with the branch made for it, and keeps a branch that was there", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "gone", path: join(checkouts, "gone") });
    await worktreeRollback(main, made);
    expect(existsSync(made.path)).toBeFalse();
    expect(sh(main, "branch", "--list", "gone")).toBe("");

    sh(main, "branch", "kept");
    const existing = await worktreeAdd(main, { branch: "kept", path: join(checkouts, "kept") });
    await worktreeRollback(main, existing);
    expect(existsSync(existing.path)).toBeFalse();
    expect(sh(main, "branch", "--list", "kept")).toContain("kept");
  });
});

describe("worktreeStatus", () => {
  it("reads a fresh checkout as holding nothing the main checkout lacks", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "fresh", path: join(checkouts, "fresh") });
    const status = await worktreeStatus(main, made.path);
    expect(status).toMatchObject({ path: made.path, branch: "fresh", changed: 0, changed_files: [], ahead: 0, behind: 0, conflicts: [] });
    expect(status.target).toEqual({ path: main, branch: "main", changed: 0, busy: false });
    expect(status.busy).toBeFalse();
    expect(status.size_bytes === null || status.size_bytes > 0).toBeTrue();
  });

  it("counts uncommitted files, the commits each side lacks, and names a rename once", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "work", path: join(checkouts, "work") });
    commit(made.path, "feature.txt", "feature\n", "feature");
    commit(made.path, "more.txt", "more\n", "more");
    commit(main, "other.txt", "other\n", "other");
    writeFileSync(join(made.path, "untracked.txt"), "new\n");
    sh(made.path, "mv", "feature.txt", "renamed.txt");
    writeFileSync(join(main, "local.txt"), "local\n");

    const status = await worktreeStatus(main, made.path);
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(1);
    expect(status.changed).toBe(2);
    expect(status.changed_files.sort()).toEqual(["renamed.txt", "untracked.txt"]);
    expect(status.conflicts).toEqual([]);
    expect(status.target.changed).toBe(1);
  });

  it("keeps the whole name of a file changed and not staged, and counts one whose name is a single letter", async () => {
    const { main, checkouts } = repository();
    commit(main, "Makefile", "all:\n", "makefile");
    commit(main, "a", "a\n", "a");
    const made = await worktreeAdd(main, { branch: "work", path: join(checkouts, "work") });
    // an unstaged change is listed with a leading space, which is the first thing in git's output
    writeFileSync(join(made.path, "Makefile"), "all: build\n");
    expect((await worktreeStatus(main, made.path)).changed_files).toEqual(["Makefile"]);
    sh(made.path, "checkout", "-q", "--", "Makefile");
    writeFileSync(join(made.path, "a"), "changed\n");
    writeFileSync(join(main, "a"), "changed here too\n");
    const status = await worktreeStatus(main, made.path);
    expect([status.changed, status.changed_files, status.target.changed]).toEqual([1, ["a"], 1]);
  });

  it("names the files a merge would conflict in, without touching either checkout", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "clash", path: join(checkouts, "clash") });
    commit(made.path, "README.md", "theirs\n", "theirs");
    commit(main, "README.md", "ours\n", "ours");
    const before = sh(main, "rev-parse", "HEAD");

    const status = await worktreeStatus(main, made.path);
    expect(status.conflicts).toEqual(["README.md"]);
    expect(sh(main, "rev-parse", "HEAD")).toBe(before);
    expect(sh(main, "status", "--porcelain")).toBe("");
    expect(status.target.busy).toBeFalse();
  });

  it("says the main checkout is busy while it is mid-merge, and a detached worktree has no branch", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "clash", path: join(checkouts, "clash") });
    commit(made.path, "README.md", "theirs\n", "theirs");
    commit(main, "README.md", "ours\n", "ours");
    expect(Bun.spawnSync(["git", "-C", main, "merge", "--no-edit", "clash"]).exitCode).not.toBe(0);
    expect((await worktreeStatus(main, made.path)).target.busy).toBeTrue();
    sh(main, "merge", "--abort");

    sh(made.path, "checkout", "-q", "--detach");
    expect((await worktreeStatus(main, made.path)).branch).toBeNull();
  });
});

describe("worktreeMerge", () => {
  it("fast-forwards the main checkout's branch when it has nothing of its own", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "work", path: join(checkouts, "work") });
    commit(made.path, "feature.txt", "feature\n", "feature");
    const merged = await worktreeMerge(main, made.path);
    expect(merged).toMatchObject({ ok: true, branch: "work", target_branch: "main", commits: 1, committed: false });
    expect(sh(main, "rev-parse", "HEAD")).toBe(sh(made.path, "rev-parse", "HEAD"));
    expect(merged.head).toBe(sh(main, "rev-parse", "--short", "HEAD"));
    expect(existsSync(join(main, "feature.txt"))).toBeTrue();
  });

  it("makes a merge commit named after the branch when both sides moved", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "worktree/both", path: join(checkouts, "both") });
    commit(made.path, "feature.txt", "feature\n", "feature");
    commit(main, "other.txt", "other\n", "other");
    const merged = await worktreeMerge(main, made.path);
    expect(merged.commits).toBe(1);
    expect(sh(main, "log", "-1", "--format=%s")).toBe("Merge branch 'worktree/both'");
    expect(sh(main, "rev-list", "--parents", "-1", "HEAD").split(" ")).toHaveLength(3);
    expect(sh(main, "status", "--porcelain")).toBe("");
  });

  it("commits what is uncommitted first when a message is given, and leaves it alone otherwise", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "work", path: join(checkouts, "work") });
    writeFileSync(join(made.path, "draft.txt"), "draft\n");
    // nothing committed and no message: the draft is not the merge's to take
    expect(await refusal(worktreeMerge(main, made.path))).toBe("nothing_to_merge");
    expect(existsSync(join(made.path, "draft.txt"))).toBeTrue();

    const merged = await worktreeMerge(main, made.path, { commitMessage: "Work from work" });
    expect(merged).toMatchObject({ commits: 1, committed: true });
    expect(sh(main, "log", "-1", "--format=%s")).toBe("Work from work");
    expect(existsSync(join(main, "draft.txt"))).toBeTrue();
    expect(sh(made.path, "status", "--porcelain")).toBe("");

    // a message with nothing to commit commits nothing
    commit(made.path, "next.txt", "next\n", "next");
    expect((await worktreeMerge(main, made.path, { commitMessage: "unused" })).committed).toBeFalse();
  });

  it("takes a conflicting merge back, so the main checkout is as it was", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "clash", path: join(checkouts, "clash") });
    commit(made.path, "README.md", "theirs\n", "theirs");
    commit(main, "README.md", "ours\n", "ours");
    const before = sh(main, "rev-parse", "HEAD");

    let message = "";
    try { await worktreeMerge(main, made.path); } catch (error) {
      expect(error).toBeInstanceOf(WorktreeGitError);
      expect((error as WorktreeGitError).code).toBe("merge_conflict");
      message = (error as WorktreeGitError).message;
    }
    expect(message).toContain("README.md");
    expect(sh(main, "rev-parse", "HEAD")).toBe(before);
    expect(sh(main, "status", "--porcelain")).toBe("");
    expect((await worktreeStatus(main, made.path)).target.busy).toBeFalse();
  });

  it("leaves a worktree that is mid-merge alone: its conflict is not committed and carried into the main checkout", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "feat", path: join(checkouts, "feat") });
    commit(made.path, "f.txt", "feat\n", "feat");
    sh(main, "branch", "other");
    const other = await worktreeAdd(main, { branch: "other", path: join(checkouts, "other") });
    commit(other.path, "f.txt", "other\n", "other");
    // the worktree's agent started a merge and has not resolved it
    expect(Bun.spawnSync(["git", "-C", made.path, "merge", "--no-edit", "other"]).exitCode).not.toBe(0);
    const before = sh(main, "rev-parse", "HEAD");

    const status = await worktreeStatus(main, made.path);
    expect(status.busy).toBeTrue();
    expect(status.changed).toBe(1);
    expect(await refusal(worktreeMerge(main, made.path, { commitMessage: "Work from feat" }))).toBe("worktree_busy");
    expect(await refusal(worktreeMerge(main, made.path))).toBe("worktree_busy");
    expect(sh(main, "rev-parse", "HEAD")).toBe(before);
    // the agent's merge is still its to finish
    expect(sh(made.path, "status", "--porcelain")).toStartWith("AA f.txt");
    expect(existsSync(join(main, "f.txt"))).toBeFalse();
  });

  it("says a commit was made when the merge after it conflicts", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "feat", path: join(checkouts, "feat") });
    commit(main, "README.md", "ours\n", "ours");
    // not committed yet, so no reading could have named the conflict
    writeFileSync(join(made.path, "README.md"), "theirs\n");
    const before = sh(main, "rev-parse", "HEAD");
    let message = "";
    try { await worktreeMerge(main, made.path, { commitMessage: "Work from feat" }); } catch (error) {
      expect((error as WorktreeGitError).code).toBe("merge_conflict");
      message = (error as WorktreeGitError).message;
    }
    expect(message).toContain("main was not changed");
    expect(message).toContain("now a commit on feat");
    expect(message).not.toContain("nothing was changed");
    expect(sh(main, "rev-parse", "HEAD")).toBe(before);
    expect(sh(main, "status", "--porcelain")).toBe("");
    expect(sh(made.path, "log", "-1", "--format=%s")).toBe("Work from feat");
  });

  it("answers git's refusal when the main checkout has its own changes to a merged file", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "work", path: join(checkouts, "work") });
    commit(made.path, "README.md", "theirs\n", "theirs");
    writeFileSync(join(main, "README.md"), "edited by hand\n");
    expect(await refusal(worktreeMerge(main, made.path))).toBe("merge_refused");
    // the hand edit is still there, and nothing is mid-merge
    expect(sh(main, "status", "--porcelain")).toBe("M README.md");
  });

  it("refuses a detached worktree, a detached target and a main checkout that is mid-merge", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "work", path: join(checkouts, "work") });
    commit(made.path, "feature.txt", "feature\n", "feature");
    sh(made.path, "checkout", "-q", "--detach");
    expect(await refusal(worktreeMerge(main, made.path))).toBe("detached_head");
    sh(made.path, "checkout", "-q", "work");

    sh(main, "checkout", "-q", "--detach");
    expect(await refusal(worktreeMerge(main, made.path))).toBe("target_detached");
    sh(main, "checkout", "-q", "main");

    const clash = await worktreeAdd(main, { branch: "clash", path: join(checkouts, "clash") });
    commit(clash.path, "README.md", "theirs\n", "theirs");
    commit(main, "README.md", "ours\n", "ours");
    expect(Bun.spawnSync(["git", "-C", main, "merge", "--no-edit", "clash"]).exitCode).not.toBe(0);
    expect(await refusal(worktreeMerge(main, made.path))).toBe("target_busy");
  });
});

describe("worktreeDelete", () => {
  it("refuses a checkout with unsaved files under herdr's own code, and deletes it when forced", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "work", path: join(checkouts, "work") });
    writeFileSync(join(made.path, "draft.txt"), "draft\n");
    expect(await refusal(worktreeDelete(main, made.path, false))).toBe("dirty_worktree_requires_force");
    expect(existsSync(made.path)).toBeTrue();
    await worktreeDelete(main, made.path, true);
    expect(existsSync(made.path)).toBeFalse();
    // the branch stays
    expect(sh(main, "branch", "--list", "work")).toContain("work");
    expect(await refusal(worktreeDelete(main, made.path, false))).toBe("worktree_remove_failed");
  });

  it("deletes a clean checkout, then its branch only once the main checkout has its commits", async () => {
    const { main, checkouts } = repository();
    const made = await worktreeAdd(main, { branch: "work", path: join(checkouts, "work") });
    commit(made.path, "feature.txt", "feature\n", "feature");
    await worktreeDelete(main, made.path, false);
    expect(await deleteMergedBranch(main, "work")).toBeFalse();
    expect(sh(main, "branch", "--list", "work")).toContain("work");

    sh(main, "merge", "-q", "--no-edit", "work");
    expect(await deleteMergedBranch(main, "work")).toBeTrue();
    expect(sh(main, "branch", "--list", "work")).toBe("");
  });
});

describe("deleteMergedBranch", () => {
  it("keeps a branch that is pushed and not merged here, which git branch -d alone would delete", async () => {
    const { main, checkouts } = repository();
    const remote = join(checkouts, "..", "remote.git");
    expect(Bun.spawnSync(["git", "clone", "-q", "--bare", main, remote]).exitCode).toBe(0);
    sh(main, "remote", "add", "origin", remote);
    const made = await worktreeAdd(main, { branch: "feat", path: join(checkouts, "feat") });
    commit(made.path, "feature.txt", "feature\n", "feature");
    sh(made.path, "push", "-q", "-u", "origin", "feat");
    await worktreeDelete(main, made.path, false);

    expect(await deleteMergedBranch(main, "feat")).toBeFalse();
    expect(sh(main, "branch", "--list", "feat")).toContain("feat");
    expect(await deleteMergedBranch(main, "no-such-branch")).toBeFalse();
    sh(main, "merge", "-q", "--no-edit", "feat");
    expect(await deleteMergedBranch(main, "feat")).toBeTrue();
  });
});

describe("where a tab's checkout goes", () => {
  it("names the folder as herdr names a branch's checkout", () => {
    expect(checkoutFolder("worktree/brave-river-07f8")).toBe("worktree-brave-river-07f8");
    expect(checkoutFolder(" fix/a/b ")).toBe("fix-a-b");
  });

  it("reads herdr's worktree directory from its config, and falls back to herdr's default", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-worktree-config-"));
    roots.push(root);
    const fallback = join(homedir(), ".herdr", "worktrees");
    expect(herdrWorktreeDirectory(join(root, "missing.toml"))).toBe(fallback);

    writeFileSync(join(root, "default.toml"), "[ui]\nsidebar_width = 26\n# [worktrees]\n# directory = \"~/elsewhere\"\n");
    expect(herdrWorktreeDirectory(join(root, "default.toml"))).toBe(fallback);

    writeFileSync(join(root, "set.toml"), "[worktrees]\ndirectory = \"~/code/trees\"\n");
    expect(herdrWorktreeDirectory(join(root, "set.toml"))).toBe(join(homedir(), "code", "trees"));

    writeFileSync(join(root, "absolute.toml"), "[worktrees]\ndirectory = \"/srv/trees\"\n");
    expect(herdrWorktreeDirectory(join(root, "absolute.toml"))).toBe("/srv/trees");

    writeFileSync(join(root, "broken.toml"), "[worktrees\ndirectory = ");
    expect(herdrWorktreeDirectory(join(root, "broken.toml"))).toBe(fallback);
  });
});
