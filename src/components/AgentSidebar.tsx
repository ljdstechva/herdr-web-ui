import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Terminal } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { folderName } from "../lib/paneName.ts";
import { agentContext, agentRowTitle, agentTabName, paneMark, sidebarAgents } from "../lib/sidebarAgents.ts";
import { useSettings } from "../lib/settings.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { activityOrder } from "../lib/sidebarOrder.ts";
import { AgentMark, hasAgentMark } from "./AgentMark.tsx";
import { BackgroundBadge, displayPaneTitle, StatusBadge } from "./Sidebar.tsx";
import "./AgentSidebar.css";

interface AgentRowBodyProps {
  /** the agent's kind or name; null draws a terminal, for a shell */
  mark: string | null;
  /** the kind the mark draws, left off the second line: said for a screen reader, since the mark is aria-hidden */
  markKind: string | null;
  title: string;
  context: string;
  backgroundTasks?: number;
  status?: AgentStatus;
}

/**
 * One agent in a list: the coding agent's mark, the name its owner knows it by, the folder it
 * works in, and how it is doing.
 */
function AgentRowBody({ mark, markKind, title, context, backgroundTasks, status }: AgentRowBodyProps) {
  return <>
    <span className="sidebar-mark" aria-hidden="true">{mark !== null ? <AgentMark agent={mark} size={18} /> : <Terminal />}</span>
    <span className="agent-copy">
      {markKind && <span className="visually-hidden">{markKind}: </span>}
      <span className="agent-title">{title}</span>
      {context && <span className="agent-context">{context}</span>}
    </span>
    <span className="agent-row-status"><BackgroundBadge count={backgroundTasks} /><StatusBadge status={status} compact /></span>
  </>;
}

export interface AgentSidebarProps {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  /** a PC's state in words, for the tooltip of a row whose PC is not connected */
  stateWord(machine: Machine): string;
  onSelect(machineId: string, paneId: string): void;
}

/** the width under which the sidebar is a drawer (src/styles.css) */
const DRAWER_QUERY = "(max-width: 768px)";

/**
 * All PCs' live agents form a second list; workspace and PC folds do not hide these rows.
 * In the phone's drawer the list starts folded, leaving the room to the workspaces.
 */
export function AgentSidebar({ machines, selectedMachineId, selectedPaneId, stateWord, onSelect }: AgentSidebarProps) {
  const t = useT();
  const listId = useId();
  const [collapsed, setCollapsed] = useState(() => window.matchMedia?.(DRAWER_QUERY).matches === true);
  const { settings } = useSettings();
  const activity = useSidebarActivity();
  // Settings → Agents order: herdr's order, or Activity within each PC (each herdr counts its own changes)
  const byActivity = settings.agentOrder === "activity";
  const rows = useMemo(() => machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return (byActivity ? activityOrder(agents, (entry) => entry.pane, activity.seqs(machine.id)) : agents).map((entry) => ({ machine, entry }));
  }), [machines, byActivity, activity]);

  return <section className={`agents-sidebar${collapsed ? " is-collapsed" : ""}${rows.length === 0 ? " is-empty" : ""}`} aria-label={t("Agents")}>
    <button type="button" className="agent-section-toggle sidebar-section-label" aria-expanded={!collapsed} aria-controls={listId} onClick={() => setCollapsed(!collapsed)}>
      {collapsed ? <ChevronRight className="agent-section-caret" aria-hidden="true" /> : <ChevronDown className="agent-section-caret" aria-hidden="true" />}
      <span>{t("Agents")}</span>
      {collapsed && rows.length > 0 && <span className="agent-section-count">{rows.length}</span>}
    </button>
    <div className="agent-list-contents" id={listId} hidden={collapsed}>
      {rows.length === 0 ? <p className="agent-empty" role="status">{t("No agents running")}</p> : <ul className="agent-list">
        {rows.map(({ machine, entry }) => {
          const { pane, workspace, tab, agent, agentLabel } = entry;
          const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
          const online = machine.state === "connected";
          const tabs = machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === workspace.workspace_id) ?? [];
          const tabName = agentTabName(tab, tabs, t);
          // the row is named as its owner named it (workspace, tab, pane); what the agent is doing is the tooltip's
          const title = agentRowTitle({ paneLabel: pane.label, workspaceLabel: workspace.label, tabName });
          const task = agent?.title?.trim() || pane.title?.trim() || displayPaneTitle(pane);
          const name = agent?.name?.trim() || null;
          // the live name (claude-6) is for tools that address the agent, not a word to read in the row: a
          // label that is only that name says the kind instead
          const kindLabel = name !== null && agentLabel === name ? entry.canonicalAgent ?? agent?.title?.trim() ?? null : agentLabel;
          const mark = paneMark(entry);
          const markAgent = mark && hasAgentMark(mark) ? mark : null;
          // this PC is the one the list is mostly of: only another PC is named on the line
          const otherPc = machines.length > 1 && machine.kind !== "local" ? machine.name : null;
          const contextParts = agentContext({ agentLabel: kindLabel, title, markAgent, machineName: otherPc, folder: pane.cwd ? folderName(pane.cwd) : "", workspaceLabel: workspace.label });
          const context = contextParts.join(" · ");
          const kind = kindLabel?.trim() || null;
          const markKind = kind && kind !== title.trim() && !contextParts.includes(kind) ? kind : null;
          const tooltip = [...new Set([pane.pane_id, title, task, context, markKind, name, agent?.display_agent, machines.length > 1 ? machine.name : null, pane.cwd, online ? null : stateWord(machine)].filter(Boolean))].join("\n");
          return <li className={`agent-item${selected ? " is-selected" : ""}${online ? "" : " is-offline"}`} key={paneStorageId(machine.id, pane.pane_id)} data-machine={machine.id} data-pane={pane.pane_id}>
            <button type="button" className="agent-select agent-row" disabled={!online} aria-current={selected ? "true" : undefined} title={tooltip} onClick={() => onSelect(machine.id, pane.pane_id)}>
              {/* a saved roster's state is not news: a PC that is away says nothing about its agents */}
              <AgentRowBody mark={mark} markKind={markKind} title={title} context={context} backgroundTasks={online ? pane.background_tasks : 0} status={online ? activity.status(machine.id, pane) : undefined} />
            </button>
          </li>;
        })}
      </ul>}
    </div>
  </section>;
}
