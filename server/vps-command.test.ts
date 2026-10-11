import { expect, it } from "bun:test";
import { run } from "./vps-command.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("bounds output and reaps a noisy child", async () => {
  const result = await run([process.execPath, "-e", "while(true) console.log('x'.repeat(1024))"], 2000, undefined, 4096);
  expect(result.truncated).toBe(true);
  expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(4096);
  expect(result.code).not.toBe(0);
});

it("aborts and reaps a child before resolving without blocking timers", async () => {
  const controller = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const abort = setTimeout(() => controller.abort(), 40);
  try {
    const result = await run([process.execPath, "-e", "console.log(process.pid); setInterval(()=>{},1000)"], 2000, controller.signal);
    expect(result.timedOut).toBe(true);
    expect(ticks).toBeGreaterThan(0);
    const pid = Number(result.stdout.trim());
    if (pid) expect(() => process.kill(pid, 0)).toThrow();
  } finally { clearInterval(timer); clearTimeout(abort); }
});

it.skipIf(process.platform === "win32")("forces and reaps a child that ignores graceful termination", async () => {
  const started = performance.now();
  const result = await run([process.execPath, "-e", "process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000)"], 80);
  expect(result.timedOut).toBe(true);
  expect(performance.now() - started).toBeLessThan(1500);
  const pid = Number(result.stdout.trim());
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
});

it.skipIf(process.platform !== "linux")("bounds a sudo-like descendant in its own process group holding inherited pipes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vps-command-"));
  try {
    // No real sudo or privilege changes: emulate its separate group and TERM forwarding.
    const sudo = join(dir, "sudo");
    await writeFile(sudo, `#!/usr/bin/env bun\nimport { spawn } from 'node:child_process';
const args = process.argv.slice(2); if (args[0] === '-n') args.shift();
const child = spawn(args[0], args.slice(1), { detached: true, stdio: 'inherit' });
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 137));\n`, { mode: 0o700 });
    const started = performance.now();
    const result = await run([sudo, "-n", process.execPath, "-e", "process.on('SIGTERM',()=>{}); console.log('ready'); setTimeout(()=>process.exit(),1500)"], 200);
    expect(result.stdout).toContain("ready");
    expect(result.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
