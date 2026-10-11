import { spawn } from "node:child_process";

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
    const kill = (): void => {
      // Also close inherited pipes held by descendants (e.g. a shell's running command).
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { child.kill("SIGKILL"); }
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
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ code: timedOut || truncated ? null : code, stdout: Buffer.concat(output[0]!).toString(), stderr: failure || Buffer.concat(output[1]!).toString(), timedOut, truncated });
    });
    if (signal?.aborted) abort();
  });
}
