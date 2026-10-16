import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { FolderOpen, GitBranch, X } from "lucide-react";

import "./NewSessionDialog.css";

import type { AgentKind, WorktreeEntry } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { AgentPicker, rememberAgent, rememberedAgent } from "./AgentPicker.tsx";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { Toggle } from "./SettingsControls.tsx";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { worktreeTabLabel } from "../lib/tabWorktrees.ts";
import { suggestWorktreeBranch } from "../lib/worktreeName.ts";

/** The dialog as New tab: the workspace the tab joins, whose folder it uses, and the number herdr will give it. */
export interface NewTabTarget {
  workspaceId: string;
  workspaceLabel: string;
  cwd: string | null;
  number: number;
}

/** how many kept worktrees the dialog names: the rest are still opened by typing their branch */
const MAX_CHECKOUTS = 6;

/** whether the last tab made in a repository was a worktree: the switch starts where it was left */
const WORKTREE_KEY = "herdr-web-ui:new-tab-worktree";
function rememberedWorktree(): boolean {
  try { return localStorage.getItem(WORKTREE_KEY) === "1"; } catch { return false; }
}
function rememberWorktree(on: boolean): void {
  try { if (on) localStorage.setItem(WORKTREE_KEY, "1"); else localStorage.removeItem(WORKTREE_KEY); } catch { /* private mode: the switch starts off */ }
}

export interface NewSessionDialogProps {
  open: boolean;
  machineName?: string;
  defaultCwd: string | null;
  /** set, the dialog makes a tab in that workspace instead of a workspace */
  tab?: NewTabTarget | null;
  onClose: () => void;
  /** `agentStarted`: the pane runs the agent asked for, so it opens in an agent's lens */
  onCreated: (paneId: string, agentStarted: boolean) => void;
  /** fields a link fills for this opening (`?new=`, lib/deepLink.ts); an agent herdr does not offer is left out */
  prefill?: DialogFields | null;
  /** what the fields say, a moment after they change, for the address */
  onDraft?: (fields: DialogFields) => void;
}

export interface DialogFields {
  cwd: string | null;
  name: string | null;
  /** "" is a shell; null keeps the last agent picked */
  agent: string | null;
}

/** how long the fields rest before the address follows them: Safari refuses a burst of history writes */
const DRAFT_MS = 400;

function directoryBasename(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.split("/").pop() ?? "";
}

export function NewSessionDialog({ open, defaultCwd, tab = null, onClose, onCreated, machineName, prefill = null, onDraft }: NewSessionDialogProps) {
  const t = useT();
  const machineId = useMachineId();
  const { createTab, createWorkspace, createWorktreeTab, fetchAgentKinds, listWorktrees } = useMachineApi();
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [agentKind, setAgentKind] = useState(rememberedAgent);
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [name, setName] = useState("");
  // the workspace is in a git repository, so the tab can be a worktree of it: herdr's listing of
  // its checkouts says so (the snapshot names a repository only once a worktree was opened from it)
  const [repository, setRepository] = useState(false);
  // the worktrees the repository already has on disk: a tab can open in one again
  const [checkouts, setCheckouts] = useState<WorktreeEntry[]>([]);
  const [asWorktree, setAsWorktree] = useState(rememberedWorktree);
  const [branch, setBranch] = useState(suggestWorktreeBranch);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdPaneId, setCreatedPaneId] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const firstFieldRef = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLFormElement>(open, { initialFocus: firstFieldRef });
  const defaultCwdRef = useRef(defaultCwd);
  defaultCwdRef.current = defaultCwd;
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;

  useEffect(() => {
    if (!open) return;
    const filled = prefillRef.current;
    setCwd(filled?.cwd ?? defaultCwdRef.current ?? "");
    setName(filled?.name ?? "");
    setAsWorktree(rememberedWorktree());
    setBranch(suggestWorktreeBranch());
    setRepository(false);
    setCheckouts([]);
    setError(null);
    setPending(false);
    setCreatedPaneId(null);
    setBrowsing(false);
    const remembered = rememberedAgent();
    const stored = filled?.agent ?? remembered;
    setAgentKind(stored);
    let cancelled = false;
    void fetchAgentKinds()
      .then((next) => {
        if (cancelled) return;
        setAgents(next);
        // a linked agent herdr does not offer gives way to the last one picked, as an unknown remembered one does to a shell
        if (stored && !next.some((agent) => agent.kind === stored)) setAgentKind(stored !== remembered && next.some((agent) => agent.kind === remembered) ? remembered : "");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const tabWorkspaceId = tab?.workspaceId ?? null;
  useEffect(() => {
    if (!open || tabWorkspaceId === null) return;
    let cancelled = false;
    // a folder that is no repository, or a PC from before worktrees: the tab is a plain one
    listWorktrees(tabWorkspaceId).then((listing) => {
      if (cancelled) return;
      setRepository(true);
      // one a workspace is on is that workspace's, not a tab's to open and later delete
      setCheckouts((Array.isArray(listing.worktrees) ? listing.worktrees : []).filter((entry) => entry.is_linked_worktree && !entry.is_bare && !entry.is_prunable && !entry.open_workspace_id && entry.branch !== null));
    }, () => undefined);
    return () => { cancelled = true; };
  }, [open, tabWorkspaceId, listWorktrees]);

  useEffect(() => {
    if (!open || !onDraft) return;
    const timer = window.setTimeout(() => onDraft({ cwd: cwd || null, name: name || null, agent: agentKind }), DRAFT_MS);
    return () => window.clearTimeout(timer);
  }, [open, onDraft, cwd, name, agentKind]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // a native modal over it (Add PC, from the palette) takes its own Escape
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.preventDefault();
      if (!pending) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, pending]);

  if (!open) return null;

  // a worktree only where there is a repository to make one of
  const worktree = tab !== null && repository && asWorktree;
  const existing = worktree && checkouts.some((entry) => entry.branch === branch.trim());
  const selectedAgent = agents.find((agent) => agent.kind === agentKind);
  const pendingLabel = worktree ? (existing ? t("Opening…") : t("Creating the checkout…")) : selectedAgent ? t("Starting {agent}… up to 60s", { agent: selectedAgent.label }) : t("Starting shell…");
  const fieldsDisabled = pending || createdPaneId !== null;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    if (createdPaneId !== null) { onCreated(createdPaneId, false); return; }
    setPending(true);
    setError(null);
    try {
      rememberAgent(agentKind);
      const agent = agentKind ? { kind: agentKind } : null;
      if (tab && repository) rememberWorktree(asWorktree);
      // a tab keeps the workspace's folder, which the dialog shows and does not ask for; a
      // worktree tab gets a checkout of its own, on its own branch, and opens there
      const result = worktree
        ? await createWorktreeTab({ workspace_id: tab.workspaceId, branch: branch.trim(), label: name.trim() || null, agent })
        : tab
        ? await createTab({ workspace_id: tab.workspaceId, cwd: tab.cwd, label: name.trim() || null, agent })
        : await createWorkspace({ cwd: cwd.trim() || null, label: name.trim() || null, agent });
      if (agentKind && !result.agent_started && result.error?.message) {
        setPending(false);
        setError(result.error.message);
        setCreatedPaneId(result.pane_id);
        return;
      }
      // the dialog closes on this: left pending, its next opening would start a frame with the
      // fields disabled and Escape ignored, until the open effect's reset has rendered
      setPending(false);
      onCreated(result.pane_id, agentKind !== "" && result.agent_started !== false);
    } catch (reason: unknown) {
      setPending(false);
      if (reason instanceof ApiError && reason.code === "invalid_cwd") setError(t("Directory not found"));
      // git's own words about a refused checkout (a branch another checkout is on, a folder that exists)
      else if (reason instanceof ApiError && worktree) setError(reason.detail);
      else setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };

  return (
    <div className="modal-scrim new-session-scrim" onMouseDown={closeFromScrim}>
      <form ref={surface} className="modal new-session-modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title" tabIndex={-1} onSubmit={(event) => void submit(event)}>
        <header className="modal-header">
          <h2 className="modal-title" id="new-session-title">{tab ? `${t("New tab")} · ${tab.workspaceLabel}` : `${t("New workspace")} · ${machineName ?? machineId}`}</h2>
          <button type="button" className="icon-button" aria-label={t("Close dialog")} disabled={pending} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <div className="field">
            <span className="field-label" id="new-session-agent">{t("Agent")}</span>
            <AgentPicker ref={firstFieldRef} agents={agents} value={agentKind} disabled={fieldsDisabled} labelledBy="new-session-agent" onChange={setAgentKind} />
          </div>
          {tab && repository && (
            <div className="field">
              <div className="new-session-switch">
                <span className="new-session-switch-copy"><GitBranch aria-hidden="true" />{t("New worktree")}</span>
                <Toggle checked={asWorktree} label={t("New worktree")} disabled={fieldsDisabled} onChange={setAsWorktree} />
              </div>
              <span className="field-hint">{t("The tab works on a branch and a checkout of its own, so several agents can work on this project at once. Merge it back from the tab's menu.")}</span>
            </div>
          )}
          {worktree ? (
            <div className="field">
              <label className="field-label" htmlFor="new-session-branch">{t("Branch")}</label>
              <input id="new-session-branch" className="input" value={branch} disabled={fieldsDisabled} required autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={(event) => setBranch(event.target.value)} />
              <span className="field-hint">{existing
                ? t("This branch has a worktree on disk already: the tab opens in it.")
                : t("A new branch from where this workspace is now, or an existing one to check out. The checkout goes under herdr's worktree folder.")}</span>
              {checkouts.length > 0 && (
                <span className="new-session-checkouts" role="group" aria-label={t("Worktrees on disk")}>
                  <span className="field-hint">{t("Worktrees on disk")}</span>
                  {checkouts.slice(0, MAX_CHECKOUTS).map((entry) => (
                    <button type="button" key={entry.path} className="new-session-checkout" aria-pressed={entry.branch === branch.trim()} disabled={fieldsDisabled} title={entry.path} onClick={() => setBranch(entry.branch ?? "")}>{worktreeTabLabel(entry.branch ?? "")}</button>
                  ))}
                </span>
              )}
            </div>
          ) : tab ? (
            <div className="field">
              <span className="field-label">{t("Directory")}</span>
              <div className="new-session-folder">
                <FolderOpen aria-hidden="true" />
                <span>{tab.cwd ?? tab.workspaceLabel}</span>
              </div>
              <span className="field-hint">{t("Uses the workspace's folder")}</span>
            </div>
          ) : (
            <div className="field">
              <label className="field-label" htmlFor="new-session-cwd">{t("Directory")}</label>
              <div className="new-session-cwd">
                <input id="new-session-cwd" className="input" value={cwd} disabled={fieldsDisabled} autoComplete="off" onChange={(event) => setCwd(event.target.value)} />
                <button type="button" className="btn" aria-expanded={browsing} disabled={fieldsDisabled} onClick={() => setBrowsing((open) => !open)}>
                  <FolderOpen aria-hidden="true" />
                  {t("Browse")}
                </button>
              </div>
              {browsing && <DirectoryBrowser start={cwd} onPick={(picked) => { setCwd(picked); setBrowsing(false); }} />}
              <span className="field-hint">{t("absolute path or ~/…")}</span>
            </div>
          )}
          <label className="field">
            <span className="field-label">{t("Name")}</span>
            <input
              className="input"
              value={name}
              disabled={fieldsDisabled}
              autoComplete="off"
              placeholder={worktree ? worktreeTabLabel(branch) : tab ? String(tab.number) : directoryBasename(cwd)}
              onChange={(event) => setName(event.target.value)}
            />
            <span className="field-hint">{t(tab ? "Tab name (optional)" : "Optional workspace label")}</span>
          </label>
          {pending && <p className="new-session-note" role="status">{pendingLabel}</p>}
          {error && <p className="field-hint new-session-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={pending || (worktree && createdPaneId === null && branch.trim() === "")}>{t(pending ? "Starting…" : createdPaneId !== null ? "Open" : "Start")}</button>
        </footer>
      </form>
    </div>
  );
}
