import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { Download, Minus, X } from "lucide-react";
import { downloads, type DownloadItem } from "../lib/downloads.ts";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { announceModalChange } from "../lib/focus.ts";
import { useT } from "../lib/i18n.ts";
import "./DownloadCenter.css";

function DownloadRow({ item }: { item: DownloadItem }) {
  const t = useT();
  const running = item.status === "downloading";
  const percent = running && item.total !== null ? Math.min(99, Math.floor(item.received / item.total * 100)) : null;
  const status = running ? t("Downloading…") : item.status === "sent" ? t("Sent to browser")
    : item.status === "browser" ? t("Browser download") : item.status === "cancelled" ? t("Download cancelled") : t("Download failed");
  return <li className="download-row" data-status={item.status}>
    <div className="download-row-heading"><strong title={item.name}>{item.name}</strong>
      {running
        ? <button type="button" className="icon-button" aria-label={t("Cancel download: {file}", { file: item.name })} onClick={() => downloads.cancel(item.id)}><X aria-hidden="true" /></button>
        : <button type="button" className="icon-button" aria-label={t("Dismiss download: {file}", { file: item.name })} onClick={() => downloads.dismiss(item.id)}><X aria-hidden="true" /></button>}
    </div>
    <p className="download-state" role={item.status === "failed" ? "alert" : "status"}>{status}</p>
    {running && <>
      <progress aria-label={t("Download progress: {file}", { file: item.name })} max={100} value={percent ?? undefined} />
      <p className="download-bytes">{item.total === null ? formatBytes(item.received) : t("{done} of {total}", { done: formatBytes(item.received), total: formatBytes(item.total) })}{percent === null ? "" : ` · ${percent}%`}</p>
    </>}
    {item.status === "browser" && <p className="download-detail">{t("Track this file in your browser's downloads.")}</p>}
    {item.status === "sent" && <p className="download-detail">{t("If the file is missing, tap Save file to download it directly.")}</p>}
    {item.failure === "busy" && item.status === "failed" && <p className="download-detail">{t("Retry shortly, or download with your browser.")}</p>}
    {(item.status === "failed" || item.status === "cancelled") && <button type="button" className="btn btn-ghost" onClick={() => downloads.retry(item.id)}>{t("Retry")}</button>}
    {(item.status === "sent" || item.status === "browser" || (item.status === "failed" && item.failure === "busy")) &&
      <a className="btn btn-ghost" href={item.url} download={item.name}>{t(item.status === "sent" ? "Save file" : "Download with browser")}</a>}
  </li>;
}

/** Mounted once by App: a file preview or pane may close without owning the transfer. */
export function DownloadCenter() {
  const t = useT();
  const snapshot = useSyncExternalStore(downloads.subscribe, downloads.read);
  const dialog = useRef<HTMLDialogElement>(null);
  const notification = useRef<HTMLButtonElement>(null);
  const openedFromNotification = useRef(false);
  const title = useId();
  const hasItems = snapshot.items.length > 0;
  const expanded = hasItems && !snapshot.minimized;
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (expanded && !node.open) node.showModal();
    else if (!expanded && node.open) {
      node.close();
      // Reopening removes the compact button, so native focus restoration cannot find it.
      // Preserve the browser's normal restoration to a still-open file preview.
      if (openedFromNotification.current || document.activeElement === document.body) notification.current?.focus({ preventScroll: true });
      openedFromNotification.current = false;
    }
    announceModalChange();
  }, [expanded]);
  useEffect(() => {
    const leave = () => downloads.cancelAll();
    window.addEventListener("pagehide", leave);
    return () => { window.removeEventListener("pagehide", leave); downloads.clear(); };
  }, []);
  const running = snapshot.items.filter(item => item.status === "downloading");
  const first = running[0];
  const percent = running.length === 1 && first?.total ? Math.min(99, Math.floor(first.received / first.total * 100)) : null;
  const summary = running.length > 0 ? t("Downloading…") : snapshot.items.some(item => item.status === "failed") ? t("Download failed")
    : snapshot.items.some(item => item.status === "browser") ? t("Browser download")
      : snapshot.items.some(item => item.status === "sent") ? t("Sent to browser") : t("Download cancelled");
  return <>
    {hasItems && snapshot.minimized && <button ref={notification} type="button" className="download-notification" aria-label={t("Open downloads")} onClick={() => { openedFromNotification.current = true; downloads.show(); }}>
      <Download aria-hidden="true" />
      <span>{t("Downloads ({n})", { n: snapshot.items.length })}<small><span role="status">{summary}</span>{percent === null ? "" : ` · ${percent}%`}</small></span>
    </button>}
    <dialog ref={dialog} className="modal download-dialog" aria-labelledby={title}
      onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}
      onCancel={event => { event.preventDefault(); downloads.minimize(); }}>
      <header className="modal-header"><h2 className="modal-title" id={title}>{t("Downloads")}</h2>
        <button type="button" className="icon-button" aria-label={t("Minimize downloads")} title={t("Minimize downloads")} onClick={() => downloads.minimize()}><Minus aria-hidden="true" /></button>
      </header>
      <div className="modal-body"><ul className="download-list">{snapshot.items.map(item => <DownloadRow key={item.id} item={item} />)}</ul></div>
    </dialog>
  </>;
}
