/**
 * Closing a tab that is a worktree: the question a plain tab's close does not have is what
 * becomes of the checkout. The dialog reads what is in it first (uncommitted files, commits the
 * main checkout lacks, its size on disk) and offers to delete it, which is ticked already when
 * nothing would be lost. The checkout goes before the tab: when git refuses (files changed since
 * the reading), the tab is still there and "Delete anyway" is the second step. A branch goes
 * with its checkout only when the main checkout has its commits, and only when asked.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import "./WorktreeDialog.css";

import type { WorktreeStatus } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { formatBytes, isGeneratedBranch, worktreeSpent, type TabWorktree } from "../lib/tabWorktrees.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";

interface Props {
  title: string;
  /** what closing the tab itself costs (an agent at work, the workspace's last tab); null when nothing */
  warning: string | null;
  workspaceId: string;
  worktree: TabWorktree;
  /** another tab is in this checkout, so it is not this tab's to delete */
  shared: boolean;
  /** closes the tab; the owner then takes the dialog down */
  onCloseTab: () => Promise<void>;
  /** the checkout went: the owner reads the repository's checkouts again */
  onDeleted?: () => void;
  onClose: () => void;
}

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

export function WorktreeCloseDialog({ title, warning, workspaceId, worktree, shared, onCloseTab, onDeleted, onClose }: Props) {
  const t = useT();
  const id = useId();
  const { fetchWorktreeStatus, removeWorktree } = useMachineApi();
  const cancel = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: cancel, shouldRestore: () => !done.current });
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  // null until the reading says, or the user does: a spent checkout is offered for deletion already
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [branchChosen, setBranchChosen] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forced, setForced] = useState(false);
  // the checkout went and the tab's close failed: the next press only closes the tab
  const deleted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetchWorktreeStatus(workspaceId, worktree.path).then(
      (next) => { if (!cancelled) setStatus(next); },
      (reason: unknown) => { if (!cancelled) setUnread(said(reason)); },
    );
    return () => { cancelled = true; };
  }, [fetchWorktreeStatus, workspaceId, worktree.path]);
  useEffect(() => { if (pending) surface.current?.focus(); }, [pending]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      if (!pending) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, pending]);

  const branch = status?.branch ?? worktree.branch;
  const target = status?.target.branch ?? null;
  const remove = !shared && (chosen ?? (status !== null && worktreeSpent(status)));
  // git deletes a branch only when its commits are merged: the choice is offered only then
  const branchOffered = remove && status !== null && status.ahead === 0 && branch !== null;
  const removeBranch = branchOffered && (branchChosen ?? isGeneratedBranch(branch));

  const confirm = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      if (remove && !deleted.current) {
        // what the reading showed as unsaved was named under the tick: git is not asked twice about it
        await removeWorktree({ workspace_id: workspaceId, path: worktree.path, force: forced || (status?.changed ?? 0) > 0, delete_branch: removeBranch });
        deleted.current = true;
        onDeleted?.();
      }
      await onCloseTab();
      done.current = true;
    } catch (reason: unknown) {
      setError(said(reason));
      if (reason instanceof ApiError && reason.code === "dirty_worktree_requires_force") setForced(true);
      setPending(false);
    }
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
      <div ref={surface} className="modal worktree-modal" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} tabIndex={-1}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{title}</h2></header>
        <div className="modal-body">
          <p className="worktree-lead" id={`${id}-body`}>{branch
            ? t("This tab is a worktree on the branch {branch}.", { branch })
            : t("This tab is a worktree on no branch (detached HEAD).")}{warning ? ` ${warning}` : ""}</p>
          {status ? (
            <dl className="worktree-facts">
              <div><dt>{t("Uncommitted files")}</dt><dd>{status.changed}</dd></div>
              <div><dt>{target ? t("Commits not in {target}", { target }) : t("Commits not in the main checkout")}</dt><dd>{status.ahead}</dd></div>
              {status.size_bytes !== null && <div><dt>{t("Size on disk")}</dt><dd>{formatBytes(status.size_bytes)}</dd></div>}
            </dl>
          ) : unread === null ? <p className="field-hint" role="status">{t("Reading the worktree…")}</p>
            : <p className="field-hint worktree-error">{t("The worktree could not be read: {reason}", { reason: unread })}</p>}
          {shared ? <p className="field-hint">{t("Another tab is in this checkout, so it stays.")}</p> : (
            <div className="worktree-option">
              <label className="worktree-check">
                <input type="checkbox" checked={remove} disabled={pending || deleted.current} onChange={(event) => setChosen(event.target.checked)} />
                <span>{t("Delete the worktree checkout")}</span>
              </label>
              <p className="worktree-where">{worktree.path}</p>
              {remove && status !== null && status.changed > 0 && <p className="worktree-alert">{t("Its uncommitted files are lost with it.")}</p>}
              {remove && status !== null && status.ahead > 0 && branch && <p className="field-hint">{t("Its commits stay on the branch {branch}.", { branch })}</p>}
              {!remove && <p className="field-hint">{t("The checkout stays on disk, and its branch with it.")}</p>}
              {branchOffered && (
                <label className="worktree-check">
                  <input type="checkbox" checked={removeBranch} disabled={pending || deleted.current} onChange={(event) => setBranchChosen(event.target.checked)} />
                  <span>{t("Delete the branch {branch} too", { branch })}</span>
                </label>
              )}
            </div>
          )}
          {pending && remove && !deleted.current && <p className="field-hint" role="status">{t("Deleting the checkout…")}</p>}
          {error && <p className="field-hint worktree-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button ref={cancel} type="button" className="btn" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          <button type="button" className="btn btn-danger" disabled={pending} onClick={() => void confirm()}>{forced && !deleted.current ? t("Delete anyway") : t(remove && !deleted.current ? "Close and delete" : "Close tab")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
