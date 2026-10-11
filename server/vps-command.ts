import { spawn } from "node:child_process";
import { basename } from "node:path";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  truncated?: boolean;
}

/** Bounded output, one deadline, and no resolution until the child and its pipes close. */
export function run(argv: string[], timeoutMs = 60_000, signal?: AbortSignal, maxBytes = 4 * 1024 ** 2): Promise<CommandResult> {
  if (signal?.aborted) return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: true });
  // sudo can put a root child in a group this uid cannot kill. The watchdog must
  // run INSIDE that privilege boundary and escalate even if the command ignores TERM.
  const privileged = process.platform === "linux" && basename(argv[0]!) === "sudo" && argv[1] === "-n";
  if (privileged) argv = [...argv.slice(0, 2), "timeout", "--signal=TERM", "--kill-after=0.1s", `${Math.max(0.001, timeoutMs / 1000)}s`, ...argv.slice(2)];
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      env: { ...process.env, LC_ALL: "C" },
    });
    const output: Buffer[][] = [[], []];
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let failure = "";
    let stopping = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const signalGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
      // Also close inherited pipes held by descendants (e.g. a shell's running command).
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { child.kill(signal); }
    };
    const kill = (): void => {
      if (stopping) return;
      stopping = true;
      // sudo must get a chance to forward termination to its privileged child. SIGKILL
      // cannot be forwarded, and this user's group signal cannot kill another uid's child.
      signalGroup("SIGTERM");
      // Leave the inner watchdog enough time to reap/kill the privileged group
      // before terminating sudo itself. Resolution still waits for every pipe.
      force = setTimeout(() => signalGroup("SIGKILL"), privileged ? 250 : 100);
    };
    const abort = (): void => { timedOut = true; kill(); };
    const timer = setTimeout(abort, Math.max(1, timeoutMs));
    signal?.addEventListener("abort", abort, { once: true });
    [child.stdout, child.stderr].forEach((stream, index) => stream!.on("data", (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, maxBytes - bytes));
      if (kept.length) output[index]!.push(kept);
      bytes += kept.length;
      if (kept.length < chunk.length) { truncated = true; kill(); }
    }));
    child.on("error", (error) => { failure = error.message; });
    child.on("close", (code) => {
      if (privileged && (code === 124 || code === 137)) timedOut = true;
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener("abort", abort);
      resolve({ code: timedOut || truncated ? null : code, stdout: Buffer.concat(output[0]!).toString(), stderr: failure || Buffer.concat(output[1]!).toString(), timedOut, truncated });
    });
    if (signal?.aborted) abort();
  });
}
