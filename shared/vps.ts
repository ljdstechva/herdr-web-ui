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
 *
 * Every POST needs `x-herdr-vps: 1` beside the app's same-origin check; a watch device is
 * refused every one of them by the central read-only gate.
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
  /** stable while the condition lasts: `disk:/`, `memory`, `swap`, `cpu` */
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
