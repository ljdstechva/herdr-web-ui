import { describe, expect, it } from "bun:test";

import type { WorktreeEntry, WorktreeListing, WorktreeStatus } from "../../shared/protocol.ts";
import { checkoutInUseElsewhere, formatBytes, isGeneratedBranch, mergeBlock, tabWorktreeSignature, tabWorktrees, worktreeSpent, worktreeTabLabel } from "./tabWorktrees.ts";

const entry = (path: string, branch: string | null, linked: boolean, extra: Partial<WorktreeEntry> = {}): WorktreeEntry => ({
  path, branch, label: branch ?? "detached", is_linked_worktree: linked, is_bare: false, is_detached: branch === null, is_prunable: false, open_workspace_id: null, ...extra,
});

const listing = (...worktrees: WorktreeEntry[]): WorktreeListing => ({
  source: { repo_key: "repo", repo_name: "app", repo_root: "/code/app", source_checkout_path: "/code/app", source_workspace_id: "w1" },
  worktrees,
});

const tabs = [{ tab_id: "t1" }, { tab_id: "t2" }, { tab_id: "t3" }];

describe("tabWorktrees", () => {
  const checkouts = listing(
    entry("/code/app", "main", false),
    entry("/home/me/.herdr/worktrees/app/worktree-brave", "worktree/brave", true),
    entry("/code/app/.claude/worktrees/nested", "nested", true),
  );

  it("marks the tabs whose panes are in a linked checkout, and leaves the main checkout's tabs plain", () => {
    const found = tabWorktrees(tabs, [
      { tab_id: "t1", cwd: "/code/app/src" },
      { tab_id: "t2", cwd: "/home/me/.herdr/worktrees/app/worktree-brave/server" },
      { tab_id: "t3", cwd: "/code/app/.claude/worktrees/nested" },
    ], checkouts);
    expect([...found.keys()]).toEqual(["t2", "t3"]);
    expect(found.get("t2")).toEqual({ path: "/home/me/.herdr/worktrees/app/worktree-brave", branch: "worktree/brave", isDetached: false });
    // a worktree inside the main checkout belongs to itself, not to the checkout around it
    expect(found.get("t3")?.branch).toBe("nested");
  });

  it("does not take a folder that only starts like a checkout for one inside it", () => {
    const found = tabWorktrees(tabs, [{ tab_id: "t1", cwd: "/home/me/.herdr/worktrees/app/worktree-brave-two" }], checkouts);
    expect(found.size).toBe(0);
  });

  it("gives a tab to the checkout most of its panes are in, so a pane that stepped out does not unmark it", () => {
    const found = tabWorktrees(tabs, [
      { tab_id: "t2", cwd: "/home/me" },
      { tab_id: "t2", cwd: "/home/me/.herdr/worktrees/app/worktree-brave" },
      { tab_id: "t2", cwd: "/home/me/.herdr/worktrees/app/worktree-brave/src" },
      { tab_id: "t2", cwd: "/code/app/.claude/worktrees/nested" },
      { tab_id: "t3", cwd: null },
    ], checkouts);
    expect(found.get("t2")?.branch).toBe("worktree/brave");
    expect(found.has("t3")).toBeFalse();
  });

  it("never counts the workspace's own checkout: in a worktree workspace the workspace is the worktree", () => {
    // asked from a workspace on the linked checkout, as herdr's listing says in its source
    const fromLinked = { ...checkouts, source: { ...checkouts.source, source_checkout_path: "/home/me/.herdr/worktrees/app/worktree-brave/" } };
    const found = tabWorktrees(tabs, [
      { tab_id: "t1", cwd: "/home/me/.herdr/worktrees/app/worktree-brave/src" },
      { tab_id: "t2", cwd: "/code/app/.claude/worktrees/nested" },
    ], fromLinked);
    expect([...found.keys()]).toEqual(["t2"]);
  });

  it("offers nothing without a listing or for a checkout git has lost, and reads a detached one as such", () => {
    const panes = [{ tab_id: "t2", cwd: "/gone/tree" }];
    expect(tabWorktrees(tabs, panes, null).size).toBe(0);
    expect(tabWorktrees(tabs, panes, listing(entry("/code/app", "main", false), entry("/gone/tree", "gone", true, { is_prunable: true }))).size).toBe(0);
    expect(tabWorktrees(tabs, panes, listing(entry("/code/app", "main", false), entry("/gone/tree", null, true))).get("t2")).toEqual({ path: "/gone/tree", branch: null, isDetached: true });
  });

  it("marks nothing, and does not throw, on a listing that lacks what it needs", () => {
    const panes = [{ tab_id: "t1", cwd: "/tmp/project/linked" }];
    // an entry without the linked flag is not known to be a worktree; a source without its checkout excludes nothing
    const partial = { source: { repo_key: "repo", source_workspace_id: "w1" }, worktrees: [{ path: "/tmp/project/linked", branch: "feature", is_detached: false, open_workspace_id: "w1" }] } as unknown as WorktreeListing;
    expect(tabWorktrees(tabs, panes, partial).size).toBe(0);
    expect(tabWorktrees(tabs, panes, { worktrees: [{ branch: "x", is_linked_worktree: true }, null] } as unknown as WorktreeListing).size).toBe(0);
    expect(tabWorktrees(tabs, panes, {} as unknown as WorktreeListing).size).toBe(0);
  });

  it("reads a checkout herdr lists without a workspace field, as it does for one no workspace is on", () => {
    const unopened = entry("/trees/a", "a", true) as Partial<WorktreeEntry>;
    delete unopened.open_workspace_id;
    expect(tabWorktrees(tabs, [{ tab_id: "t1", cwd: "/trees/a" }], listing(entry("/code/app", "main", false), unopened as WorktreeEntry)).get("t1")?.branch).toBe("a");
  });
});

describe("checkoutInUseElsewhere", () => {
  it("finds a pane of another tab or another workspace in the checkout, and not the tab's own", () => {
    const panes = [{ tab_id: "t2", cwd: "/trees/a/src" }, { tab_id: "t2", cwd: "/trees/a" }];
    expect(checkoutInUseElsewhere(panes, "t2", "/trees/a")).toBeFalse();
    expect(checkoutInUseElsewhere([...panes, { tab_id: "t3", cwd: "/trees/a/" }], "t2", "/trees/a")).toBeTrue();
    // a pane of another workspace has another tab id too
    expect(checkoutInUseElsewhere([...panes, { tab_id: "w9:t1", cwd: "/trees/a/docs" }], "t2", "/trees/a")).toBeTrue();
    expect(checkoutInUseElsewhere([...panes, { tab_id: "t3", cwd: "/trees/ab" }, { tab_id: "t4", cwd: null }], "t2", "/trees/a")).toBeFalse();
  });
});

describe("tabWorktreeSignature", () => {
  it("changes with the tabs and their folders, and not with anything else a pane reports", () => {
    const base = tabWorktreeSignature("w1", tabs, [{ tab_id: "t1", cwd: "/code/app" }]);
    expect(tabWorktreeSignature("w1", tabs, [{ tab_id: "t1", cwd: "/code/app", agent_status: "working" } as never])).toBe(base);
    expect(tabWorktreeSignature("w1", tabs, [{ tab_id: "t1", cwd: "/code/app/src" }])).not.toBe(base);
    expect(tabWorktreeSignature("w1", tabs.slice(0, 2), [{ tab_id: "t1", cwd: "/code/app" }])).not.toBe(base);
    expect(tabWorktreeSignature("w2", tabs, [{ tab_id: "t1", cwd: "/code/app" }])).not.toBe(base);
  });
});

describe("worktree tab names and branches", () => {
  it("names a tab after its branch without the folder generated branches share", () => {
    expect(worktreeTabLabel("worktree/brave-river-07f8")).toBe("brave-river-07f8");
    expect(worktreeTabLabel(" fix/login/redirect ")).toBe("fix-login-redirect");
    expect(worktreeTabLabel("worktree/")).toBe("worktree-");
  });

  it("knows a generated branch from one somebody chose", () => {
    expect(isGeneratedBranch("worktree/brave-river-07f8")).toBeTrue();
    expect(isGeneratedBranch("release")).toBeFalse();
    expect(isGeneratedBranch(null)).toBeFalse();
  });
});

describe("mergeBlock", () => {
  const status = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
    path: "/trees/a", branch: "work", target: { path: "/code/app", branch: "main", changed: 0, busy: false },
    busy: false, changed: 0, changed_files: [], ahead: 2, behind: 0, conflicts: [], size_bytes: null, ...over,
  });

  it("lets a branch with commits merge, with or without a conflict reading", () => {
    expect(mergeBlock(status(), false)).toBeNull();
    expect(mergeBlock(status({ conflicts: null, behind: 3 }), false)).toBeNull();
  });

  it("names the one thing in the way, most basic first", () => {
    expect(mergeBlock(status({ branch: null, conflicts: ["a"] }), false)).toBe("detached");
    expect(mergeBlock(status({ target: { path: "/code/app", branch: null, changed: 0, busy: true } }), false)).toBe("target-detached");
    expect(mergeBlock(status({ target: { path: "/code/app", branch: "main", changed: 0, busy: true }, conflicts: ["a"] }), false)).toBe("target-busy");
    // an unfinished merge in the worktree comes before anything a commit could do
    expect(mergeBlock(status({ busy: true, changed: 1 }), true)).toBe("busy");
    expect(mergeBlock(status({ conflicts: ["a.ts"] }), false)).toBe("conflicts");
    expect(mergeBlock(status({ ahead: 0 }), false)).toBe("nothing");
  });

  it("counts unsaved files as something to merge only when they are to be committed", () => {
    expect(mergeBlock(status({ ahead: 0, changed: 3 }), false)).toBe("nothing");
    expect(mergeBlock(status({ ahead: 0, changed: 3 }), true)).toBeNull();
    expect(mergeBlock(status({ ahead: 0, changed: 0 }), true)).toBe("nothing");
  });

  it("calls a checkout spent when nothing in it would be lost", () => {
    expect(worktreeSpent({ changed: 0, ahead: 0 })).toBeTrue();
    expect(worktreeSpent({ changed: 1, ahead: 0 })).toBeFalse();
    expect(worktreeSpent({ changed: 0, ahead: 1 })).toBeFalse();
  });
});

describe("formatBytes", () => {
  it("reads as a size on disk", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(4096)).toBe("4 KB");
    expect(formatBytes(184 * 1024 * 1024)).toBe("184 MB");
    expect(formatBytes(1.25 * 1024 * 1024 * 1024)).toBe("1.3 GB");
    expect(formatBytes(12.4 * 1024 * 1024)).toBe("12.4 MB");
  });
});
