import type { HerdrTab, PaneInfo } from "../../shared/protocol.ts";
import { folderName } from "./paneName.ts";

type TabTranslate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * The name a tab was given, or null while herdr names it itself: by its place in the row ("2"),
 * which herdr moves up when a tab before it closes while the tab keeps its number.
 */
export function customTabLabel(tab: Pick<HerdrTab, "label" | "number">, place: number = tab.number): string | null {
  const label = tab.label.trim();
  return label === "" || label === String(place) ? null : label;
}

/**
 * The folder a tab belongs to: the last folder of its first pane's working directory. That pane
 * is the one the tab opened with, so splitting the tab does not rename it. Null while herdr has
 * not reported a directory.
 */
export function tabFolder(tabId: string, panes: readonly Pick<PaneInfo, "tab_id" | "cwd">[]): string | null {
  const path = panes.find((pane) => pane.tab_id === tabId)?.cwd?.trim();
  return path ? folderName(path) : null;
}

/** Whether a name is already written from this folder: the folder alone, "Mouse 2" or "Mouse - Social". */
export function nameSaysFolder(name: string, folder: string): boolean {
  if (folder === "" || !name.startsWith(folder)) return false;
  const rest = name.slice(folder.length);
  return rest === "" || rest.startsWith(" - ") || /^ \d+$/.test(rest);
}

/**
 * A tab's name as the UI writes it: "Mouse 1" for a tab nobody named, "Mouse - Social" for one
 * named Social. A name that already says the folder is not given it twice: a worktree tab is
 * named after its checkout folder. Without a folder it reads "Tab 1" or "Social".
 */
export function folderTabName(folder: string | null, custom: string | null, place: number, t: TabTranslate): string {
  if (custom !== null) return folder === null || nameSaysFolder(custom, folder) ? custom : `${folder} - ${custom}`;
  return folder === null ? t("Tab {n}", { n: place }) : `${folder} ${place}`;
}

/** herdr names a tab by its place until it is renamed: the strip says so in words, from the tab's folder. */
export function tabLabel(tab: Pick<HerdrTab, "label" | "number">, t: TabTranslate, place: number = tab.number, folder: string | null = null): string {
  return folderTabName(folder, customTabLabel(tab, place), place, t);
}
