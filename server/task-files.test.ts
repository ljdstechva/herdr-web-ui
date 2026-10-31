import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { descends, foregroundOutput, heldOutputs, runningTaskIds } from "./task-files.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A fake /proc: pid → [parent, the files its fds point at] */
function proc(table: Record<number, [number, string[]]>): string {
  const root = mkdtempSync(join(tmpdir(), "herdr-proc-"));
  roots.push(root);
  for (const [pid, [ppid, files]] of Object.entries(table)) {
    mkdirSync(join(root, pid, "fd"), { recursive: true });
    writeFileSync(join(root, pid, "stat"), `${pid} (bash (x)) S ${ppid} 1 1`);
    files.forEach((file, index) => symlinkSync(file, join(root, pid, "fd", String(index))));
  }
  return root;
}

describe("task output files held open", () => {
  it("names the running commands and finds the one under a Claude process", () => {
    const tasks = "/tmp/claude-1000/-opt-work/s1/tasks";
    const root = proc({
      100: [1, ["/dev/null"]],
      200: [100, [`${tasks}/bfg001.output`, `${tasks}/bfg001.output`]],
      300: [100, [`${tasks}/bbg002.output`]],
      400: [1, [`${tasks}/bother3.output`, "/var/log/x.log"]],
    });
    const held = heldOutputs(Date.now(), root);
    expect([...runningTaskIds(held)!].sort()).toEqual(["bbg002", "bfg001", "bother3"]);
    expect(descends(200, 100, held.parents)).toBe(true);
    expect(descends(400, 100, held.parents)).toBe(false);
    expect(foregroundOutput(100, new Set(["bbg002"]), held, () => 0)).toBe(`${tasks}/bfg001.output`);
    expect(foregroundOutput(100, new Set(["bbg002", "bfg001"]), held, () => 0)).toBeNull();
  });

  it("knows nothing where /proc cannot be read", () => {
    expect(runningTaskIds(heldOutputs(Date.now(), "/nonexistent-proc"))).toBeNull();
  });
});
