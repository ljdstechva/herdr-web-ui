/**
 * Merges a worktree's branch into the branch the repository's main checkout is on: the step that
 * brings what one agent did in its own checkout back to the project. It first reads what the
 * merge would move (commits, uncommitted files, the files it would conflict in), so a merge that
 * cannot work is not offered. Uncommitted files can be committed first, in the same step. A
 * conflict changes nothing: the server takes the merge back, and the dialog names the files.
 * Once merged, the owner's cleanup (close the tab, or the workspace, and delete the checkout
 * with its branch) is one button away; "Done" keeps the worktree for more work.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitMerge, X } from "lucide-react";

import "./WorktreeDialog.css";

import type { WorktreeMerged, WorktreeStatus } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { mergeBlock } from "../lib/tabWorktrees.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";

interface Props {
  /** a workspace in the repository: the one the tab is in, or the worktree's own */
  workspaceId: string;
  /** the checkout, as the worktree listing names it */
  path: string;
  /** its branch as last listed, for the title until the status says */
  branch: string | null;
  /** what follows a merge, when the owner can take the worktree away: its label, and the deed (force after git refused unsaved files) */
  cleanup?: { label: string; run: (force: boolean) => Promise<void> } | null;
  /** the repository changed: the owner reads its checkouts again */
  onMerged?: () => void;
  onClose: () => void;
}

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);
const SHOWN_FILES = 5;

export function WorktreeMergeDialog({ workspaceId, path, branch, cleanup = null, onMerged, onClose }: Props) {
  const t = useT();
  const id = useId();
  const { fetchWorktreeStatus, mergeWorktree } = useMachineApi();
  const cancel = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: cancel, shouldRestore: () => !done.current });
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [reading, setReading] = useState(0);
  const [pending, setPending] = useState<"merge" | "cleanup" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [merged, setMerged] = useState<WorktreeMerged | null>(null);
  const [commit, setCommit] = useState(true);
  // null: the message follows the branch until it is typed over
  const [typedMessage, setTypedMessage] = useState<string | null>(null);
  const [forced, setForced] = useState(false);

  const name = status?.branch ?? merged?.branch ?? branch;
  const target = status?.target.branch ?? merged?.target_branch ?? null;
  const message = typedMessage ?? t("Work from {branch}", { branch: name ?? "worktree" });

  useEffect(() => {
    let cancelled = false;
    fetchWorktreeStatus(workspaceId, path).then(
      (next) => { if (!cancelled) setStatus(next); },
      (reason: unknown) => { if (!cancelled) setError(said(reason)); },
    );
    return () => { cancelled = true; };
  }, [fetchWorktreeStatus, workspaceId, path, reading]);
  // the buttons disable while git runs, which would drop the focus into the page
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

  const committing = commit && (status?.changed ?? 0) > 0;
  const block = status ? mergeBlock(status, committing) : null;

  const merge = async (): Promise<void> => {
    if (!status || pending) return;
    setPending("merge");
    setError(null);
    try {
      const result = await mergeWorktree({ workspace_id: workspaceId, path, commit_message: committing ? message.trim() || null : null });
      setMerged(result);
      onMerged?.();
    } catch (reason: unknown) {
      setError(said(reason));
      // a commit may have been made, and a conflict is now known by name
      setReading((value) => value + 1);
    }
    setPending(null);
  };
  const clean = async (): Promise<void> => {
    if (!cleanup || pending) return;
    setPending("cleanup");
    setError(null);
    try {
      await cleanup.run(forced);
      done.current = true;
      onClose();
    } catch (reason: unknown) {
      setError(said(reason));
      if (reason instanceof ApiError && reason.code === "dirty_worktree_requires_force") setForced(true);
      setPending(null);
    }
  };

  const files = (names: string[], total: number) => (
    <ul className="worktree-files">
      {names.slice(0, SHOWN_FILES).map((file) => <li key={file}>{file}</li>)}
      {total > SHOWN_FILES && <li className="worktree-files-more">{t("and {n} more", { n: total - SHOWN_FILES })}</li>}
    </ul>
  );

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
      <div ref={surface} className="modal worktree-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{name ? t("Merge {branch}", { branch: name }) : t("Merge worktree")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close merge dialog")} disabled={pending !== null} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          {merged ? (
            <>
              <p className="worktree-lead worktree-merged" role="status">
                <GitMerge aria-hidden="true" />
                <span>{t("Merged {branch} into {target}. Commits added: {n}.", { n: merged.commits, branch: merged.branch, target: merged.target_branch })}{merged.committed ? ` ${t("The uncommitted files were committed first.")}` : ""}</span>
              </p>
              {cleanup && <p className="field-hint">{t("Deleting the worktree removes its checkout at {path} and the branch {branch}: {target} has its commits now.", { path, branch: merged.branch, target: merged.target_branch })}</p>}
            </>
          ) : !status ? (
            !error && <p className="field-hint" role="status">{t("Reading the worktree…")}</p>
          ) : (
            <>
              <p className="worktree-lead">{target
                ? t("Brings what {branch} has into {target}, the branch of the repository's main checkout.", { branch: name ?? t("Detached HEAD"), target })
                : t("The repository's main checkout is at {path}.", { path: status.target.path })}</p>
              {target && <p className="worktree-where worktree-target">{status.target.path}</p>}
              <dl className="worktree-facts">
                <div><dt>{t("Commits to merge")}</dt><dd>{status.ahead}</dd></div>
                {status.behind > 0 && target && <div><dt>{t("Commits it lacks from {target}", { target })}</dt><dd>{status.behind}</dd></div>}
                {status.changed > 0 && <div><dt>{t("Uncommitted files")}</dt><dd>{status.changed}</dd></div>}
              </dl>
              {status.changed > 0 && block !== "detached" && block !== "target-detached" && block !== "target-busy" && (
                <div className="worktree-option">
                  <label className="worktree-check">
                    <input type="checkbox" checked={commit} disabled={pending !== null} onChange={(event) => setCommit(event.target.checked)} />
                    <span>{t("Commit the uncommitted files first")}</span>
                  </label>
                  {files(status.changed_files, status.changed)}
                  {commit ? (
                    <label className="field worktree-message">
                      <span className="field-label">{t("Commit message")}</span>
                      <input className="input" value={message} disabled={pending !== null} autoComplete="off" maxLength={200} onChange={(event) => setTypedMessage(event.target.value)} />
                    </label>
                  ) : <p className="field-hint">{t("Left out, they stay in the worktree and are not merged.")}</p>}
                </div>
              )}
              {block === "conflicts" && status.conflicts && target && (
                <div className="worktree-alert" role="alert">
                  <p>{t("The merge would conflict in:")}</p>
                  {files(status.conflicts, status.conflicts.length)}
                  <p>{t("Ask the agent in this worktree to merge {target} into {branch} and resolve the conflicts, then merge again.", { target, branch: name ?? "" })}</p>
                </div>
              )}
              {block === "detached" && <p className="worktree-alert" role="alert">{t("This worktree is on no branch (detached HEAD), so there is no branch to merge.")}</p>}
              {block === "target-detached" && <p className="worktree-alert" role="alert">{t("The main checkout is on no branch (detached HEAD), so there is no branch to merge into.")}</p>}
              {block === "target-busy" && <p className="worktree-alert" role="alert">{t("The main checkout is in the middle of a merge or a rebase. Finish or abort it first.")}</p>}
              {block === "nothing" && target && <p className="field-hint">{t("Nothing to merge yet: {branch} has no commits that {target} lacks.", { branch: name ?? "", target })}</p>}
              {block === null && status.target.changed > 0 && target && <p className="field-hint">{t("{target} has uncommitted files of its own ({n}). git refuses the merge if it touches one of them.", { target, n: status.target.changed })}</p>}
            </>
          )}
          {pending === "merge" && <p className="field-hint" role="status">{t("Merging…")}</p>}
          {pending === "cleanup" && <p className="field-hint" role="status">{t("Deleting the checkout…")}</p>}
          {error && <p className="field-hint worktree-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button ref={cancel} type="button" className="btn btn-ghost" disabled={pending !== null} onClick={onClose}>{t(merged ? "Done" : "Cancel")}</button>
          {merged
            ? cleanup && <button type="button" className="btn btn-danger" disabled={pending !== null} onClick={() => void clean()}>{forced ? t("Delete anyway") : cleanup.label}</button>
            : <button type="button" className="btn btn-primary" disabled={pending !== null || !status || block !== null || (committing && message.trim() === "")} onClick={() => void merge()}>{target ? t("Merge into {target}", { target }) : t("Merge")}</button>}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
