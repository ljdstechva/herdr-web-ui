import { useEffect, useState, type CSSProperties } from "react";
import { Download, File, Folder, X } from "lucide-react";

import "./FileBrowser.css";

import type { StorageUsage } from "../../shared/protocol.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { formatSize, volumeUsed } from "../lib/storage.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";

export interface FileDetailsProps {
  /** absolute */
  path: string;
  name: string;
  folder: boolean;
  onDownload: () => void;
  onClose: () => void;
}

/**
 * What one folder or file takes: the bytes in it, what that holds on the disk, how many files
 * and folders are inside, and how full the disk it is on is. Opened over the Files browser, so
 * its Escape is its own.
 */
export function FileDetails({ path, name, folder, onDownload, onClose }: FileDetailsProps) {
  const t = useT();
  const locale = useLocale();
  const { fetchStorageUsage } = useMachineApi();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const surface = useFocusTrap<HTMLElement>(true);

  useEffect(() => {
    const controller = new AbortController();
    setUsage(null);
    setFailed(false);
    fetchStorageUsage(path, controller.signal).then(setUsage).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [path, fetchStorageUsage]);

  useEffect(() => {
    // before the dialog beneath hears it: this one closes, that one stays
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const count = (n: number): string => n.toLocaleString(locale);
  const least = (size: string): string => usage?.partial ? t("At least {size}", { size }) : size;
  const volume = usage?.volume ?? null;
  const used = volume === null ? 0 : volumeUsed(volume);
  const Mark = folder ? Folder : File;

  return (
    <div className="modal-scrim file-details-scrim" onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
      <section ref={surface} className="modal file-details" role="dialog" aria-modal="true" aria-labelledby="file-details-title" tabIndex={-1}>
        <header className="modal-header">
          <Mark className="file-details-mark" aria-hidden="true" />
          <h2 className="modal-title" id="file-details-title">{name}</h2>
          <button type="button" className="icon-button" aria-label={t("Close details")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body file-details-body" aria-busy={usage === null && !failed}>
          <p className="file-details-total" role="status">
            {failed ? <span className="is-dim">{t("Sizes could not be read")}</span>
              : usage === null ? <span className="is-dim">{t("Measuring…")}</span>
                : <strong>{least(formatSize(usage.size))}</strong>}
          </p>
          {usage !== null && (
            <dl className="file-details-list">
              <dt>{t("Size")}</dt>
              <dd>{least(formatSize(usage.size))} <span className="is-dim">({t("{n} bytes", { n: count(usage.size) })})</span></dd>
              <dt>{t("On disk")}</dt>
              <dd>{least(formatSize(usage.disk))}</dd>
              {usage.kind === "folder" && <>
                <dt>{t("Contains")}</dt>
                <dd>{usage.files === 1 ? t("1 file") : t("{n} files", { n: count(usage.files) })}{" · "}{usage.folders === 1 ? t("1 folder") : t("{n} folders", { n: count(usage.folders) })}</dd>
              </>}
              <dt>{t("Changed")}</dt>
              <dd>{new Date(usage.modified).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}</dd>
              <dt>{t("Location")}</dt>
              <dd className="file-details-path"><span dir="ltr">{usage.path}</span></dd>
            </dl>
          )}
          {usage?.partial && <p className="file-details-note">{t("This folder is too large to measure whole, or holds folders this user cannot read: the numbers are a lower bound.")}</p>}
          {volume !== null && (
            <div className="file-details-volume">
              <span className="file-meter" data-level={used >= 90 ? "high" : undefined} role="img" aria-label={t("Disk {percent}% full", { percent: used })}><span style={{ "--used": `${used}%` } as CSSProperties} /></span>
              <span>{t("{free} free of {total} on this disk", { free: formatSize(volume.free), total: formatSize(volume.total) })}</span>
            </div>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-primary" onClick={() => { onDownload(); onClose(); }}>
            <Download aria-hidden="true" />{folder ? t("Download as .zip") : t("Download")}
          </button>
        </footer>
      </section>
    </div>
  );
}
