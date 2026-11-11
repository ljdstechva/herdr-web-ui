import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Test support, never served: a stand-in for the PC's `cabinet` program, written into a folder
 * the test owns. The real one moves the owner's work folders to Drive, so no test runs it.
 *
 * The stand-in records its arguments in `<root>/calls`, waits while `<mode>.hold` exists (20 s
 * at most), then prints `<mode>.err` and `<mode>.out` and exits with `<mode>.code`; `mode` is
 * `dry` for `tidy --dry-run --json` and `real` for `tidy --json`. Anything else is refused with
 * exit code 64, so a test sees a command that is not one of the two.
 */

export const FAKE_DRY_RUN = {
  dry_run: true, ok: true, folders: 3, bytes: 1_500, waiting: 1,
  items: [
    { path: "/opt/workstation/a/small", bytes: 100, idle_hours: 30.5 },
    { path: "/opt/workstation/b/large", bytes: 1_000, idle_hours: 25.7 },
    { path: "/opt/workstation/c/middle", bytes: 400, idle_hours: 297 },
  ],
  busy: [{ path: "/opt/workstation/d/held", bytes: 123, why: "client lock stepsocial is held (pid 42)" }],
  free_gb: 37.1, idle_days: 1,
};

export const FAKE_RUN = {
  dry_run: false, ok: true, moved: 3, bytes: 123_456_789, waiting: 1,
  busy: [{ path: "/opt/workstation/d/held", bytes: 123, why: "in use" }], failed: 0, fails: [] as string[],
  scratch_folders: 2, scratch_bytes: 1234, browser_files: 0, free_before_gb: 37.1, free_after_gb: 41.2, seconds: 95,
};

export type FakeMode = "dry" | "real";

export interface FakeCabinet {
  /** the stand-in program's path: what HERDR_CABINET_BIN, or the `bin` option, is given */
  readonly bin: string;
  /** what the next `mode` command prints and exits with; an object is printed as one JSON line */
  stage(mode: FakeMode, output: unknown, code?: number, stderr?: string): void;
  /** keeps the next `mode` command waiting; the function it returns lets it go */
  hold(mode: FakeMode): () => void;
  /** lets go of every command still held */
  releaseAll(): void;
  /** the argument lines it was run with, in order */
  calls(): string[];
}

/** `root` is an existing folder of the test's own; it must not hold a quote character. */
export function fakeCabinet(root: string): FakeCabinet {
  if (root.includes("'")) throw new Error("the stand-in cabinet needs a folder without a quote in its path");
  const bin = join(root, "cabinet");
  writeFileSync(bin, `#!/bin/sh
dir='${root}'
printf '%s\\n' "$*" >> "$dir/calls"
case "$*" in
  "tidy --dry-run --json") mode=dry ;;
  "tidy --json") mode=real ;;
  *) echo "unexpected arguments: $*" >&2; exit 64 ;;
esac
n=0
while [ -e "$dir/$mode.hold" ] && [ "$n" -lt 400 ]; do sleep 0.05; n=$((n + 1)); done
[ -e "$dir/$mode.err" ] && cat "$dir/$mode.err" >&2
[ -e "$dir/$mode.out" ] && cat "$dir/$mode.out"
exit "$(cat "$dir/$mode.code" 2>/dev/null || echo 0)"
`);
  chmodSync(bin, 0o755);
  const holds = new Set<string>();
  const letGo = (file: string): void => {
    holds.delete(file);
    try { unlinkSync(file); } catch { /* let go already */ }
  };
  const fake: FakeCabinet = {
    bin,
    stage(mode, output, code = 0, stderr = "") {
      writeFileSync(join(root, `${mode}.out`), typeof output === "string" ? output : `${JSON.stringify(output)}\n`);
      writeFileSync(join(root, `${mode}.code`), String(code));
      writeFileSync(join(root, `${mode}.err`), stderr);
    },
    hold(mode) {
      const file = join(root, `${mode}.hold`);
      writeFileSync(file, "");
      holds.add(file);
      return () => letGo(file);
    },
    releaseAll() {
      for (const file of [...holds]) letGo(file);
    },
    calls() {
      return existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8").trim().split("\n") : [];
    },
  };
  fake.stage("dry", FAKE_DRY_RUN);
  fake.stage("real", FAKE_RUN);
  return fake;
}
