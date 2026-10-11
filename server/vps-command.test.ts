import { expect, it } from "bun:test";
import { run } from "./vps-command.ts";

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
