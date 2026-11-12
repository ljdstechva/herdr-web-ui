/**
 * The server PC's own health (VPS status) and the Doctor that fixes what it finds.
 * Server side: server/vps.ts. Browser side: src/lib/vps.ts + components/VpsStatus.tsx.
 *
 *   GET  /api/vps/status                 -> VpsStatus
 *   GET  /api/vps/config                 -> VpsConfig
 *   POST /api/vps/config  VpsConfig      -> VpsConfig (thresholds and alerts, kept in stateDir/vps.json)
 *   POST /api/vps/alert/test             -> 204 (a test VPS alert to every subscribed device)
 *   GET  /api/vps/doctor/options         -> DoctorOptions (engines, models, efforts)
 *   POST /api/vps/doctor/disk/scan  { older_than_days } -> DiskScan
 *   POST /api/vps/doctor/disk/clean { scan_id, ids }    -> DiskCleanResult
 *   GET  /api/vps/doctor/processes       -> DoctorProcesses
 *   POST /api/vps/doctor/process { pid, start_ticks, action } -> ProcessActionResult
 *   POST /api/vps/doctor/agent DoctorAgentRequest -> DoctorAgentResult
 *   GET  /api/vps/cabinet                -> CabinetStatus (the run under way or the last one)
 *   POST /api/vps/cabinet/preview        -> CabinetPreview (`cabinet tidy --dry-run --json`)
 *   POST /api/vps/cabinet/tidy           -> 202 CabinetStatus (`cabinet tidy --json`, started detached)
 *   GET  /api/vps/notifications          -> VpsNotifications (cabinet's reports, newest first, and how many are unread)
 *   POST /api/vps/notifications/read     -> VpsNotifications (everything in the feed now is read, on every device)
 *
 * Every POST needs `x-herdr-vps: 1` beside the app's same-origin check; a watch device is
 * refused every one of them by the central read-only gate, and GET /api/vps/cabinet too
 * (403 read_only): a run's result names work folders.
 * Scan age defaults to 30 and otherwise must be an integer 1..3650. Equivalent in-flight
 * scans join; another age, or scan/clean overlap, answers 409 doctor_busy. A scan has one
 * 240-second deadline (408 scan_timeout), 200,000 visited entries and 4 MiB per-command
 * output limit (409 scan_limit). Cancellation drains walks and commands before another scan.
 * Failed scans save no plans; completed scans remain usable for 30 minutes, checked at clean.
 * Clean accepts a scan_id and 1..100 candidate ids, claims them once before awaiting, and
 * joins identical in-flight requests. Other simultaneous cleans answer 409 doctor_busy;
 * expired scans answer 409 scan_expired. Missing/used/changed paths are per-item failures,
 * never authority to delete replacement content. Path plans are held only in this process.
 * Estimates keep the scan's du/file measurements. Unsafe or unreadable path manifests
 * remain visible but refuse cleanup; symlinks are never followed or deleted. Old-file walks
 * skip beyond depth 12. Claude session folders accompany their selected old jsonl files,
 * regardless of descendant age; changes after the scan still prevent their deletion.
 * Process pid and start_ticks must be safe integers (pid >= 1, start_ticks >= 0).
 * An identical in-flight AI Doctor launch joins; another request answers 409 doctor_busy.
 * Briefs are private atomic files, retaining the newest 20 regular Doctor briefs.
 * Status may include inode counts and recent kernel OOM kills; missing evidence cannot
 * resolve a known issue. Delivered alerts resolve once, using their original notification tag;
 * recovery pushes wait while the app is active or no device subscribes. A recurrence cancels
 * pending recovery and is news again. Legacy alert records infer delivery from saved alerts.
 * Cabinet (server/cabinet.ts) moves work folders nobody used for a day to Google Drive with the
 * PC's own `cabinet` program; where there is none, `available` is false and the POSTs answer
 * 404 cabinet_missing. Neither POST reads a body: the command and its arguments are fixed.
 * A preview has one 30-second deadline (504 preview_timeout); an answer that is not the
 * program's one JSON line is 502 bad_output, a dry run that failed (the message is the program's
 * own last sentence) 502 preview_failed. One run at a time: a
 * second start, or a preview meanwhile, answers 409 tidy_running, a start during a preview
 * 409 preview_running, and cabinet's own lock (another cabinet job, its exit code 3) answers
 * a preview 409 cabinet_busy and ends a run in state `busy`. A run is not this request: it is started detached, outlives the page and a
 * server restart, and is read with GET until its state is no longer `running`.
 * Notifications (server/vps-notifications.ts) are the reports cabinet writes to its feed file,
 * one JSON line per event: the 12:00 a.m. run, a later move of folders that waited, a health
 * message. The server only reads that file (no program is run), keeps the newest 50 and counts
 * as unread those written after the list was last opened. That moment is kept on the server
 * (stateDir/vps-notifications.json), not per device, so a phone and a desktop show one number.
 * The GET carries an ETag and answers 304 to `If-None-Match`: it is polled. The POST reads no
 * body. Both answer 404 not_available without a cabinet service and 403 read_only to a watch
 * device, since a report names work folders.
 */

export type VpsSeverity = "ok" | "warning" | "critical";
export type VpsIssueKind = "disk" | "memory" | "swap" | "cpu";

export interface VpsThresholds {
  /** percent of a disk used */
  disk_warning: number;
  disk_critical: number;
  /** percent of memory in use (what MemAvailable leaves) */
  memory_warning: number;
  memory_critical: number;
  /** percent of swap in use */
  swap_warning: number;
  swap_critical: number;
  /** average CPU use over the last five minutes, percent of all cores */
  cpu_warning: number;
  cpu_critical: number;
}

export const DEFAULT_VPS_THRESHOLDS: VpsThresholds = {
  disk_warning: 85,
  disk_critical: 93,
  memory_warning: 85,
  memory_critical: 93,
  swap_warning: 60,
  swap_critical: 85,
  cpu_warning: 85,
  cpu_critical: 95,
};

export interface VpsConfig {
  /** push alerts when an issue appears or gets worse */
  alerts: boolean;
  thresholds: VpsThresholds;
}

export interface VpsDisk {
  mount: string;
  device: string;
  fs_type: string;
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  used_percent: number;
  /** Optional statfs inode counts; absent/zero files means inode usage is unknown. */
  files?: number;
  ffree?: number;
}

export interface VpsProcess {
  pid: number;
  user: string;
  name: string;
  command: string;
  /** percent of one core over the last sample */
  cpu_percent: number;
  rss_bytes: number;
  /** owned by the user the server runs as: the Doctor can stop it without root */
  own: boolean;
  /** the process start in clock ticks since boot: with the pid, it names this process and no later one */
  start_ticks: number;
}

export interface VpsIssue {
  /** stable while the condition lasts: `disk:/`, `inodes:/`, `memory`, `memory:oom`, `swap`, `cpu` */
  id: string;
  kind: VpsIssueKind;
  severity: Exclude<VpsSeverity, "ok">;
  title: string;
  detail: string;
  /** when the server first saw it, ms since the epoch */
  since: number;
}

export interface VpsStatus {
  /** false off Linux: nothing below is measured */
  supported: boolean;
  hostname: string;
  sampled_at: number;
  uptime_seconds: number;
  cpu: { cores: number; usage_percent: number; average_percent: number; load: [number, number, number] };
  memory: { total_bytes: number; available_bytes: number; used_percent: number };
  swap: { total_bytes: number; used_bytes: number; used_percent: number };
  disks: VpsDisk[];
  /** Kernel OOM kills in the last 15 minutes; null means journal evidence is unavailable. */
  oom_kills?: number | null;
  /** the heaviest processes by CPU and by memory */
  top: VpsProcess[];
  issues: VpsIssue[];
  severity: VpsSeverity;
  config: VpsConfig;
}

export type DoctorEngine = "builtin" | "claude" | "codex";

export interface DoctorModel {
  id: string;
  label: string;
  efforts: string[];
  default_effort: string | null;
}

export interface DoctorEngineInfo {
  engine: "claude" | "codex";
  label: string;
  available: boolean;
  /** the model the CLI uses when none is given */
  default_model: string | null;
  models: DoctorModel[];
}

export interface DoctorOptions {
  engines: DoctorEngineInfo[];
  /** sudo works without a password: the built-in Doctor can run its root fixes */
  root: boolean;
}

export type CleanupRisk = "safe" | "caution" | "danger";
export type CleanupGroup = "system" | "caches" | "history" | "large-files";

export interface DiskCandidate {
  id: string;
  group: CleanupGroup;
  label: string;
  /** what goes and what that costs */
  detail: string;
  /** what it frees, as measured by the scan; null when it cannot be told in advance */
  bytes: number | null;
  risk: CleanupRisk;
  /** needs passwordless sudo */
  root: boolean;
  /** ticked when the dialog opens */
  selected: boolean;
  /** a few of the paths or commands, for the user to see what it means */
  preview: string[];
}

export interface DiskFolder {
  path: string;
  bytes: number;
}

export interface DiskScan {
  scan_id: string;
  scanned_at: number;
  older_than_days: number;
  disk: VpsDisk | null;
  candidates: DiskCandidate[];
  /** the biggest folders, for the user to decide what else to clear */
  folders: DiskFolder[];
}

export interface DiskCleanItem {
  id: string;
  ok: boolean;
  message: string;
}

export interface DiskCleanResult {
  freed_bytes: number;
  results: DiskCleanItem[];
  disk: VpsDisk | null;
}

export interface DoctorPane {
  pane_id: string;
  workspace_id: string;
  workspace: string;
  title: string;
  agent: string | null;
  status: string;
}

export interface DoctorProcess extends VpsProcess {
  /** the herdr pane whose shell started it, when one did */
  pane: DoctorPane | null;
}

export interface DoctorProcesses {
  processes: DoctorProcess[];
  memory: VpsStatus["memory"];
  swap: VpsStatus["swap"];
  cpu: VpsStatus["cpu"];
}

export type ProcessAction = "terminate" | "kill" | "close-pane";

export interface ProcessActionResult {
  ok: boolean;
  message: string;
}

export interface DoctorAgentRequest {
  engine: "claude" | "codex";
  /** null: the CLI's own default */
  model: string | null;
  effort: string | null;
  /** the issue the Doctor is for; null for a general check-up */
  issue_id: string | null;
  /** what the user wants done, in their words */
  note: string;
}

export interface DoctorAgentResult {
  pane_id: string;
  workspace_id: string;
  agent_started: boolean;
  brief_path: string;
  error?: { code: string; message: string };
}

/** A work folder `cabinet tidy` would move to Drive. */
export interface CabinetFolder {
  path: string;
  bytes: number;
  /** hours since it was last used; null when the program does not say */
  idle_hours: number | null;
}

/** A folder left where it is because something is using it. */
export interface CabinetWaiting {
  path: string;
  bytes: number;
  /** the program's own words for what holds it */
  why: string;
}

export interface CabinetPreview {
  /** how many folders would move, and what they take together */
  folders: number;
  bytes: number;
  /** the largest of them, largest first; `folders` counts them all */
  items: CabinetFolder[];
  /** how many folders wait, and the first of them */
  waiting: number;
  busy: CabinetWaiting[];
  /** free on the disk now, GiB; null when the program does not say */
  free_gb: number | null;
  /** a folder moves after this many days without use */
  idle_days: number | null;
}

export interface CabinetResult {
  /** false: something failed (`fails`); what moved before it stays moved */
  ok: boolean;
  moved: number;
  bytes: number;
  waiting: number;
  busy: CabinetWaiting[];
  failed: number;
  /** the folders that could not be moved, as the program names them */
  fails: string[];
  /** the run's other clean-ups, the nightly run's own: idle agent scratch removed, old browser output packed to Drive */
  scratch_folders: number;
  scratch_bytes: number;
  browser_files: number;
  free_before_gb: number | null;
  free_after_gb: number | null;
  seconds: number | null;
}

/**
 * `running`: under way. `done`: it ended and `result` says what moved. `busy`: another cabinet
 * job held the lock, nothing was changed. `failed`: it ended without a result this app can read.
 */
export type CabinetRunState = "running" | "done" | "busy" | "failed";

export interface CabinetRun {
  id: string;
  state: CabinetRunState;
  /** ms since the epoch, on the server's clock */
  started_at: number;
  finished_at: number | null;
  result: CabinetResult | null;
  /** for `busy` and `failed`: why, in words */
  message: string | null;
}

export interface CabinetStatus {
  /** false: this PC has no cabinet program, and nothing is offered */
  available: boolean;
  /** the server's clock, ms: what `started_at` is counted from */
  now: number;
  /** the run under way, else the last one (started here, or cabinet's own record of it) */
  run: CabinetRun | null;
}

/** `info` is also what a level this app does not know is shown as. */
export type VpsNotificationLevel = "ok" | "warning" | "critical" | "info";

/** A work folder a report names. */
export interface VpsNotificationFolder {
  path: string;
  /** null when the report gives no size */
  bytes: number | null;
  /** for a folder that waits: the program's own words for what holds it; empty otherwise */
  why: string;
}

/** The folders of one kind in a report: the first of them, and how many there were in all. */
export interface VpsNotificationFolders {
  total: number;
  items: VpsNotificationFolder[];
}

/** One report of the server's `cabinet` program, as its feed file holds it. */
export interface VpsNotification {
  id: string;
  /**
   * `nightly`: the 12:00 a.m. run (backup, move, clean-ups). `retry`: folders in use at midnight,
   * moved by a later hourly try. `alert`: a problem, or "fine again", from cabinet's health check.
   * Any other kind is shown as an alert is: its title and lines.
   */
  kind: string;
  level: VpsNotificationLevel;
  /** when it was written, unix seconds */
  ts: number;
  /** ready-to-show sentences, in the program's own words */
  title: string;
  lines: string[];
  /** for the details: what went to Drive, what came back from it, what stayed because it was in use; null where the report names none */
  moved: VpsNotificationFolders | null;
  returned: VpsNotificationFolders | null;
  waiting: VpsNotificationFolders | null;
}

export interface VpsNotifications {
  /** false: this PC has no cabinet program and no feed, and nothing is offered */
  available: boolean;
  /** newest first, at most 50 */
  items: VpsNotification[];
  /** how many reports in the feed are newer than `read_ts` */
  unread: number;
  /** `ts` of the newest report there was when the list was last opened, on any device; 0 before the first time */
  read_ts: number;
}
