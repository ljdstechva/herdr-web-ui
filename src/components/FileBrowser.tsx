import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDownAZ, ArrowDownWideNarrow, ArrowUp, Copy, Download, Ellipsis, FileText, Folder, FolderOpen, FolderPlus, House, Info, X } from "lucide-react";

import "./DirectoryBrowser.css";
import "./FileBrowser.css";

import type { DirectoryListing, StorageUsage } from "../../shared/protocol.ts";
import { folderName, folderNameProblem } from "../../shared/storage.ts";
import { ApiError } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { downloads } from "../lib/downloads.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { browserRows, childPath, formatSize, volumeUsed, type BrowserRow, type RowOrder } from "../lib/storage.ts";
import { homeRelative } from "./DirectoryBrowser.tsx";
import { FileDetails } from "./FileDetails.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";

export interface FileBrowserProps {
  /** where to open: absolute, `~` or `~/…`; empty or unreadable opens home */
  start: string;
  /** a file was chosen to be shown (its absolute path) */
  onOpenFile: (path: string) => void;
}

/** A finger resting this long on a row asks for its menu, where the browser sends no `contextmenu` of its own (iOS). */
const HOLD_MS = 500;
/** A finger that moved this far is scrolling the list, not holding a row. */
const HOLD_SLOP = 10;

interface MenuState { row: BrowserRow; anchor: HTMLElement; point?: { x: number; y: number }; previousFocus: HTMLElement | null; held: boolean }

/**
 * The files of a folder as a small file manager: what each folder and file takes on the disk
 * (a bar behind the row shows its part of the largest), a new folder, and a menu per row — its
 * ⋯, a right click, or a finger held on it — that downloads the file, or the folder as a .zip,
 * to the device this browser runs on.
 *
 * A listing shows at once and the sizes of its folders follow, since they are a walk of
 * everything beneath; a folder left before its walk answers stops that walk.
 */
export function FileBrowser({ start, onOpenFile }: FileBrowserProps) {
  const t = useT();
  const locale = useLocale();
  const { fetchDirectories, fetchStorageUsage, createFolder, checkArchive, fileUrl, archiveUrl } = useMachineApi();
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  // "failed" also stands for a PC whose bridge is from before sizes
  const [measure, setMeasure] = useState<"measuring" | "done" | "failed">("measuring");
  const [hidden, setHidden] = useState(false);
  const [order, setOrder] = useState<RowOrder>("name");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; alert: boolean } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [details, setDetails] = useState<BrowserRow | null>(null);
  // the new folder's name while it is typed; null when the field is closed
  const [naming, setNaming] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // the folder just made: its row is brought into view and marked
  const [fresh, setFresh] = useState<string | null>(null);
  const request = useRef(0);
  const shownPath = useRef<string | null>(null);
  const walk = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const hold = useRef<{ timer: number; x: number; y: number } | null>(null);
  // the release of a finger whose hold opened the menu is not a tap on the row
  const held = useRef(false);

  const measureFolder = useCallback((path: string) => {
    walk.current?.abort();
    const controller = new AbortController();
    walk.current = controller;
    setUsage(null);
    setMeasure("measuring");
    fetchStorageUsage(path, controller.signal).then((next) => {
      if (walk.current !== controller) return;
      setUsage(next);
      setMeasure("done");
    }).catch(() => {
      if (walk.current === controller) setMeasure("failed");
    });
  }, [fetchStorageUsage]);

  const open = useCallback(async (path: string, showHidden: boolean, fallbackHome: boolean) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const next = await fetchDirectories(path, showHidden, true);
      if (id !== request.current) return;
      // another folder: what was said about the last one, and a name half typed for it, go
      if (shownPath.current !== next.path) { setNotice(null); setNaming(null); setNameError(null); listRef.current?.scrollTo({ top: 0 }); }
      shownPath.current = next.path;
      setListing(next);
      setError(null);
      measureFolder(next.path);
    } catch (reason: unknown) {
      if (id !== request.current) return;
      // a path typed half-way opens home instead of an error
      if (fallbackHome && reason instanceof ApiError && reason.code === "invalid_cwd") return void open("", showHidden, false);
      setError(reason instanceof ApiError && reason.status === 404
        ? t("This PC's bridge cannot browse folders yet. Type the path instead.")
        : reason instanceof ApiError && reason.code === "invalid_cwd" ? t("This folder cannot be opened.") : t("Folders could not be loaded."));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [fetchDirectories, measureFolder, t]);

  useEffect(() => {
    void open(start, false, true);
    return () => { walk.current?.abort(); if (hold.current) window.clearTimeout(hold.current.timer); };
  }, []);

  useEffect(() => {
    if (fresh === null) return;
    listRef.current?.querySelector<HTMLElement>("[data-fresh]")?.scrollIntoView({ block: "nearest" });
  }, [fresh, listing]);

  const path = listing?.path ?? "";
  const shown = listing ? homeRelative(listing.path, listing.home) : start || "~";
  const rows = listing === null ? [] : browserRows(listing, usage, order);
  const count = (n: number): string => n.toLocaleString(locale);

  const activate = (row: BrowserRow): void => {
    if (row.folder) void open(childPath(path, row.name), hidden, false);
    else onOpenFile(childPath(path, row.name));
  };

  /** To this device: the browser that asked saves it, a phone to the phone, a desktop to the desktop. */
  const download = async (row: BrowserRow): Promise<void> => {
    const target = childPath(path, row.name);
    if (!row.folder) {
      downloads.start({ url: fileUrl(target, null, true), name: row.name, size: row.size ?? 0 });
      return;
    }
    setNotice({ text: t("Preparing {name}.zip…", { name: row.name }), alert: false });
    try {
      const archive = await checkArchive(target);
      setNotice(null);
      downloads.start({ url: archiveUrl(target), name: archive.name, size: archive.size });
    } catch (reason: unknown) {
      const code = reason instanceof ApiError ? reason.code : null;
      setNotice({
        alert: true,
        text: code === "too_many_files" ? t("{name} holds too many files to download as one .zip. Open it and download its folders one at a time.", { name: row.name })
          : code === "busy" ? t("Other folders are still downloading. Try again when one ends.")
            : reason instanceof ApiError && reason.status === 404 && code !== "not_found" ? t("This PC's bridge cannot send a folder yet.")
              : t("{name} could not be prepared for download.", { name: row.name }),
      });
    }
  };

  const copyPath = async (row: BrowserRow): Promise<void> => {
    const copied = await copyText(childPath(path, row.name));
    setNotice(copied ? { text: t("Path copied"), alert: false } : { text: t("The path could not be copied."), alert: true });
  };

  const menuItems = (row: BrowserRow): RowMenuItem[] => [
    { id: "open", label: t("Open"), icon: row.folder ? FolderOpen : FileText, run: () => activate(row) },
    { id: "download", label: row.folder ? t("Download as .zip") : t("Download"), icon: Download, run: () => void download(row) },
    { id: "details", label: t("Storage details"), icon: Info, run: () => setDetails(row) },
    { id: "copy", label: t("Copy path"), icon: Copy, divider: true, run: () => void copyPath(row) },
  ];

  const sizeOf = (row: BrowserRow): string => {
    if (row.size !== null) return `${usage?.partial && row.folder ? "≥ " : ""}${formatSize(row.size)}`;
    return measure === "measuring" ? "…" : "–";
  };

  const openMenu = (row: BrowserRow, item: HTMLElement, point?: { x: number; y: number }, byHold = false): void => {
    const anchor = item.querySelector<HTMLElement>(".file-row-more");
    if (!anchor) return;
    setMenu({ row, anchor, ...(point ? { point } : {}), previousFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null, held: byHold });
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLLIElement>, row: BrowserRow): void => {
    // the browser's own menu has nothing for a row; ours opens where the pointer is
    event.preventDefault();
    event.stopPropagation();
    cancelHold();
    // a finger's long press arrives here too (Android): the hold below may have opened it already
    if (menu !== null) return;
    const touch = (event.nativeEvent as PointerEvent).pointerType === "touch";
    if (touch) held.current = true;
    openMenu(row, event.currentTarget, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined, touch);
  };

  const cancelHold = (): void => {
    if (hold.current === null) return;
    window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLLIElement>, row: BrowserRow): void => {
    held.current = false;
    cancelHold();
    if (event.pointerType !== "touch" || (event.target as HTMLElement).closest(".file-row-more")) return;
    const item = event.currentTarget;
    const point = { x: event.clientX, y: event.clientY };
    hold.current = {
      ...point,
      timer: window.setTimeout(() => {
        hold.current = null;
        held.current = true;
        openMenu(row, item, point, true);
      }, HOLD_MS),
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLLIElement>): void => {
    if (hold.current !== null && Math.hypot(event.clientX - hold.current.x, event.clientY - hold.current.y) > HOLD_SLOP) cancelHold();
  };

  const startNaming = (): void => { setNaming(""); setNameError(null); setNotice(null); };
  const problem = naming === null ? null : folderNameProblem(naming);
  const problemText = naming === null || naming.trim() === "" ? null
    : problem === "characters" ? t("That name has a character a folder cannot have, or ends with a dot.")
      : problem === "reserved" ? t("Windows keeps that name for itself. Choose another.")
        : problem === "long" ? t("That name is too long.") : null;

  const submitFolder = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (naming === null || problem !== null || creating || listing === null) return;
    setCreating(true);
    setNameError(null);
    try {
      const made = await createFolder(listing.path, folderName(naming));
      setNaming(null);
      setFresh(made.name);
      setNotice({ text: t("Folder {name} created", { name: made.name }), alert: false });
      await open(listing.path, hidden || made.name.startsWith("."), false);
      if (made.name.startsWith(".")) setHidden(true);
    } catch (reason: unknown) {
      const code = reason instanceof ApiError ? reason.code : null;
      setNameError(code === "exists" ? t("Something here already has that name.")
        : code === "invalid_name" ? t("That name has a character a folder cannot have, or ends with a dot.")
          : code === "not_allowed" ? t("You cannot make a folder here.")
            : code === "read_only" ? t("This device can only watch.")
              : t("The folder could not be made."));
    } finally {
      setCreating(false);
    }
  };

  const summary = (() => {
    if (measure === "failed") return <span className="file-summary-size is-dim">{t("Sizes could not be read")}</span>;
    if (usage === null) return <span className="file-summary-size is-dim">{t("Measuring…")}</span>;
    return <>
      <span className="file-summary-size" title={`${count(usage.size)} B`}>{usage.partial ? t("At least {size}", { size: formatSize(usage.size) }) : formatSize(usage.size)}</span>
      <span className="file-summary-count">{usage.files === 1 ? t("1 file") : t("{n} files", { n: count(usage.files) })}{" · "}{usage.folders === 1 ? t("1 folder") : t("{n} folders", { n: count(usage.folders) })}</span>
    </>;
  })();
  const volume = usage?.volume ?? null;
  const used = volume === null ? 0 : volumeUsed(volume);

  return (
    <div className="dir-browser file-browser" role="group" aria-label={t("Files")} aria-busy={loading}>
      <div className="dir-browser-bar">
        <button type="button" className="icon-button" aria-label={t("Parent folder")} title={t("Parent folder")} disabled={!listing?.parent || loading} onClick={() => listing?.parent && void open(listing.parent, hidden, false)}>
          <ArrowUp aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" aria-label={t("Home folder")} title={t("Home folder")} disabled={loading || (listing !== null && listing.path === listing.home)} onClick={() => void open("", hidden, false)}>
          <House aria-hidden="true" />
        </button>
        <span className="dir-browser-path" title={path}><span dir="ltr">{shown}</span></span>
        <button type="button" className="icon-button" aria-pressed={order === "size"} disabled={listing === null}
          aria-label={order === "size" ? t("Sorted by size. Sort by name") : t("Sorted by name. Sort by size")} title={order === "size" ? t("Sort by name") : t("Sort by size")}
          onClick={() => { setOrder(order === "size" ? "name" : "size"); listRef.current?.scrollTo({ top: 0 }); }}>
          {order === "size" ? <ArrowDownWideNarrow aria-hidden="true" /> : <ArrowDownAZ aria-hidden="true" />}
        </button>
        <button type="button" className="icon-button file-browser-new" aria-label={t("New folder")} title={t("New folder")} disabled={listing === null || loading || naming !== null} onClick={startNaming}>
          <FolderPlus aria-hidden="true" />
        </button>
      </div>
      {error === null && listing !== null && (
        <div className="file-summary" role="status" aria-live="polite">
          <div className="file-summary-line">{summary}</div>
          {volume !== null && (
            <div className="file-summary-line file-summary-volume">
              <span className="file-meter" data-level={used >= 90 ? "high" : undefined} aria-hidden="true"><span style={{ "--used": `${used}%` } as CSSProperties} /></span>
              <span>{t("{free} free of {total} on this disk", { free: formatSize(volume.free), total: formatSize(volume.total) })}</span>
            </div>
          )}
        </div>
      )}
      {naming !== null && (
        <form className="file-new" onSubmit={(event) => void submitFolder(event)}>
          <FolderPlus aria-hidden="true" />
          <input type="text" className="input" value={naming} autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="done"
            placeholder={t("Folder name")} aria-label={t("New folder name")} aria-invalid={problemText !== null || nameError !== null} disabled={creating}
            onChange={(event) => { setNaming(event.target.value); setNameError(null); }}
            onKeyDown={(event) => {
              // Enter confirms an IME candidate; Escape dismisses it, not the field
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { event.stopPropagation(); return; }
              // Escape closes the field, not the dialog around the browser
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setNaming(null); setNameError(null); }
            }} />
          <button type="submit" className="btn btn-primary" disabled={creating || problem !== null}>{t("Create")}</button>
          <button type="button" className="icon-button" aria-label={t("Cancel new folder")} title={t("Cancel")} disabled={creating} onClick={() => { setNaming(null); setNameError(null); }}><X aria-hidden="true" /></button>
          {(nameError ?? problemText) !== null && <p className="file-new-error" role="alert">{nameError ?? problemText}</p>}
        </form>
      )}
      {notice !== null && <p className={`dir-browser-note file-browser-notice${notice.alert ? " dir-browser-error" : ""}`} role={notice.alert ? "alert" : "status"}>{notice.text}</p>}
      {error !== null ? <p className="dir-browser-note dir-browser-error" role="alert">{error}</p> : (
        <ul className="dir-browser-list file-browser-list" ref={listRef}>
          {listing === null && <li className="dir-browser-note" role="status">{t("Loading…")}</li>}
          {rows.map((row) => (
            <li key={`${row.folder ? "folder" : "file"}:${row.name}`} className="file-row" data-kind={row.folder ? "folder" : "file"} data-fresh={row.folder && row.name === fresh ? "" : undefined}
              onContextMenu={(event) => onContextMenu(event, row)}
              onPointerDown={(event) => onPointerDown(event, row)} onPointerMove={onPointerMove} onPointerUp={cancelHold} onPointerCancel={cancelHold} onPointerLeave={cancelHold}>
              <span className="file-row-share" style={{ "--share": `${row.share}%` } as CSSProperties} aria-hidden="true" />
              <button type="button" className={`dir-browser-item${row.folder ? "" : " is-file"}`} disabled={loading}
                onClick={() => { if (held.current) { held.current = false; return; } activate(row); }}>
                {row.folder ? <Folder aria-hidden="true" /> : <FileText aria-hidden="true" />}
                <span className="file-row-name">{row.name}</span>
                <span className="dir-browser-size">{sizeOf(row)}</span>
              </button>
              <button type="button" className="icon-button file-row-more" aria-label={t("Actions for {name}", { name: row.name })} title={t("Actions")} aria-haspopup="menu" aria-expanded={menu?.row.name === row.name && menu.row.folder === row.folder}
                onClick={(event) => {
                  const item = event.currentTarget.closest<HTMLElement>(".file-row");
                  if (menu !== null) setMenu(null);
                  else if (item) openMenu(row, item);
                }}>
                <Ellipsis aria-hidden="true" />
              </button>
            </li>
          ))}
          {listing !== null && rows.length === 0 && <li className="dir-browser-note">{t("Nothing here")}</li>}
          {listing?.truncated && <li className="dir-browser-note">{t("Showing the first {n} folders; type the rest of the path to go further.", { n: listing.directories.length })}</li>}
        </ul>
      )}
      <div className="dir-browser-footer">
        <label className="dir-browser-hidden">
          <input type="checkbox" checked={hidden} disabled={loading && listing === null} onChange={(event) => { setHidden(event.target.checked); if (listing) void open(listing.path, event.target.checked, false); }} />
          {t("Show hidden")}
        </label>
        <span className="file-browser-hint">{t("Right-click or hold a row for more")}</span>
      </div>
      {menu && <RowMenu anchor={menu.anchor} point={menu.point} restoreFocusTo={menu.previousFocus} overModal fromHold={menu.held} title={t("Actions for {name}", { name: menu.row.name })}
        header={<div className="file-menu-head"><strong>{menu.row.name}</strong><span>{menu.row.folder ? t("Folder") : t("File")} · {sizeOf(menu.row)}</span></div>}
        items={menuItems(menu.row)} onClose={() => setMenu(null)} />}
      {details && <FileDetails path={childPath(path, details.name)} name={details.name} folder={details.folder} onDownload={() => void download(details)} onClose={() => setDetails(null)} />}
    </div>
  );
}
