/**
 * Herdr's tab row, visible for a single tab too. Left-click selects; right-click opens
 * New tab / Rename / Close at the pointer. Pane actions belong to PaneCanvas.
 * A phone keeps an ellipsis on the selected tab as a touch entry to the same menu.
 * A tab whose panes are in a linked git checkout is a worktree (lib/tabWorktrees.ts): it wears
 * the branch glyph, its menu merges its branch into the main checkout, and its close asks what
 * becomes of the checkout.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ArrowLeft, ArrowRight, Ellipsis, GitBranch, GitMerge, Pencil, Plus, X } from "lucide-react";

import "./TabStrip.css";

import type { HerdrPane, HerdrTab, PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { useFacesArrived } from "../lib/fontFaces.ts";
import { focusWorkspaceListToggle } from "../lib/focus.ts";
import { useT } from "../lib/i18n.ts";
import { customTabLabel, tabLabel } from "../lib/tabName.ts";
import { STRIP_AT_REST, stripPlaced, stripScrolled, stripSelected, type StripScroll } from "../lib/tabStripScroll.ts";
import { PANE_TABPANEL_ID, paneTabPanelLabel } from "../lib/paneRegion.ts";
import { rosterPanes } from "../lib/dagPane.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { useTabReorder } from "../lib/useTabReorder.ts";
import { useTabWorktrees } from "../lib/useTabWorktrees.ts";
import type { TabWorktree } from "../lib/tabWorktrees.ts";
import { swipeTarget, watchTabSwipe, type TabSwipeOptions } from "../lib/tabSwipe.ts";
import { paneStatus, rollupStatus } from "../lib/status.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { BackgroundBadge, displayPaneTitle } from "./Sidebar.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { WorktreeCloseDialog } from "./WorktreeCloseDialog.tsx";
import { WorktreeMergeDialog } from "./WorktreeMergeDialog.tsx";

const said = (reason: unknown): string => reason instanceof ApiError ? reason.detail : reason instanceof Error ? reason.message : String(reason);

/** the pane each tab was last seen on, per PC: a tab clicked again opens where it was left */
const lastViewed = new Map<string, string>();

export interface TabStripProps {
  online: boolean;
  snapshot: SessionSnapshot;
  workspace: WorkspaceInfo;
  selectedPane: PaneInfo;
  onSelectPane: (paneId: string) => void;
  onNewTab: () => void;
  /** the pane region under the strip: on a touch screen a sideways stroke over it opens the tab beside (lib/tabSwipe.ts) */
  swipeHost?: HTMLElement | null;
}

export function TabStrip({ online, snapshot, workspace, selectedPane, onSelectPane, onNewTab, swipeHost = null }: TabStripProps) {
  const t = useT();
  const machineId = useMachineId();
  const { closeTab, renameTab, moveTab, removeWorktree } = useMachineApi();
  const touchMenu = useMediaQuery("(pointer: coarse), (max-width: 768px)");
  // a short phone screen (landscape, a small phone) has no height to spare: a lone tab is not
  // drawn there, so an approval card keeps its options in reach; its actions stay in the header
  const cramped = useMediaQuery("(max-width: 768px) and (max-height: 600px)");
  const strip = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState<{ anchor: HTMLElement; tab: HerdrTab; point?: { x: number; y: number }; previousFocus: HTMLElement | null; touch: boolean } | null>(null);
  const [editing, setEditing] = useState<{ tabId: string; value: string } | null>(null);
  // the name just sent, shown until herdr's snapshot carries it
  const [sent, setSent] = useState<{ tabId: string; label: string } | null>(null);
  const [confirm, setConfirm] = useState<{ tab: HerdrTab; title: string; body: string } | null>(null);
  // a worktree tab's close and merge keep the checkout they were opened for: the tab may go under them
  const [worktreeClose, setWorktreeClose] = useState<{ tab: HerdrTab; worktree: TabWorktree; title: string; warning: string | null; shared: boolean } | null>(null);
  const [merging, setMerging] = useState<{ tab: HerdrTab; worktree: TabWorktree; shared: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the tab whose name field just went: its button takes the focus back in the same commit, so the next key lands on it
  const refocus = useRef<string | null>(null);
  // the worktree dialog's own close is on its way: the tab leaving the snapshot is its doing
  const worktreeClosing = useRef(false);
  // tabs whose close is on its way: a second press, or a held Delete, does not send another
  const closing = useRef(new Set<string>());
  // A requested close: register focus return before the native snapshot can remove its tab.
  const closed = useRef<{ tabId: string; beside: string } | null>(null);
  // what is on screen now, for a close that answers after the selection or the PC has moved on
  const latest = useRef({ machineId, workspaceId: workspace.workspace_id, tabId: selectedPane.tab_id });
  const stripTab = (): HTMLElement | null => strip.current?.querySelector<HTMLElement>('.tab-strip-item.is-active [role="tab"]')
    ?? strip.current?.querySelector<HTMLElement>('[role="tab"]') ?? null;
  latest.current = { machineId, workspaceId: workspace.workspace_id, tabId: selectedPane.tab_id };
  const owner = JSON.stringify([machineId, workspace.workspace_id]);
  const previousOwner = useRef(owner);
  useLayoutEffect(() => {
    if (previousOwner.current === owner) return;
    previousOwner.current = owner;
    // Native IDs can repeat on another PC. A pending dialog never changes its target PC.
    setPicker(null); setEditing(null); setConfirm(null); setWorktreeClose(null); setMerging(null); setSent(null); setError(null);
    refocus.current = null; closed.current = null;
  }, [owner]);
  const panes = rosterPanes(snapshot.panes.filter((pane) => pane.workspace_id === workspace.workspace_id), selectedPane.pane_id);
  // The snapshot order is authoritative; number identifies a tab and does not change on a move.
  const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id);
  const { worktrees, refresh: refreshWorktrees } = useTabWorktrees(workspace, tabs, panes, online);
  const reorder = useTabReorder({ owner: `${machineId}:${workspace.workspace_id}`, tabs, strip, moveTab,
    failed: (reason) => setError(t("Move failed: {reason}", { reason: said(reason) })),
    stale: () => setError(t("Tab order did not refresh. Try again.")),
  });
  // what the snapshot holds now, for a deed that answers after it changed
  const snapshotTabs = useRef(tabs);
  snapshotTabs.current = tabs;
  const nameOf = (tab: HerdrTab): string => sent?.tabId === tab.tab_id ? sent.label : tabLabel(tab, t, tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id) + 1);

  useEffect(() => {
    lastViewed.set(`${machineId}:${selectedPane.tab_id}`, selectedPane.pane_id);
  }, [machineId, selectedPane.tab_id, selectedPane.pane_id]);

  // a picker, a name field or a question whose tab left (closed in the TUI) goes with it
  useEffect(() => {
    const here = (tabId: string): boolean => tabs.some((tab) => tab.tab_id === tabId);
    if (picker && !here(picker.tab.tab_id)) setPicker(null);
    if (editing && !here(editing.tabId)) setEditing(null);
    if (confirm && !here(confirm.tab.tab_id)) setConfirm(null);
    // a worktree dialog whose tab was closed elsewhere has nothing left to close; a merge still has its checkout
    if (worktreeClose && !here(worktreeClose.tab.tab_id) && !worktreeClosing.current) setWorktreeClose(null);
    if (sent && tabs.find((tab) => tab.tab_id === sent.tabId)?.label.trim() === sent.label) setSent(null);
  });
  // A touch-only trigger can disappear without crossing RowMenu's narrower sheet breakpoint.
  // Its tab remains the focus return target even after the ellipsis is removed.
  useLayoutEffect(() => {
    if (picker?.touch && (!touchMenu || picker.tab.tab_id !== selectedPane.tab_id)) setPicker(null);
  }, [touchMenu, selectedPane.tab_id, picker]);
  useLayoutEffect(() => {
    if (editing || !refocus.current) return;
    strip.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(refocus.current)}"]`)?.focus();
    refocus.current = null;
  }, [editing]);
  // once the snapshot has lost a closed tab, the focus it held goes to the tab beside it, or,
  // when the strip went with it (one pane left), where a closed row's focus goes
  useLayoutEffect(() => {
    const was = closed.current;
    if (!was || tabs.some((tab) => tab.tab_id === was.tabId)) return;
    closed.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && !strip.current?.contains(active)) return;
    const beside = strip.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(was.beside)}"]`) ?? stripTab();
    if (beside) beside.focus(); else focusWorkspaceListToggle();
  });
  // A tab that held the focus and went (closed here, in the TUI, or picked as the one beside a
  // close while the roster still listed it) drops the focus to the page: it goes to the open tab
  const focusedTab = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const was = focusedTab.current;
    if (!was || was.isConnected) return;
    focusedTab.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const tab = stripTab();
    if (tab) tab.focus(); else focusWorkspaceListToggle();
  });
  // a name herdr never showed back (renamed again elsewhere) does not stay on the tab
  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(() => setSent(null), 8000);
    return () => window.clearTimeout(timer);
  }, [sent]);
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [error]);

  // the open tab is in view: a pane opened from the sidebar, the palette or an alert can be on a
  // tab scrolled out of a phone's strip. Only the strip scrolls, never the page around it.
  const shown = panes.length > 0;
  const scroll = useRef<StripScroll>(STRIP_AT_REST);
  const bringOpenTab = (): void => {
    const row = strip.current;
    if (!row) { scroll.current = STRIP_AT_REST; return; }
    const open = row.querySelector<HTMLElement>(".tab-strip-item.is-active");
    if (!open) return;
    const view = row.getBoundingClientRect();
    const item = open.getBoundingClientRect();
    const end = row.querySelector<HTMLElement>(".tab-strip-add")?.getBoundingClientRect().left ?? view.right;
    const before = row.scrollLeft;
    if (item.left < view.left) row.scrollLeft -= view.left - item.left;
    else if (item.right > end) row.scrollLeft += item.right - end;
    // where the browser really left it; a strip that did not have to move may hold a scroll of
    // the user's whose event is still to come, and that one is left for the event to tell
    if (row.scrollLeft !== before || scroll.current.at === null) scroll.current = stripPlaced(scroll.current, row.scrollLeft);
  };
  useLayoutEffect(() => {
    scroll.current = stripSelected(scroll.current);
  }, [selectedPane.tab_id]);
  useLayoutEffect(bringOpenTab, [selectedPane.tab_id, tabs.length, shown, touchMenu]);
  // A face that arrives after that (lib/fontFaces.ts) redraws every name wider or narrower with
  // no tab added or opened, so the open tab is brought into view again for each: unless the user
  // has scrolled the strip themselves since a tab was last opened (lib/tabStripScroll.ts), and is
  // looking at other tabs. A chunk can come long after the page, with the first Korean on it.
  const faces = useFacesArrived();
  useLayoutEffect(() => {
    if (!scroll.current.moved) bringOpenTab();
  }, [faces]);
  const onScroll = (): void => {
    const row = strip.current;
    if (row) scroll.current = stripScrolled(scroll.current, row.scrollLeft, row.scrollWidth - row.clientWidth);
  };

  // What a stroke over the pane may do, as this render has it; null while the tabs are not the
  // finger's to move. The listeners are bound once per host and read it when a finger comes down.
  const swipe = useRef<Pick<TabSwipeOptions, "beside" | "open"> | null>(null);
  useEffect(() => {
    const surface = swipeHost?.parentElement;
    if (!swipeHost || !surface) return;
    return watchTabSwipe(surface, swipeHost, {
      enabled: () => swipe.current !== null,
      beside: (step) => swipe.current?.beside(step) ?? null,
      open: (step) => swipe.current?.open(step),
    });
  }, [swipeHost]);

  if (!shown || (cramped && tabs.length === 1)) { swipe.current = null; return null; }

  // a tab of another workspace (a stroke past this row's end leads there) is read from that workspace's own roster
  const panesOf = (tab: HerdrTab): HerdrPane[] => (tab.workspace_id === workspace.workspace_id ? panes
    : rosterPanes(snapshot.panes.filter((pane) => pane.workspace_id === tab.workspace_id))).filter((pane) => pane.tab_id === tab.tab_id);
  const paneFor = (tab: HerdrTab): PaneInfo | undefined => {
    const own = panesOf(tab);
    const pick = (id: string | null | undefined) => (id ? own.find((pane) => pane.pane_id === id) : undefined);
    return pick(lastViewed.get(`${machineId}:${tab.tab_id}`))
      ?? pick(snapshot.layouts?.find((layout) => layout.tab_id === tab.tab_id)?.focused_pane_id)
      ?? own.find((pane) => pane.focused)
      ?? own[0];
  };

  // Where a stroke leads: the tab beside the open one, or past this row's end the workspace
  // beside this one (lib/tabSwipe.ts swipeTarget), when it has a pane to open. Not under a name
  // field, a menu or a move still on its way.
  const besideOpen = (step: -1 | 1) => swipeTarget(snapshot.workspaces, snapshot.tabs, selectedPane.tab_id, step, (tab) => paneFor(tab) !== undefined);
  swipe.current = editing || picker || confirm || worktreeClose || merging || reorder.moving || reorder.drag ? null : {
    beside: (step) => {
      const target = besideOpen(step);
      if (!target) return null;
      if (target.workspace === null) return nameOf(target.tab);
      // another workspace is named first; its tab too, where it has more than the one
      const theirs = snapshot.tabs.filter((tab) => tab.workspace_id === target.tab.workspace_id);
      return theirs.length > 1 ? `${target.workspace.label} · ${tabLabel(target.tab, t, theirs.indexOf(target.tab) + 1)}` : target.workspace.label;
    },
    open: (step) => { const target = besideOpen(step); const pane = target ? paneFor(target.tab) : undefined; if (pane) onSelectPane(pane.pane_id); },
  };

  const focusTab = (tabId: string): void => {
    window.requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${CSS.escape(tabId)}"]`)?.focus());
  };

  const beginRename = (tab: HerdrTab): void => {
    setError(null);
    setEditing({ tabId: tab.tab_id, value: sent?.tabId === tab.tab_id ? sent.label : customTabLabel(tab, tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id) + 1) ?? "" });
  };
  // an empty name is not sent: herdr would keep it, and its own tab row would show nothing
  const saveRename = (tab: HerdrTab): void => {
    const label = editing?.value.trim() ?? "";
    refocus.current = tab.tab_id;
    setEditing(null);
    if (label === "" || label === nameOf(tab)) return;
    setSent({ tabId: tab.tab_id, label });
    void renameTab(tab.tab_id, label).catch((reason: unknown) => {
      if (latest.current.machineId !== machineId || latest.current.workspaceId !== workspace.workspace_id) return;
      setSent((current) => current?.tabId === tab.tab_id ? null : current);
      setError(t("Rename failed: {reason}", { reason: said(reason) }));
    });
  };

  // the tab beside a closed one takes its place: the open pane moves there, and the focus with it
  const close = async (tab: HerdrTab): Promise<void> => {
    const index = tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id);
    const beside = tabs[index + 1] ?? tabs[index - 1];
    const key = JSON.stringify([machineId, workspace.workspace_id, tab.tab_id]);
    if (closing.current.has(key)) return;
    closing.current.add(key);
    // Herdr can publish the removal before the HTTP acknowledgement arrives. The removal
    // commit must already know where the disappearing tab's keyboard focus belongs.
    const focusAfterClose = beside ? { tabId: tab.tab_id, beside: beside.tab_id } : null;
    if (focusAfterClose) closed.current = focusAfterClose;
    try { await closeTab(tab.tab_id); }
    catch (reason) {
      if (closed.current === focusAfterClose) closed.current = null;
      throw reason;
    } finally { closing.current.delete(key); }
    // the answer may come after another tab, workspace or PC was picked: the open pane, and the focus, then stay
    if (latest.current.machineId !== machineId || latest.current.workspaceId !== workspace.workspace_id) return;
    // the last tab took its workspace, and the strip, with it: focus goes where a closed row's goes
    if (!beside) { focusWorkspaceListToggle(); return; }
    const pane = paneFor(beside);
    if (latest.current.tabId === tab.tab_id && pane) onSelectPane(pane.pane_id);
    if (strip.current?.contains(document.activeElement) || document.activeElement === document.body) focusTab(beside.tab_id);
  };
  const requestClose = (tab: HerdrTab): void => {
    setError(null);
    // a turn that waits on its background work would lose that work too
    const busy = panesOf(tab).some((pane) => { const status = paneStatus(pane as HerdrPane); return status === "working" || status === "blocked" || status === "waiting"; });
    const warning = tabs.length > 1
      ? (busy ? t("An agent in it is still at work, and stops with the tab.") : null)
      : t("It is the last tab of {workspace}: the workspace closes with it, and the agents and shells in it stop.", { workspace: workspace.label });
    // a worktree tab always asks: what becomes of its checkout is the question
    const worktree = worktrees.get(tab.tab_id);
    if (worktree) {
      setWorktreeClose({ tab, worktree, title: t("Close tab {name}?", { name: nameOf(tab) }), warning, shared: sharesCheckout(tab, worktree) });
      return;
    }
    if (warning === null) {
      void close(tab).catch((reason: unknown) => setError(t("Close failed: {reason}", { reason: said(reason) })));
      return;
    }
    setConfirm({ tab, title: t("Close tab {name}?", { name: nameOf(tab) }), body: warning });
  };
  /** another tab of the workspace is in the same checkout: it is not one tab's to delete */
  const sharesCheckout = (tab: HerdrTab, worktree: TabWorktree): boolean => tabs.some((other) => other.tab_id !== tab.tab_id && worktrees.get(other.tab_id)?.path === worktree.path);
  /** a tab already gone (closed in the TUI while a dialog stood) is closed: the deed goes on */
  const closeIfHere = async (tab: HerdrTab): Promise<void> => {
    if (!snapshotTabs.current.some((candidate) => candidate.tab_id === tab.tab_id)) return;
    worktreeClosing.current = true;
    try { await close(tab); } finally { worktreeClosing.current = false; }
  };

  // arrows move between the tabs; Enter or Space on one opens it, as any button; F2 names it, Delete closes it
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault(); event.stopPropagation();
      const tabId = buttons[index]?.dataset["tabId"];
      if (tabId && !event.repeat) reorder.moveAdjacent(tabId, event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const anchor = buttons[index]!;
      const tab = tabs.find((candidate) => candidate.tab_id === anchor.dataset["tabId"]);
      if (tab && !event.repeat) setPicker({ anchor, tab, previousFocus: anchor, touch: false });
      return;
    }
    if (event.key === "F2" || event.key === "Delete") {
      // a held key is one press: the focus moves to the tab beside a closed one
      if (event.repeat) { event.preventDefault(); return; }
      const tab = tabs.find((candidate) => candidate.tab_id === buttons[index]?.dataset["tabId"]);
      if (!tab) return;
      event.preventDefault();
      if (event.key === "F2") beginRename(tab); else requestClose(tab);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const openPicker = (event: MouseEvent<HTMLElement>, tab: HerdrTab): void => {
    reorder.cancelDrag();
    const touch = event.type !== "contextmenu";
    const tabButton = event.currentTarget.parentElement?.querySelector<HTMLElement>('[role="tab"]') ?? null;
    setPicker(touch && picker?.tab.tab_id === tab.tab_id ? null : { anchor: event.currentTarget, tab,
      point: !touch && (event.clientX !== 0 || event.clientY !== 0) ? { x: event.clientX, y: event.clientY } : undefined,
      previousFocus: touch ? tabButton : document.activeElement instanceof HTMLElement ? document.activeElement : null, touch });
  };

  // Native tab menu: pane actions live on the pane itself.
  const pickerItems = (tab: HerdrTab): RowMenuItem[] => [
    ...(!reorder.moving && tabs.findIndex((entry) => entry.tab_id === tab.tab_id) > 0
      ? [{ id: "move-left", label: t("Move tab left"), icon: ArrowLeft, run: () => reorder.moveAdjacent(tab.tab_id, -1) }] : []),
    ...(!reorder.moving && tabs.findIndex((entry) => entry.tab_id === tab.tab_id) < tabs.length - 1
      ? [{ id: "move-right", label: t("Move tab right"), icon: ArrowRight, run: () => reorder.moveAdjacent(tab.tab_id, 1) }] : []),
    { id: "new-tab", label: t("New tab"), icon: Plus, run: onNewTab },
    { id: "rename-tab", label: t("Rename tab"), icon: Pencil, run: () => beginRename(tab) },
    ...(worktrees.has(tab.tab_id) ? [{ id: "merge-worktree", label: t("Merge worktree…"), icon: GitMerge, divider: true,
      run: () => { const worktree = worktrees.get(tab.tab_id); if (worktree) setMerging({ tab, worktree, shared: sharesCheckout(tab, worktree) }); } }] : []),
    { id: "close-tab", label: t("Close tab"), icon: X, danger: true, run: () => requestClose(tab) },
  ];

  // the pane region every tab governs, as App names it. App gives that region the tabpanel role
  // only while the pane's own tab is in this snapshot (paneTabPanelLabel); the same call answers
  // here, so a tab never claims to control a panel that is not standing there as one.
  const panePanel = paneTabPanelLabel(snapshot, selectedPane, t) !== null ? PANE_TABPANEL_ID : undefined;
  return (
    <>
      <div ref={strip} className="tab-strip" role="tablist" aria-label={t("Tabs of {workspace}", { workspace: workspace.label })} aria-busy={reorder.moving} onKeyDown={onKeyDown} onScroll={onScroll}
        onFocus={(event) => { if (event.target.getAttribute("role") === "tab") focusedTab.current = event.target; }}
        onBlur={(event) => { if (event.relatedTarget !== null) focusedTab.current = null; }}>
        {tabs.map((tab, index) => {
          const active = tab.tab_id === selectedPane.tab_id;
          const own = panesOf(tab);
          // Settle each pane's wait before rolling up, keeping ongoing work visible.
          const status = online ? rollupStatus(own.map(paneStatus)) : "unknown";
          const backgroundTasks = online ? own.reduce((count, pane) => count + (pane.background_tasks ?? 0), 0) : 0;
          const pickerOpen = picker?.tab.tab_id === tab.tab_id;
          const name = nameOf(tab);
          const worktree = worktrees.get(tab.tab_id);
          const paneTitle = own.length === 1 && own[0] ? displayPaneTitle(own[0]) : t("{n} panes", { n: own.length });
          return (
            <div className={`tab-strip-item${active ? " is-active" : ""}${own.length > 1 ? " has-panes" : ""}${editing?.tabId === tab.tab_id ? " is-editing" : ""}${reorder.drag?.tabId === tab.tab_id ? " is-dragging" : ""}${reorder.drag?.boundary === index ? " is-drop-before" : ""}${reorder.drag?.boundary === tabs.length && index === tabs.length - 1 ? " is-drop-after" : ""}`} key={tab.tab_id}>
              {editing?.tabId === tab.tab_id ? (
                <input
                  className="input tab-strip-rename"
                  aria-label={t("Tab name")}
                  autoFocus
                  size={Math.max(8, editing.value.length + 1)}
                  maxLength={80}
                  placeholder={name}
                  value={editing.value}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setEditing({ tabId: tab.tab_id, value: event.target.value })}
                  onBlur={() => setEditing(null)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    // an IME's Enter and Escape are the composition's, not the field's
                    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                    if (event.key === "Enter") saveRename(tab);
                    if (event.key === "Escape") { refocus.current = tab.tab_id; setEditing(null); }
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  className="tab-strip-tab"
                  data-tab-id={tab.tab_id}
                  aria-selected={active}
                  aria-haspopup="menu"
                  aria-keyshortcuts="Shift+F10 Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
                  aria-controls={panePanel}
                  tabIndex={active ? 0 : -1}
                  title={worktree ? `${paneTitle} · ${worktree.branch ?? t("Detached HEAD")}` : paneTitle}
                  onPointerDown={(event) => reorder.onPointerDown(event, tab.tab_id)}
                  onPointerMove={reorder.onPointerMove}
                  onPointerUp={reorder.onPointerUp}
                  onPointerCancel={reorder.cancelDrag}
                  onLostPointerCapture={reorder.cancelDrag}
                  onDragStart={(event) => event.preventDefault()}
                  onMouseDown={(event) => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) event.preventDefault(); }}
                  onClick={(event) => {
                    if (reorder.consumeClick(event.detail) || event.ctrlKey) return;
                    event.currentTarget.focus({ preventScroll: true });
                    const pane = paneFor(tab);
                    if (pane && pane.pane_id !== selectedPane.pane_id) onSelectPane(pane.pane_id);
                  }}
                  onDoubleClick={() => beginRename(tab)}
                  onContextMenu={(event) => { event.preventDefault(); openPicker(event, tab); }}
                  // the middle button closes a tab, as it does a browser's
                  onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); requestClose(tab); } }}
                >
                  {(status === "working" || status === "blocked" || status === "waiting" || status === "done") && <span className="tab-strip-dot" data-status={status} aria-hidden="true" />}
                  {worktree && <GitBranch className="tab-strip-branch" role="img" aria-label={t("Worktree on {branch}", { branch: worktree.branch ?? t("Detached HEAD") })} />}
                  <span className="tab-strip-label">{name}</span>
                  <BackgroundBadge count={backgroundTasks} />
                </button>
              )}
              {touchMenu && active && editing?.tabId !== tab.tab_id && <button type="button" className="tab-strip-menu" aria-label={t("Actions for {tab}", { tab: name })} aria-haspopup="menu" aria-expanded={pickerOpen} onClick={(event) => openPicker(event, tab)}>
                <Ellipsis aria-hidden="true" />
              </button>}
            </div>
          );
        })}
        <button type="button" className="tab-strip-add" aria-label={t("New tab")} title={t("New tab")} onClick={onNewTab}>
          <Plus aria-hidden="true" />
        </button>
        {error && <span className="tab-strip-error" role="alert">{error}</span>}
      </div>
      {picker && <RowMenu anchor={picker.anchor} point={picker.point} restoreFocusTo={picker.previousFocus}
        title={nameOf(picker.tab)} items={pickerItems(picker.tab)} align="start" onClose={() => setPicker(null)} />}
      {confirm && <ConfirmDialog title={confirm.title} body={confirm.body} confirmLabel={t("Close tab")} onConfirm={async () => { await close(confirm.tab); setConfirm(null); }} onClose={() => setConfirm(null)} />}
      {worktreeClose && <WorktreeCloseDialog title={worktreeClose.title} warning={worktreeClose.warning} workspaceId={workspace.workspace_id} worktree={worktreeClose.worktree} shared={worktreeClose.shared}
        onCloseTab={async () => { await closeIfHere(worktreeClose.tab); setWorktreeClose(null); }} onDeleted={refreshWorktrees} onClose={() => setWorktreeClose(null)} />}
      {merging && <WorktreeMergeDialog workspaceId={workspace.workspace_id} path={merging.worktree.path} branch={merging.worktree.branch} onMerged={refreshWorktrees} onClose={() => setMerging(null)}
        // the checkout goes before the tab, so a refusal leaves the tab standing; a checkout another tab is in stays
        cleanup={merging.shared ? null : { label: t("Close tab and delete worktree"), run: async (force) => {
          await removeWorktree({ workspace_id: workspace.workspace_id, path: merging.worktree.path, force, delete_branch: true });
          refreshWorktrees();
          await closeIfHere(merging.tab);
        } }} />}
    </>
  );
}
