import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Bot, ChevronLeft, CircleCheck, CircleX, RefreshCw, Server, Stethoscope, Trash2, TriangleAlert, Wrench, X } from "lucide-react";

import "./VpsStatus.css";

import type {
  DiskCandidate,
  DiskCleanResult,
  DiskScan,
  DoctorEngineInfo,
  DoctorOptions,
  DoctorProcess,
  DoctorProcesses,
  ProcessAction,
  VpsConfig,
  VpsIssue,
  VpsSeverity,
  VpsStatus,
  VpsThresholds,
} from "../../shared/vps.ts";
import { fetchSession } from "../lib/api.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import {
  cleanDisk,
  fetchDoctorOptions,
  fetchDoctorProcesses,
  formatBytes,
  formatUptime,
  fullestDisk,
  markSeen,
  meterLevel,
  newsIssues,
  OPENED_FROM_ALERT,
  processAction,
  readSeen,
  saveVpsConfig,
  scanDisk,
  SEVERITY_WORD,
  startDoctorAgent,
  testVpsAlert,
  useVpsStatus,
  writeSeen,
} from "../lib/vps.ts";

type Select = (machineId: string, paneId: string | null) => void;

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The server's health in the sidebar footer: CPU, memory and the fullest disk at a glance, a
 * notice that drops in when an issue appears, and the dialog with every number and the Doctor.
 */
export function VpsStatusRow({ onSelect }: { onSelect: Select }) {
  const { status, unavailable, error, refresh } = useVpsStatus();
  const [open, setOpen] = useState(OPENED_FROM_ALERT);
  const [seen, setSeen] = useState(readSeen);

  // a tapped VPS alert while the app is open (sw.js posts it)
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if ((event.data as { type?: unknown } | null)?.type === "open-vps") setOpen(true);
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, []);

  // an issue that went away is news again when it comes back
  useEffect(() => {
    if (!status) return;
    const open = new Set(status.issues.map((issue) => issue.id));
    const kept = Object.fromEntries(Object.entries(seen).filter(([id]) => open.has(id)));
    if (Object.keys(kept).length !== Object.keys(seen).length) { setSeen(kept); writeSeen(kept); }
  }, [status]);

  const news = status ? newsIssues(status.issues, seen) : [];
  const acknowledge = (): void => {
    if (!status) return;
    const next = markSeen(status.issues, seen);
    setSeen(next);
    writeSeen(next);
  };
  // the dialog shows every issue: opening it is seeing them
  useEffect(() => { if (open && news.length) acknowledge(); }, [open, news.length]);

  if (unavailable) return null;
  const disk = status ? fullestDisk(status) : null;
  const severity: VpsSeverity = status?.severity ?? "ok";
  const t = status?.config.thresholds;
  return <>
    <div className="sidebar-footer-row vps-row">
      <button type="button" className={`vps-chip is-${severity}`} onClick={() => setOpen(true)} title={status ? `${status.hostname}: ${status.issues.length ? status.issues.map((issue) => issue.title).join("; ") : "no issues"}` : "VPS status"} aria-label={`VPS status: ${SEVERITY_WORD[severity]}`}>
        <Server aria-hidden="true" />
        <span className="vps-chip-name">VPS</span>
        {status && t ? <>
          <Mini label="CPU" value={status.cpu.usage_percent} level={meterLevel(status.cpu.average_percent, t.cpu_warning, t.cpu_critical)} />
          <Mini label="RAM" value={status.memory.used_percent} level={meterLevel(status.memory.used_percent, t.memory_warning, t.memory_critical)} />
          {disk && <Mini label="Disk" value={disk.used_percent} level={meterLevel(disk.used_percent, t.disk_warning, t.disk_critical)} />}
        </> : <span className="vps-chip-wait">{error ? "unavailable" : "â€¦"}</span>}
        <span className={`vps-word is-${severity}`}>{SEVERITY_WORD[severity]}</span>
      </button>
    </div>
    {status && news.length > 0 && !open && createPortal(<VpsToast host={status.hostname} issues={news} onOpen={() => setOpen(true)} onDismiss={acknowledge} />, document.body)}
    {open && createPortal(<VpsDialog status={status} error={error} refresh={refresh} onClose={() => setOpen(false)} onSelect={onSelect} />, document.body)}
  </>;
}

function Mini({ label, value, level }: { label: string; value: number; level: VpsSeverity }) {
  return <span className={`vps-mini is-${level}`}>
    <span className="vps-mini-label">{label}</span>
    <span className="vps-mini-value">{Math.round(value)}%</span>
    <span className="vps-mini-bar" style={{ ["--fill" as string]: `${Math.min(100, value)}%` }} />
  </span>;
}

function VpsToast({ host, issues, onOpen, onDismiss }: { host: string; issues: VpsIssue[]; onOpen(): void; onDismiss(): void }) {
  const first = issues[0]!;
  return <div className={`vps-toast is-${first.severity}`} role="status">
    <TriangleAlert aria-hidden="true" className="vps-toast-icon" />
    <div className="vps-toast-text">
      <strong>{host}: {first.title}</strong>
      <span>{first.detail}{issues.length > 1 ? ` Â· +${issues.length - 1} more` : ""}</span>
    </div>
    <div className="vps-toast-actions">
      <button type="button" className="btn btn-primary" onClick={onOpen}><Stethoscope aria-hidden="true" />Open</button>
      <button type="button" className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}><X aria-hidden="true" /></button>
    </div>
  </div>;
}

type View = { kind: "status" } | { kind: "doctor"; issue: VpsIssue | null };

function VpsDialog({ status, error, refresh, onClose, onSelect }: { status: VpsStatus | null; error: string | null; refresh(): void; onClose(): void; onSelect: Select }) {
  const [view, setView] = useState<View>({ kind: "status" });
  const [busy, setBusy] = useState(false);
  const surface = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.preventDefault();
      if (busy) return;
      if (view.kind === "doctor") setView({ kind: "status" });
      else onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, view, onClose]);

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!busy && event.target === event.currentTarget) onClose();
  };
  const title = view.kind === "status" ? `VPS status${status ? ` Â· ${status.hostname}` : ""}` : `Doctor Â· ${view.issue?.title ?? "check-up"}`;

  return <div className="modal-scrim vps-scrim" onMouseDown={closeFromScrim}>
    <div ref={surface} className="modal vps-modal" role="dialog" aria-modal="true" aria-labelledby="vps-title" tabIndex={-1}>
      <header className="modal-header">
        {view.kind === "doctor" && <button type="button" className="icon-button" aria-label="Back to status" title="Back to status" disabled={busy} onClick={() => setView({ kind: "status" })}><ChevronLeft aria-hidden="true" /></button>}
        <h2 className="modal-title vps-title" id="vps-title">{title}</h2>
        {view.kind === "status" && <button type="button" className="icon-button" aria-label="Refresh" title="Refresh" onClick={refresh}><RefreshCw aria-hidden="true" /></button>}
        <button type="button" className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      <div className="modal-body vps-body">
        {!status ? <p className="vps-note" role="status">{error ?? "Measuringâ€¦"}</p>
          : view.kind === "status" ? <StatusView status={status} refresh={refresh} onDoctor={(issue) => setView({ kind: "doctor", issue })} />
          : <DoctorView status={status} issue={view.issue} setBusy={setBusy} refresh={refresh} onStarted={(paneId) => { onClose(); onSelect("local", paneId); }} />}
      </div>
    </div>
  </div>;
}

// â”€â”€ status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function StatusView({ status, refresh, onDoctor }: { status: VpsStatus; refresh(): void; onDoctor(issue: VpsIssue | null): void }) {
  const t = status.config.thresholds;
  const ago = Math.max(0, Math.round((Date.now() - status.sampled_at) / 1000));
  return <div className="vps-status">
    <p className="vps-summary">
      <span className={`vps-word is-${status.severity}`}>{SEVERITY_WORD[status.severity]}</span>
      <span>Up {formatUptime(status.uptime_seconds)}</span>
      <span>Measured {ago < 5 ? "just now" : `${ago}s ago`}</span>
    </p>

    <section className="vps-section" aria-label="Issues">
      {status.issues.length === 0 ? <div className="vps-ok">
        <CircleCheck aria-hidden="true" />
        <span>No issues: everything is within your thresholds.</span>
        <button type="button" className="btn" onClick={() => onDoctor(null)}><Stethoscope aria-hidden="true" />Check-up</button>
      </div> : status.issues.map((issue) => <div key={issue.id} className={`vps-issue is-${issue.severity}`}>
        <TriangleAlert aria-hidden="true" className="vps-issue-icon" />
        <div className="vps-issue-text">
          <strong>{issue.title}</strong>
          <span>{issue.detail} Â· <span className={`vps-word is-${issue.severity}`}>{SEVERITY_WORD[issue.severity]}</span> since {new Date(issue.since).toLocaleString()}</span>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => onDoctor(issue)}><Stethoscope aria-hidden="true" />Doctor</button>
      </div>)}
    </section>

    <section className="vps-section" aria-label="Resources">
      <h3 className="vps-heading">Resources</h3>
      <Meter label="CPU" value={status.cpu.usage_percent} level={meterLevel(status.cpu.average_percent, t.cpu_warning, t.cpu_critical)}
        detail={`${status.cpu.average_percent}% over 5 min Â· load ${status.cpu.load.map((value) => value.toFixed(2)).join(" ")} Â· ${status.cpu.cores} cores`} />
      <Meter label="Memory" value={status.memory.used_percent} level={meterLevel(status.memory.used_percent, t.memory_warning, t.memory_critical)}
        detail={`${formatBytes(status.memory.total_bytes - status.memory.available_bytes)} used Â· ${formatBytes(status.memory.available_bytes)} available of ${formatBytes(status.memory.total_bytes)}`} />
      {status.swap.total_bytes > 0 && <Meter label="Swap" value={status.swap.used_percent} level={meterLevel(status.swap.used_percent, t.swap_warning, t.swap_critical)}
        detail={`${formatBytes(status.swap.used_bytes)} of ${formatBytes(status.swap.total_bytes)}`} />}
      {status.disks.map((disk) => <Meter key={disk.mount} label={`Disk ${disk.mount}`} value={disk.used_percent} level={meterLevel(disk.used_percent, t.disk_warning, t.disk_critical)}
        detail={`${formatBytes(disk.used_bytes)} used Â· ${formatBytes(disk.available_bytes)} free of ${formatBytes(disk.total_bytes)} Â· ${disk.device}`} />)}
    </section>

    <section className="vps-section" aria-label="Top processes">
      <h3 className="vps-heading">Heaviest processes</h3>
      <ul className="vps-procs">
        {[...status.top].sort((a, b) => b.rss_bytes - a.rss_bytes).map((proc) => <li key={proc.pid} className="vps-proc">
          <span className="vps-proc-name" title={proc.command}>{proc.name}</span>
          <span className="vps-proc-user">{proc.user}</span>
          <span className="vps-proc-num">{proc.cpu_percent}%</span>
          <span className="vps-proc-num">{formatBytes(proc.rss_bytes)}</span>
        </li>)}
      </ul>
    </section>

    <AlertSettings config={status.config} onSaved={refresh} />
  </div>;
}

function Meter({ label, value, level, detail }: { label: string; value: number; level: VpsSeverity; detail: string }) {
  return <div className={`vps-meter is-${level}`}>
    <span className="vps-meter-label">{label}</span>
    <span className="vps-meter-value">{value.toFixed(1)}%{level !== "ok" && <span className={`vps-word is-${level}`}> {SEVERITY_WORD[level]}</span>}</span>
    <span className="vps-meter-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}><span style={{ width: `${Math.min(100, Math.max(value, value > 0 ? 1 : 0))}%` }} /></span>
    <span className="vps-meter-detail">{detail}</span>
  </div>;
}

const THRESHOLD_ROWS: { kind: string; warning: keyof VpsThresholds; critical: keyof VpsThresholds; hint: string }[] = [
  { kind: "Disk", warning: "disk_warning", critical: "disk_critical", hint: "% of a disk used" },
  { kind: "Memory", warning: "memory_warning", critical: "memory_critical", hint: "% of memory in use" },
  { kind: "Swap", warning: "swap_warning", critical: "swap_critical", hint: "% of swap in use" },
  { kind: "CPU", warning: "cpu_warning", critical: "cpu_critical", hint: "% busy, 5-minute average" },
];

function AlertSettings({ config, onSaved }: { config: VpsConfig; onSaved(): void }) {
  const [draft, setDraft] = useState(config);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(config);
  const save = async (): Promise<void> => {
    setPending(true); setNote(null);
    try { const saved = await saveVpsConfig(draft); setDraft(saved); setNote("Saved"); onSaved(); }
    catch (reason) { setNote(message(reason)); }
    finally { setPending(false); }
  };
  const test = async (): Promise<void> => {
    setPending(true); setNote(null);
    try { await testVpsAlert(); setNote("Test alert sent to every device with alerts on (turn alerts on from the header's More menu on each device)."); }
    catch (reason) { setNote(message(reason)); }
    finally { setPending(false); }
  };
  return <details className="vps-section vps-settings">
    <summary className="vps-heading">Alerts and thresholds</summary>
    <label className="vps-check">
      <input type="checkbox" checked={draft.alerts} onChange={(event) => setDraft({ ...draft, alerts: event.target.checked })} />
      <span>Push an alert when an issue appears or gets worse (and every 12 h while it lasts)</span>
    </label>
    <div className="vps-thresholds">
      <span />
      <span className="field-label">Warning</span>
      <span className="field-label">Critical</span>
      {THRESHOLD_ROWS.map((row) => <ThresholdRow key={row.kind} row={row} draft={draft} setDraft={setDraft} />)}
    </div>
    <div className="vps-actions">
      <button type="button" className="btn" disabled={pending} onClick={() => void test()}>Send test alert</button>
      <button type="button" className="btn btn-primary" disabled={pending || !changed} onClick={() => void save()}>Save</button>
    </div>
    {note && <p className="vps-note" role="status">{note}</p>}
  </details>;
}

function ThresholdRow({ row, draft, setDraft }: { row: (typeof THRESHOLD_ROWS)[number]; draft: VpsConfig; setDraft(next: VpsConfig): void }) {
  const set = (key: keyof VpsThresholds, value: string): void => {
    const number = Number(value);
    if (Number.isFinite(number)) setDraft({ ...draft, thresholds: { ...draft.thresholds, [key]: number } });
  };
  return <>
    <span className="vps-threshold-name" title={row.hint}>{row.kind}<span className="field-hint"> {row.hint}</span></span>
    <input className="input vps-number" type="number" min={1} max={100} aria-label={`${row.kind} warning`} value={draft.thresholds[row.warning]} onChange={(event) => set(row.warning, event.target.value)} />
    <input className="input vps-number" type="number" min={1} max={100} aria-label={`${row.kind} critical`} value={draft.thresholds[row.critical]} onChange={(event) => set(row.critical, event.target.value)} />
  </>;
}

// â”€â”€ doctor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type Engine = "builtin" | "claude" | "codex";
const DOCTOR_KEY = "herdr-web-ui:vps-doctor";

interface DoctorChoice { engine: Engine; model: Record<string, string>; effort: Record<string, string> }

function readChoice(): DoctorChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(DOCTOR_KEY) ?? "{}") as Partial<DoctorChoice>;
    return {
      engine: raw.engine === "claude" || raw.engine === "codex" ? raw.engine : "builtin",
      model: typeof raw.model === "object" && raw.model ? raw.model : {},
      effort: typeof raw.effort === "object" && raw.effort ? raw.effort : {},
    };
  } catch {
    return { engine: "builtin", model: {}, effort: {} };
  }
}

function writeChoice(choice: DoctorChoice): void {
  try { localStorage.setItem(DOCTOR_KEY, JSON.stringify(choice)); } catch { /* remembered for this opening only */ }
}

function DoctorView({ status, issue, setBusy, refresh, onStarted }: { status: VpsStatus; issue: VpsIssue | null; setBusy(busy: boolean): void; refresh(): void; onStarted(paneId: string): void }) {
  const [options, setOptions] = useState<DoctorOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState(readChoice);
  const [tool, setTool] = useState<"disk" | "processes">(issue?.kind === "disk" ? "disk" : "processes");
  useEffect(() => {
    let cancelled = false;
    fetchDoctorOptions().then((next) => { if (!cancelled) setOptions(next); }).catch((reason) => { if (!cancelled) setError(message(reason)); });
    return () => { cancelled = true; };
  }, []);
  const update = (next: DoctorChoice): void => { setChoice(next); writeChoice(next); };
  const engineInfo = options?.engines.find((entry) => entry.engine === choice.engine) ?? null;

  return <div className="vps-doctor">
    {issue && <p className={`vps-issue-line is-${issue.severity}`}><TriangleAlert aria-hidden="true" />{issue.title} Â· {issue.detail}</p>}
    <div className="field">
      <span className="field-label">Fix with</span>
      <div className="segmented vps-engines" role="group" aria-label="Fix with">
        <button type="button" aria-pressed={choice.engine === "builtin"} onClick={() => update({ ...choice, engine: "builtin" })}><Wrench aria-hidden="true" />Built-in</button>
        {(options?.engines ?? []).map((entry) => <button key={entry.engine} type="button" aria-pressed={choice.engine === entry.engine} disabled={!entry.available}
          title={entry.available ? undefined : `${entry.label} is not installed on the server`} onClick={() => update({ ...choice, engine: entry.engine })}><Bot aria-hidden="true" />{entry.label}</button>)}
      </div>
      <span className="field-hint">{choice.engine === "builtin"
        ? "Fixed, reviewed actions: you pick exactly what is deleted or stopped."
        : "Starts an agent in a new â€œVPS Doctorâ€ workspace. It investigates, then asks you what to do before changing anything."}</span>
    </div>
    {error && <p className="vps-note is-error" role="alert">{error}</p>}
    {choice.engine === "builtin" ? <>
      {!issue && <div className="segmented vps-tools" role="group" aria-label="Built-in tool">
        <button type="button" aria-pressed={tool === "disk"} onClick={() => setTool("disk")}>Disk cleanup</button>
        <button type="button" aria-pressed={tool === "processes"} onClick={() => setTool("processes")}>Processes and agents</button>
      </div>}
      {(issue ? issue.kind === "disk" : tool === "disk")
        ? <DiskDoctor root={options?.root ?? false} setBusy={setBusy} refresh={refresh} />
        : <ProcessDoctor sortBy={issue?.kind === "cpu" ? "cpu" : "memory"} setBusy={setBusy} refresh={refresh} />}
    </> : engineInfo ? <AgentDoctor engine={engineInfo} issue={issue} status={status} choice={choice} update={update} setBusy={setBusy} onStarted={onStarted} />
      : <p className="vps-note" role="status">Loadingâ€¦</p>}
  </div>;
}

const NOTE_HINT: Record<string, string> = {
  disk: "e.g. Find what fills the disk and ask me what to delete. Keep client folders.",
  memory: "e.g. Find what uses the memory and ask me which agents or processes to close.",
  swap: "e.g. Find what pushed the server into swap and ask me what to close.",
  cpu: "e.g. Find what keeps the CPU busy and ask me what to stop.",
  none: "e.g. Check the server's health and suggest what to clean up.",
};

/** Waits until the PC's roster names the pane, so selecting it lands on it rather than on herdr's focus. */
async function waitForPane(paneId: string): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    try { if ((await fetchSession()).panes.some((pane) => pane.pane_id === paneId)) return; } catch { /* try again */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function AgentDoctor({ engine, issue, status, choice, update, setBusy, onStarted }: {
  engine: DoctorEngineInfo; issue: VpsIssue | null; status: VpsStatus; choice: DoctorChoice; update(next: DoctorChoice): void; setBusy(busy: boolean): void; onStarted(paneId: string): void;
}) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const model = choice.model[engine.engine] ?? "";
  const effort = choice.effort[engine.engine] ?? "";
  const picked = engine.models.find((entry) => entry.id === (model || engine.default_model)) ?? null;
  const efforts = picked?.efforts.length ? picked.efforts : engine.engine === "claude" ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "xhigh"];
  const effortValue = efforts.includes(effort) ? effort : "";

  const start = async (): Promise<void> => {
    setPending(true); setBusy(true); setError(null);
    try {
      const result = await startDoctorAgent({ engine: engine.engine, model: model || null, effort: effortValue || null, issue_id: issue?.id ?? null, note });
      await waitForPane(result.pane_id);
      if (!result.agent_started) {
        setStarted(result.pane_id);
        setError(`The workspace is open, but ${engine.label} did not start: ${result.error?.message ?? "unknown error"}`);
        return;
      }
      onStarted(result.pane_id);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setPending(false); setBusy(false);
    }
  };

  return <div className="vps-agent">
    <div className="vps-agent-pickers">
      <label className="field">
        <span className="field-label">Model</span>
        <select className="select" value={model} disabled={pending} onChange={(event) => update({ ...choice, model: { ...choice.model, [engine.engine]: event.target.value } })}>
          <option value="">Default{engine.default_model ? ` (${engine.default_model})` : ""}</option>
          {engine.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Effort</span>
        <select className="select" value={effortValue} disabled={pending} onChange={(event) => update({ ...choice, effort: { ...choice.effort, [engine.engine]: event.target.value } })}>
          <option value="">Default{picked?.default_effort ? ` (${picked.default_effort})` : ""}</option>
          {efforts.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      </label>
    </div>
    <label className="field">
      <span className="field-label">What should the Doctor do?</span>
      <textarea className="input vps-textarea" rows={3} value={note} disabled={pending} maxLength={4000} placeholder={NOTE_HINT[issue?.kind ?? "none"]} onChange={(event) => setNote(event.target.value)} />
      <span className="field-hint">It gets the numbers above ({status.issues.length ? status.issues.map((entry) => entry.title).join("; ") : "no open issues"}) and must ask you before deleting, stopping or restarting anything.</span>
    </label>
    {error && <p className="vps-note is-error" role="alert">{error}</p>}
    <div className="vps-actions">
      {started && <button type="button" className="btn" onClick={() => onStarted(started)}>Open the workspace</button>}
      <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void start()}><Bot aria-hidden="true" />{pending ? `Starting ${engine.label}â€¦ up to 60s` : `Start ${engine.label} Doctor`}</button>
    </div>
  </div>;
}

const GROUP_TITLE: Record<DiskCandidate["group"], string> = {
  system: "System",
  caches: "Caches and old versions",
  history: "Old conversation history",
  "large-files": "Large files (review each one)",
};
const RISK_WORD: Record<DiskCandidate["risk"], string> = { safe: "Safe", caution: "Caution", danger: "Check first" };

function DiskDoctor({ root, setBusy, refresh }: { root: boolean; setBusy(busy: boolean): void; refresh(): void }) {
  const [days, setDays] = useState(30);
  const [scan, setScan] = useState<DiskScan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<"idle" | "scanning" | "confirm" | "cleaning" | "done">("idle");
  const [result, setResult] = useState<DiskCleanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const runScan = async (olderThan = days): Promise<void> => {
    setPhase("scanning"); setBusy(true); setError(null); setResult(null);
    try {
      const next = await scanDisk(olderThan);
      setScan(next);
      setSelected(new Set(next.candidates.filter((candidate) => candidate.selected && (!candidate.root || root)).map((candidate) => candidate.id)));
      setPhase("idle");
    } catch (reason) {
      setError(message(reason)); setPhase("idle");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { if (!started.current) { started.current = true; void runScan(); } }, []);

  const chosen = scan?.candidates.filter((candidate) => selected.has(candidate.id)) ?? [];
  const total = chosen.reduce((sum, candidate) => sum + (candidate.bytes ?? 0), 0);
  const toggle = (id: string): void => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  const clean = async (): Promise<void> => {
    if (!scan) return;
    setPhase("cleaning"); setBusy(true); setError(null);
    try {
      setResult(await cleanDisk(scan.scan_id, chosen.map((candidate) => candidate.id)));
      setPhase("done");
      refresh();
    } catch (reason) {
      setError(message(reason)); setPhase("idle");
    } finally {
      setBusy(false);
    }
  };
  const groups = useMemo(() => {
    const map = new Map<DiskCandidate["group"], DiskCandidate[]>();
    for (const candidate of scan?.candidates ?? []) map.set(candidate.group, [...(map.get(candidate.group) ?? []), candidate]);
    return [...map.entries()];
  }, [scan]);

  if (phase === "scanning") return <p className="vps-note" role="status"><RefreshCw aria-hidden="true" className="vps-spin" />Scanning the diskâ€¦ this can take a minute.</p>;
  if (phase === "done" && result) return <div className="vps-result">
    <p className="vps-result-head"><CircleCheck aria-hidden="true" />Freed {formatBytes(result.freed_bytes)}{result.disk ? ` Â· disk ${result.disk.mount} now ${result.disk.used_percent}% used, ${formatBytes(result.disk.available_bytes)} free` : ""}</p>
    <ul className="vps-result-list">
      {result.results.map((item) => {
        const candidate = scan?.candidates.find((entry) => entry.id === item.id);
        return <li key={item.id} className={item.ok ? "is-ok" : "is-failed"}>{item.ok ? <CircleCheck aria-hidden="true" /> : <CircleX aria-hidden="true" />}<span><strong>{candidate?.label ?? item.id}</strong> â€” {item.message}</span></li>;
      })}
    </ul>
    <div className="vps-actions"><button type="button" className="btn" onClick={() => void runScan()}>Scan again</button></div>
  </div>;
  if (phase === "confirm" || phase === "cleaning") return <div className="vps-confirm">
    <p><strong>Delete these {chosen.length} item{chosen.length === 1 ? "" : "s"}?</strong> About {formatBytes(total)} is freed. This cannot be undone.</p>
    <ul className="vps-confirm-list">{chosen.map((candidate) => <li key={candidate.id}><span className={`vps-risk is-${candidate.risk}`}>{RISK_WORD[candidate.risk]}</span>{candidate.label} Â· {formatBytes(candidate.bytes)}</li>)}</ul>
    {chosen.some((candidate) => candidate.risk !== "safe") && <p className="vps-note is-error">Some of these cannot be brought back: old conversations stop being resumable, and large files are gone for good.</p>}
    <div className="vps-actions">
      <button type="button" className="btn btn-ghost" disabled={phase === "cleaning"} onClick={() => setPhase("idle")}>Back</button>
      <button type="button" className="btn btn-danger" disabled={phase === "cleaning"} onClick={() => void clean()}><Trash2 aria-hidden="true" />{phase === "cleaning" ? "Deletingâ€¦" : `Delete ${chosen.length} item${chosen.length === 1 ? "" : "s"}`}</button>
    </div>
  </div>;

  return <div className="vps-disk">
    <div className="vps-disk-head">
      {scan?.disk && <span>Disk {scan.disk.mount}: {scan.disk.used_percent}% used, {formatBytes(scan.disk.available_bytes)} free</span>}
      <label className="vps-days">History older than
        <select className="select" value={days} onChange={(event) => { const next = Number(event.target.value); setDays(next); void runScan(next); }}>
          {[7, 14, 30, 60, 90].map((value) => <option key={value} value={value}>{value} days</option>)}
        </select>
      </label>
      <button type="button" className="btn" onClick={() => void runScan()}><RefreshCw aria-hidden="true" />Rescan</button>
    </div>
    {error && <p className="vps-note is-error" role="alert">{error}</p>}
    {!root && <p className="vps-note">Passwordless sudo is not available, so system items are disabled.</p>}
    {scan && scan.candidates.length === 0 && <p className="vps-note">Nothing to clean was found.</p>}
    {groups.map(([group, candidates]) => <fieldset key={group} className="vps-group">
      <legend className="vps-heading">{GROUP_TITLE[group]}</legend>
      {candidates.map((candidate) => <label key={candidate.id} className={`vps-candidate${candidate.root && !root ? " is-disabled" : ""}`}>
        <input type="checkbox" checked={selected.has(candidate.id)} disabled={candidate.root && !root} onChange={() => toggle(candidate.id)} />
        <span className="vps-candidate-main">
          <span className="vps-candidate-label" title={candidate.label}>{candidate.label}</span>
          <span className="vps-candidate-detail">{candidate.detail}</span>
          {candidate.preview.length > 0 && <details className="vps-preview"><summary>What this includes</summary><ul>{candidate.preview.map((line) => <li key={line}>{line}</li>)}</ul></details>}
        </span>
        <span className="vps-candidate-side">
          <span className="vps-candidate-size">{formatBytes(candidate.bytes)}</span>
          <span className={`vps-risk is-${candidate.risk}`}>{RISK_WORD[candidate.risk]}</span>
        </span>
      </label>)}
    </fieldset>)}
    {scan && scan.folders.length > 0 && <details className="vps-group vps-folders">
      <summary className="vps-heading">Biggest folders</summary>
      <p className="field-hint">For reference: to clear one of these, start the AI Doctor and tell it which.</p>
      <ul>{scan.folders.map((folder) => <li key={folder.path}><span title={folder.path}>{folder.path}</span><span className="vps-proc-num">{formatBytes(folder.bytes)}</span></li>)}</ul>
    </details>}
    <div className="vps-actions vps-sticky">
      <span className="vps-total">{chosen.length} selected Â· about {formatBytes(total)}</span>
      <button type="button" className="btn btn-danger" disabled={chosen.length === 0} onClick={() => setPhase("confirm")}><Trash2 aria-hidden="true" />Clean selectedâ€¦</button>
    </div>
  </div>;
}

const ACTION_WORD: Record<ProcessAction, { arm: string; confirm: string }> = {
  "close-pane": { arm: "Close pane", confirm: "Confirm close" },
  terminate: { arm: "Stop", confirm: "Confirm stop" },
  kill: { arm: "Force stop", confirm: "Confirm force stop" },
};

function ProcessDoctor({ sortBy, setBusy, refresh }: { sortBy: "memory" | "cpu"; setBusy(busy: boolean): void; refresh(): void }) {
  const [data, setData] = useState<DoctorProcesses | null>(null);
  const [order, setOrder] = useState(sortBy);
  const [armed, setArmed] = useState<{ pid: number; action: ProcessAction } | null>(null);
  const [outcome, setOutcome] = useState<Record<number, { ok: boolean; message: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const load = async (): Promise<void> => {
    try { setData(await fetchDoctorProcesses()); setError(null); } catch (reason) { setError(message(reason)); }
  };
  useEffect(() => { void load(); }, []);

  const act = async (proc: DoctorProcess, action: ProcessAction): Promise<void> => {
    if (!armed || armed.pid !== proc.pid || armed.action !== action) { setArmed({ pid: proc.pid, action }); return; }
    setArmed(null); setBusy(true);
    try {
      const result = await processAction(proc.pid, proc.start_ticks, action);
      setOutcome((previous) => ({ ...previous, [proc.pid]: result }));
      // a stopped process takes a moment to leave the table and give its memory back
      setTimeout(() => { void load(); refresh(); }, 1500);
    } catch (reason) {
      setOutcome((previous) => ({ ...previous, [proc.pid]: { ok: false, message: message(reason) } }));
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <p className="vps-note" role="status">{error ?? "Reading the process tableâ€¦"}</p>;
  const processes = [...data.processes].sort((a, b) => order === "cpu" ? b.cpu_percent - a.cpu_percent : b.rss_bytes - a.rss_bytes);
  return <div className="vps-processes">
    <p className="vps-disk-head">
      <span>Memory {data.memory.used_percent}% Â· swap {data.swap.used_percent}% Â· CPU {data.cpu.average_percent}% (5 min)</span>
      <span className="segmented" role="group" aria-label="Sort by">
        <button type="button" aria-pressed={order === "memory"} onClick={() => setOrder("memory")}>By memory</button>
        <button type="button" aria-pressed={order === "cpu"} onClick={() => setOrder("cpu")}>By CPU</button>
      </span>
      <button type="button" className="btn" onClick={() => void load()}><RefreshCw aria-hidden="true" />Refresh</button>
    </p>
    {error && <p className="vps-note is-error" role="alert">{error}</p>}
    <p className="field-hint">Closing an agent's pane ends that agent; its conversation stays on disk and can be resumed. Stop asks a process to exit; Force stop ends it at once.</p>
    <ul className="vps-proc-list">
      {processes.map((proc) => {
        const done = outcome[proc.pid];
        const actions: ProcessAction[] = [...(proc.pane ? ["close-pane" as const] : []), ...(proc.own ? ["terminate" as const, "kill" as const] : [])];
        return <li key={`${proc.pid}:${proc.start_ticks}`} className="vps-proc-card">
          <div className="vps-proc-top">
            <strong className="vps-proc-name">{proc.name}</strong>
            <span className="vps-proc-user">{proc.user} Â· pid {proc.pid}</span>
            <span className="vps-proc-num">{proc.cpu_percent}% CPU</span>
            <span className="vps-proc-num">{formatBytes(proc.rss_bytes)}</span>
          </div>
          <code className="vps-proc-cmd" title={proc.command}>{proc.command}</code>
          {proc.pane && <span className="vps-proc-pane">herdr: {proc.pane.workspace} Â· {proc.pane.title}{proc.pane.agent ? ` Â· ${proc.pane.agent} (${proc.pane.status})` : ""}</span>}
          {done ? <span className={`vps-proc-outcome ${done.ok ? "is-ok" : "is-failed"}`} role="status">{done.message}</span>
            : actions.length > 0 ? <div className="vps-proc-actions">
              {actions.map((action) => {
                const isArmed = armed?.pid === proc.pid && armed.action === action;
                return <button key={action} type="button" className={isArmed ? "btn btn-danger" : "btn"} onClick={() => void act(proc, action)}>{isArmed ? ACTION_WORD[action].confirm : ACTION_WORD[action].arm}</button>;
              })}
            </div> : <span className="field-hint">Owned by {proc.user}: ask the AI Doctor about it.</span>}
        </li>;
      })}
    </ul>
  </div>;
}
