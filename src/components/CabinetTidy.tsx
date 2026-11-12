import { useEffect, useRef, useState } from "react";
import { ChevronRight, CircleCheck, CloudUpload, RefreshCw, TriangleAlert } from "lucide-react";

import "./CabinetTidy.css";

import type { CabinetPreview, CabinetRun } from "../../shared/vps.ts";
import {
  agoLabel,
  alsoLine,
  cabinetProblem,
  elapsedLabel,
  folderCount,
  folderLabel,
  formatFree,
  freeLine,
  largestFolders,
  lastRunLine,
  previewLine,
  resultLine,
  type CabinetState,
} from "../lib/cabinet.ts";
import { formatBytes, previewCabinet, startCabinet, VpsError } from "../lib/vps.ts";

/**
 * "Move unused files to Drive": the server's `cabinet tidy` from the VPS dialog. The entry sits
 * under the disk's meter; the view shows the dry run first (how much would move, the largest
 * folders, what waits because it is in use) and starts the run only on a second, named button.
 * The run belongs to the server: this view only reads it, so closing the dialog, the page or the
 * phone changes nothing, and whoever opens it next sees the run under way or its result.
 */

/** The row under the disk meter. Drawn only where the server has a cabinet program. */
export function CabinetEntry({ cabinet, onOpen }: { cabinet: CabinetState; onOpen(): void }) {
  const { status } = cabinet;
  if (!status?.available) return null;
  const running = status.run?.state === "running";
  const last = status.run ? lastRunLine(status.run, status.now) : null;
  return <button type="button" className="cabinet-entry" data-running={running ? "" : undefined} onClick={onOpen}>
    {running ? <RefreshCw aria-hidden="true" className="vps-spin" /> : <CloudUpload aria-hidden="true" />}
    <span className="cabinet-entry-text">
      <strong>{running ? "Moving files to Drive…" : "Move unused files to Drive"}</strong>
      <span>{running ? "Working now. Tap to see." : last ?? "Work folders not used for a day. You see the list first."}</span>
    </span>
    <ChevronRight aria-hidden="true" className="cabinet-entry-go" />
  </button>;
}

type Phase =
  | { kind: "checking" }
  | { kind: "preview"; preview: CabinetPreview; starting: boolean }
  | { kind: "problem"; text: string }
  /** the server's run, under way or ended: drawn from `cabinet.status.run` */
  | { kind: "run" };

function problemText(reason: unknown): string {
  if (reason instanceof VpsError) return cabinetProblem(reason.code, reason.message);
  return `The server did not answer: ${reason instanceof Error ? reason.message : String(reason)}`;
}

export function CabinetView({ cabinet, onDiskChanged, onDone }: { cabinet: CabinetState; onDiskChanged(): void; onDone(): void }) {
  const { status } = cabinet;
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const mounted = useRef(true);
  const decided = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  /** Another device, or this one before a reload, started it: show that run. */
  const showRun = async (): Promise<void> => {
    await cabinet.refresh();
    if (mounted.current) setPhase({ kind: "run" });
  };

  const check = async (): Promise<void> => {
    setPhase({ kind: "checking" });
    try {
      const preview = await previewCabinet();
      if (mounted.current) setPhase({ kind: "preview", preview, starting: false });
    } catch (reason: unknown) {
      if (!mounted.current) return;
      if (reason instanceof VpsError && reason.code === "tidy_running") return void showRun();
      setPhase({ kind: "problem", text: problemText(reason) });
    }
  };

  const start = async (preview: CabinetPreview): Promise<void> => {
    setPhase({ kind: "preview", preview, starting: true });
    try {
      cabinet.adopt(await startCabinet());
      if (mounted.current) setPhase({ kind: "run" });
    } catch (reason: unknown) {
      if (!mounted.current) return;
      if (reason instanceof VpsError && reason.code === "tidy_running") return void showRun();
      setPhase({ kind: "problem", text: problemText(reason) });
    }
  };

  // the first answer decides: a run under way is shown, anything else starts with the dry run
  useEffect(() => {
    if (decided.current || status === null) return;
    decided.current = true;
    if (status.run?.state === "running") setPhase({ kind: "run" });
    else void check();
  }, [status]);

  // a run that ended changed the disk: the meters behind this view are read again
  const runState = status?.run?.state;
  const sawRunning = useRef(false);
  useEffect(() => {
    if (runState === "running") sawRunning.current = true;
    else if (sawRunning.current) { sawRunning.current = false; onDiskChanged(); }
  }, [runState]);

  const run = status?.run ?? null;
  const last = run && status ? lastRunLine(run, status.now) : null;

  if (phase.kind === "run" && run) {
    return <RunView run={run} serverNow={cabinet.serverNow} onAgain={() => void check()} onDone={onDone} />;
  }
  if (phase.kind === "problem") {
    return <div className="cabinet">
      <p className="cabinet-lead is-problem" role="alert"><TriangleAlert aria-hidden="true" /><span>{phase.text}</span></p>
      <div className="cabinet-actions">
        <button type="button" className="btn btn-primary" onClick={() => void check()}>Try again</button>
      </div>
    </div>;
  }
  if (phase.kind !== "preview") {
    return <div className="cabinet">
      <p className="cabinet-lead" role="status"><RefreshCw aria-hidden="true" className="vps-spin" /><span>Checking what can move…</span></p>
      <p className="cabinet-explain">Nothing is moved yet.</p>
    </div>;
  }

  const { preview, starting } = phase;
  const { shown, more } = largestFolders(preview);
  const days = preview.idle_days === null ? "a day" : preview.idle_days === 1 ? "1 day" : `${preview.idle_days} days`;
  const nothing = preview.folders === 0;
  return <div className="cabinet" data-state={nothing ? "nothing" : "preview"}>
    <div className="cabinet-head" role="status">
      <p className="cabinet-lead">{nothing ? <><CircleCheck aria-hidden="true" /><span>Nothing to move.</span></> : <span>{previewLine(preview)}</span>}</p>
      <p className="cabinet-free">Free now: {formatFree(preview.free_gb)}</p>
    </div>
    <p className="cabinet-explain">{nothing
      ? `Every work folder was used in the last ${days === "a day" || days === "1 day" ? "day" : days}.`
      : `Work folders not used for ${days} go to Google Drive. Each one is checked there before it leaves this server.`}</p>
    {!nothing && <p className="cabinet-explain">Like the nightly run, it also clears old agent scratch and packs old browser files.</p>}

    {shown.length > 0 && <section className="cabinet-section" aria-label="Largest folders">
      <h3 className="vps-heading">Largest</h3>
      <ul className="cabinet-list">
        {shown.map((item) => <FolderRow key={item.path} path={item.path} bytes={item.bytes} />)}
      </ul>
      {more > 0 && <p className="cabinet-more">and {more.toLocaleString("en-US")} more {more === 1 ? "folder" : "folders"}</p>}
    </section>}

    {preview.waiting > 0 && <WaitingList count={preview.waiting} rows={preview.busy} note="In use right now. They stay here and move on a later run." />}

    {last && <button type="button" className="cabinet-last" aria-label={`${last} Show the details`} disabled={starting} onClick={() => setPhase({ kind: "run" })}>
      <span>{last}</span><ChevronRight aria-hidden="true" />
    </button>}

    <div className="cabinet-actions">
      <button type="button" className="btn" disabled={starting} onClick={() => void check()}>Check again</button>
      {!nothing && <button type="button" className="btn btn-primary" disabled={starting} onClick={() => void start(preview)}>
        <CloudUpload aria-hidden="true" />{starting ? "Starting…" : `Move ${folderCount(preview.folders)} to Drive`}
      </button>}
    </div>
  </div>;
}

/** One folder of a list: its own name and size, then where it is inside the work folder and, for one that waits, why. Also the rows of a notification's folders (VpsNotifications.tsx). */
export function FolderRow({ path, bytes, why }: { path: string; bytes: number | null; why?: string }) {
  const { name, where } = folderLabel(path);
  return <li className="cabinet-row" title={path}>
    <span className="cabinet-row-name">{name}</span>
    {bytes !== null && <span className="cabinet-row-size">{formatBytes(bytes)}</span>}
    {where && <span className="cabinet-row-where">{where}</span>}
    {why && <span className="cabinet-row-why">{why}</span>}
  </li>;
}

function WaitingList({ count, rows, note }: { count: number; rows: CabinetPreview["busy"]; note: string }) {
  return <section className="cabinet-section" aria-label="Folders that wait">
    <h3 className="vps-heading">Waiting · {count}</h3>
    <p className="cabinet-explain">{note}</p>
    {/* cabinet's own record of a run counts them without naming them */}
    {rows.length > 0 && <ul className="cabinet-list">
      {rows.map((item) => <FolderRow key={item.path} path={item.path} bytes={item.bytes} why={item.why} />)}
    </ul>}
    {count > rows.length && rows.length > 0 && <p className="cabinet-more">and {count - rows.length} more</p>}
  </section>;
}

/** Re-renders once a second while `on`: the time a run has been working. */
function useSecond(on: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
}

function RunView({ run, serverNow, onAgain, onDone }: { run: CabinetRun; serverNow(): number; onAgain(): void; onDone(): void }) {
  useSecond(run.state === "running");

  if (run.state === "running") {
    return <div className="cabinet" data-state="running">
      <div className="cabinet-head" role="status">
        <p className="cabinet-lead"><RefreshCw aria-hidden="true" className="vps-spin" /><span>Moving files to Drive…</span></p>
        <p className="cabinet-free">Working for {elapsedLabel((serverNow() - run.started_at) / 1000)}</p>
      </div>
      <p className="cabinet-explain">This can take from seconds to many minutes. You can close this window or the app: the server keeps going, and the result waits here.</p>
    </div>;
  }

  const ended = agoLabel(serverNow() - (run.finished_at ?? run.started_at));
  const again = <div className="cabinet-actions">
    <button type="button" className="btn" onClick={onDone}>Done</button>
    <button type="button" className="btn btn-primary" onClick={onAgain}>Try again</button>
  </div>;

  if (run.state === "busy") {
    return <div className="cabinet" data-state="busy">
      <p className="cabinet-lead is-problem" role="status"><TriangleAlert aria-hidden="true" /><span>Another cabinet job is running.</span></p>
      <p className="cabinet-explain">Nothing was changed. Cabinet does one job at a time (for example the hourly copy to Drive). Try again in a few minutes.</p>
      {run.message && <p className="cabinet-said">{run.message}</p>}
      {again}
    </div>;
  }

  const { result } = run;
  if (run.state === "failed" || result === null) {
    return <div className="cabinet" data-state="failed">
      <p className="cabinet-lead is-problem" role="alert"><TriangleAlert aria-hidden="true" /><span>The move did not finish.</span></p>
      <p className="cabinet-explain">A folder leaves this server only after it is checked on Drive, so what did not move is still here. Check again to see what is left.</p>
      {run.message && <p className="cabinet-said">{run.message}</p>}
      {again}
    </div>;
  }

  const free = freeLine(result);
  const also = alsoLine(result);
  const failed = result.failed > 0;
  return <div className="cabinet" data-state="done">
    <div className="cabinet-head" role="status">
      <p className={`cabinet-lead${failed ? " is-problem" : " is-ok"}`}>
        {failed ? <TriangleAlert aria-hidden="true" /> : <CircleCheck aria-hidden="true" />}
        <span>{resultLine(result)}{failed ? ` ${result.failed} could not be moved.` : ""}</span>
      </p>
      {free && <p className="cabinet-free">{free}</p>}
    </div>
    <p className="cabinet-explain">
      Finished {ended}{result.seconds !== null ? ` · took ${elapsedLabel(result.seconds)}` : ""}.
      {result.moved === 0 && !failed && result.waiting === 0 ? " Every work folder was used in the last day." : ""}
    </p>
    {also && <p className="cabinet-explain">{also}</p>}

    {failed && <section className="cabinet-section" aria-label="Folders that could not be moved">
      <h3 className="vps-heading">Could not be moved · {result.failed}</h3>
      <p className="cabinet-explain">These are still on this server. Nothing is lost.</p>
      <ul className="cabinet-list">
        {result.fails.map((path) => <FolderRow key={path} path={path} bytes={null} />)}
      </ul>
    </section>}

    {result.waiting > 0 && <WaitingList count={result.waiting} rows={result.busy} note="They were in use, so they stayed. They move on a later run." />}

    <div className="cabinet-actions">
      <button type="button" className="btn" onClick={onAgain}>Check again</button>
      <button type="button" className="btn btn-primary" onClick={onDone}>Done</button>
    </div>
  </div>;
}
