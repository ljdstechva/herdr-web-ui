import { useCallback, useEffect, useMemo, useState } from "react";
import type { HerdrPane, HerdrTab, WorkspaceInfo, WorktreeListing } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { usePageVisible } from "./visibility.ts";
import { tabWorktreeSignature, tabWorktrees, type TabWorktree } from "./tabWorktrees.ts";

/**
 * The worktree each tab of the open workspace is in, from the existing `GET /api/worktree/list`.
 * The checkouts are read again when a tab opens, closes or moves to another folder, and when the
 * page comes back; never on a timer, and never because a pane's status changed. An answer that
 * arrives after the tabs changed again is dropped, and a listing never crosses to another workspace.
 * The listing is what says whether the workspace is in a repository at all: herdr's snapshot
 * names a repository only on a workspace a worktree was opened from, so it cannot be the gate.
 */
export function useTabWorktrees(workspace: WorkspaceInfo, tabs: readonly HerdrTab[], panes: readonly HerdrPane[], online: boolean): {
  worktrees: ReadonlyMap<string, TabWorktree>;
  /** after a merge or a delete, which change no tab and no folder */
  refresh: () => void;
} {
  const machineId = useMachineId();
  const { listWorktrees } = useMachineApi();
  const visible = usePageVisible();
  // pane ids repeat across PCs: a listing belongs to one workspace of one PC
  const owner = `${machineId}:${workspace.workspace_id}`;
  const signature = tabWorktreeSignature(workspace.workspace_id, tabs, panes);
  const [read, setRead] = useState<{ owner: string; listing: WorktreeListing } | null>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    if (!online || !visible) return;
    let cancelled = false;
    listWorktrees(workspace.workspace_id).then(
      (listing) => { if (!cancelled) setRead({ owner, listing }); },
      // herdr finds no repository there: every tab is plain. A call that did not get through
      // says nothing about the checkouts, so the last listing stands
      (reason: unknown) => { if (!cancelled && reason instanceof ApiError && reason.status === 404) setRead(null); },
    );
    return () => { cancelled = true; };
  }, [listWorktrees, workspace.workspace_id, owner, signature, online, visible, asked]);

  // the last listing still tells a worktree tab from a plain one while the next is on its way:
  // a checkout does not stop being one because a tab beside it opened
  const listing = read?.owner === owner ? read.listing : null;
  const worktrees = useMemo(() => tabWorktrees(tabs, panes, listing), [signature, listing]);
  const refresh = useCallback(() => setAsked((value) => value + 1), []);
  return { worktrees, refresh };
}
