import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, CircleCheck, Inbox, Info, OctagonAlert, TriangleAlert, X, type LucideIcon } from "lucide-react";

import "./VpsNotifications.css";

import type { VpsNotification, VpsNotificationLevel } from "../../shared/vps.ts";
import { useLocale, useT, type Translate } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { badgeText, folderGroups, folderTotal, inboxLabel, isUnread, levelWord, whenLabel, type FolderGroup, type VpsInbox } from "../lib/vpsNotifications.ts";
import { FolderRow } from "./CabinetTidy.tsx";

/**
 * Notifications: what the server's `cabinet` program reports (the 12:00 a.m. run with what was
 * backed up, moved to Drive and freed; folders moved by a later try; a health message), as a
 * button with the number of reports not looked at yet and the list it opens.
 *
 * Not the Alerts of the More menu: those switch this device's own pop-ups about panes on and
 * off. This is an inbox, and its number is the server's, the same on every device. Nothing here
 * sounds, pushes or pops up: the run ends in the middle of the owner's night.
 */

/** The button in the app bar. Drawn only where the server has a cabinet and this device may read its reports. */
export function NotificationsButton({ inbox, open, onOpen }: { inbox: VpsInbox; open: boolean; onOpen(): void }) {
  const t = useT();
  if (!inbox.available) return null;
  const badge = badgeText(inbox.unread);
  const label = inboxLabel(inbox.unread, t);
  // data-unread: a phone's bar draws the button only while it has a number to show (VpsNotifications.css)
  return <button type="button" className="icon-button vps-inbox-button" data-unread={badge ?? undefined} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} onClick={onOpen}>
    <Inbox aria-hidden="true" />
    {badge !== null && <span className="vps-inbox-badge" aria-hidden="true">{badge}</span>}
  </button>;
}

const LEVEL_ICON: Record<VpsNotificationLevel, LucideIcon> = { ok: CircleCheck, warning: TriangleAlert, critical: OctagonAlert, info: Info };

/** The list, newest first. Opening it is reading it: the number goes, on every device. */
export function NotificationsDialog({ inbox, onClose }: { inbox: VpsInbox; onClose(): void }) {
  const t = useT();
  const locale = useLocale();
  const titleId = useId();
  const surface = useFocusTrap<HTMLDivElement>(true);
  const { data, unread, markRead, refresh } = inbox;
  // what was new when the list opened stays marked until it is closed, though it is read from the first moment
  const [readAtOpen] = useState(() => data?.read_ts ?? 0);
  const asked = useRef(false);
  useEffect(() => {
    // a report that arrives while the list is open is read the same way
    if (unread > 0) markRead();
    // nothing to mark: the list as it is now, not as the last minute's ask left it
    else if (!asked.current) refresh();
    asked.current = true;
  }, [unread, markRead, refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose();
  };
  const items = data?.items ?? [];
  const now = Date.now();

  return createPortal(<div className="modal-scrim" onMouseDown={closeFromScrim}>
    <div ref={surface} className="modal vps-inbox" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>{t("Notifications")}</h2>
        <button type="button" className="icon-button" aria-label={t("Close dialog")} onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      <div className="modal-body vps-inbox-body">
        {items.length === 0
          ? <p className="vps-inbox-empty" role="status">{t("No notifications yet. After each night run at 12:00 a.m. you will see here what was backed up, what was moved to Drive and how much space is free.")}</p>
          : <ul className="vps-inbox-list">
            {items.map((item) => <Report key={item.id} item={item} fresh={isUnread(item, readAtOpen)} now={now} locale={locale} t={t} />)}
          </ul>}
      </div>
    </div>
  </div>, document.body);
}

function Report({ item, fresh, now, locale, t }: { item: VpsNotification; fresh: boolean; now: number; locale: string; t: Translate }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const groups = folderGroups(item);
  const Icon = LEVEL_ICON[item.level] ?? Info;
  const word = levelWord(item.level, t);
  // a level that asks for a look is also written out; the others are told by their mark and its name
  const loud = item.level === "warning" || item.level === "critical";
  return <li className="vps-inbox-item" data-level={item.level} data-kind={item.kind} data-new={fresh ? "" : undefined}>
    <span className="vps-inbox-mark" title={word}><Icon aria-hidden="true" /><span className="visually-hidden">{word}</span></span>
    <div className="vps-inbox-text">
      <h3 className="vps-inbox-title">{item.title}</h3>
      <p className="vps-inbox-meta">
        {fresh && <span className="vps-inbox-new">{t("New")}</span>}
        {loud && <span className="vps-inbox-level">{word}</span>}
        <time dateTime={new Date(item.ts * 1000).toISOString()}>{whenLabel(item.ts, now, locale, t)}</time>
      </p>
      {item.lines.length > 0 && <ul className="vps-inbox-lines">
        {item.lines.map((line, index) => <li key={index}>{line}</li>)}
      </ul>}
      {groups.length > 0 && <button type="button" className="vps-inbox-toggle" aria-expanded={open} aria-controls={open ? detailsId : undefined} onClick={() => setOpen(!open)}>
        <ChevronDown aria-hidden="true" />
        <span>{open ? t("Hide folders") : t("Show folders ({count})", { count: folderTotal(groups) })}</span>
      </button>}
    </div>
    {/* a row of the report's own, so a phone can give the paths the sheet's whole width (VpsNotifications.css) */}
    {open && groups.length > 0 && <div id={detailsId} className="vps-inbox-details">
      {groups.map((group) => <Folders key={group.id} group={group} t={t} />)}
    </div>}
  </li>;
}

/** One list of a report's folders, in the look of the lists of "Move unused files to Drive". */
function Folders({ group, t }: { group: FolderGroup; t: Translate }) {
  const { total, items } = group.folders;
  const more = total - items.length;
  const heading = group.id === "moved" ? t("Moved to Drive") : group.id === "returned" ? t("Brought back from Drive") : t("Waiting, in use");
  return <section className="cabinet-section" aria-label={heading}>
    <h4 className="vps-inbox-heading">{heading} · {Math.max(total, items.length)}</h4>
    <ul className="cabinet-list">
      {items.map((folder, index) => <FolderRow key={`${index}:${folder.path}`} path={folder.path} bytes={folder.bytes} why={folder.why || undefined} />)}
    </ul>
    {more > 0 && <p className="cabinet-more">{t("and {count} more", { count: more })}</p>}
  </section>;
}
