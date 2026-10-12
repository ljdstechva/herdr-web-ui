import type { HerdrPane, HerdrTab, WorktreeListing, WorktreeStatus } from "../../shared/protocol.ts";
import { normalizeCheckoutPath } from "./worktreeBranches.ts";
import { worktreeLabel } from "./worktreeName.ts";

/** The linked checkout a tab's panes are in: a worktree that is a tab, not a workspace of its own. */
export interface TabWorktree {
  /** the checkout as git lists it, which is how the API is asked about it */
  path: string;
  branch: string | null;
  isDetached: boolean;
}

type TabRef = Pick<HerdrTab, "tab_id">;
type PaneRef = Pick<HerdrPane, "tab_id" | "cwd">;

const inside = (folder: string, checkout: string): boolean => folder === checkout || folder.startsWith(checkout.endsWith("/") ? checkout : `${checkout}/`);

/**
 * Which tabs of a workspace are worktrees, read from where their panes are: the checkout a
 * folder belongs to is the deepest one that holds it (a worktree can sit inside the main
 * checkout, as Claude Code's own do), and a tab belongs to the linked checkout most of its panes
 * are in. The workspace's own checkout never counts: a tab there is a plain tab, and in a
 * worktree workspace the workspace is the worktree. A checkout git has lost is not offered.
 * The listing alone says which checkout is the workspace's own (`source_checkout_path`): herdr
 * puts no repository on an ordinary workspace's snapshot, only on one a worktree was opened from.
 */
export function tabWorktrees(tabs: readonly TabRef[], panes: readonly PaneRef[], listing: WorktreeListing | null): Map<string, TabWorktree> {
  const found = new Map<string, TabWorktree>();
  if (!listing) return found;
  const own = normalizeCheckoutPath(listing.source.source_checkout_path);
  const checkouts = listing.worktrees.filter((entry) => !entry.is_bare && !entry.is_prunable)
    .map((entry) => ({ entry, path: normalizeCheckoutPath(entry.path) }))
    .sort((left, right) => right.path.length - left.path.length);
  for (const tab of tabs) {
    const counts = new Map<string, { worktree: TabWorktree; panes: number }>();
    for (const pane of panes) {
      if (pane.tab_id !== tab.tab_id || !pane.cwd) continue;
      const folder = normalizeCheckoutPath(pane.cwd);
      const checkout = checkouts.find((candidate) => inside(folder, candidate.path));
      if (!checkout || !checkout.entry.is_linked_worktree || checkout.path === own) continue;
      const seen = counts.get(checkout.path);
      if (seen) seen.panes += 1;
      else counts.set(checkout.path, { worktree: { path: checkout.entry.path, branch: checkout.entry.branch, isDetached: checkout.entry.is_detached }, panes: 1 });
    }
    let best: { worktree: TabWorktree; panes: number } | undefined;
    for (const candidate of counts.values()) if (!best || candidate.panes > best.panes) best = candidate;
    if (best) found.set(tab.tab_id, best.worktree);
  }
  return found;
}

/** A tab opened, closed or moved to another folder asks for the checkouts again; a status change does not. */
export function tabWorktreeSignature(workspaceId: string, tabs: readonly TabRef[], panes: readonly PaneRef[]): string {
  return JSON.stringify([workspaceId, tabs.map((tab) => tab.tab_id), panes.map((pane) => [pane.tab_id, pane.cwd ?? ""])]);
}

/** herdr's generated branches share this folder; a tab is named by what follows it. */
const GENERATED = "worktree/";

/** The name a worktree tab takes when none is typed: its branch as a folder name, without herdr's shared prefix. */
export function worktreeTabLabel(branch: string): string {
  const name = branch.trim();
  return worktreeLabel(name.startsWith(GENERATED) && name.length > GENERATED.length ? name.slice(GENERATED.length) : name);
}

/** A branch herdr or this app named: one nobody chose, which goes with its checkout unless kept. */
export const isGeneratedBranch = (branch: string | null): boolean => branch !== null && branch.startsWith(GENERATED);

/** Nothing in the checkout would be lost with it: no unsaved file, no commit the target lacks. */
export const worktreeSpent = (status: Pick<WorktreeStatus, "changed" | "ahead">): boolean => status.changed === 0 && status.ahead === 0;

/**
 * Whether a merge can be asked for, and the one reason it cannot. `commit` is the choice to
 * commit the checkout's unsaved files first, which gives a branch without commits something to merge.
 */
export type MergeBlock = "detached" | "target-detached" | "target-busy" | "conflicts" | "nothing";
export function mergeBlock(status: WorktreeStatus, commit: boolean): MergeBlock | null {
  if (status.branch === null) return "detached";
  if (status.target.branch === null) return "target-detached";
  if (status.target.busy) return "target-busy";
  if (status.conflicts !== null && status.conflicts.length > 0) return "conflicts";
  if (status.ahead === 0 && !(commit && status.changed > 0)) return "nothing";
  return null;
}

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/** A checkout's size as a person reads it: "184 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes) / 1024;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10} ${UNITS[unit]}`;
}
