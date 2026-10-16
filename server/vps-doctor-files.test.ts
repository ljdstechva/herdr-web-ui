import { afterEach, expect, it } from "bun:test";
import { realpath, mkdtemp, mkdir, chmod, writeFile, utimes, rename, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScanBudget, oldFiles, capturePath, validatePath } from "./vps-doctor-files.ts";

const fixtures: string[] = [];
const budgets: ScanBudget[] = [];
async function fixture() { const dir = await realpath(await mkdtemp(join(tmpdir(), "vps-files-"))); fixtures.push(dir); return dir; }
function budget(ms = 5000, limit = 200_000) { const work = new ScanBudget(ms, limit); budgets.push(work); return work; }
afterEach(async () => { budgets.splice(0).forEach((work) => work.close()); for (const dir of fixtures.splice(0)) await rm(dir, { recursive: true, force: true }); });

it("walks asynchronously, preserving old file sizes and yielding to the event loop", async () => {
  const dir = await fixture();
  for (let i = 0; i < 300; i++) { const file = join(dir, `${i}`); await writeFile(file, "old"); await utimes(file, 1, 1); }
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const found = await oldFiles(dir, 10000, budget());
    expect(found.paths).toHaveLength(300);
    expect(found.bytes).toBe(900);
    expect(ticks).toBeGreaterThan(0);
  } finally { clearInterval(timer); }
});

it("enforces its entry limit inside one flat directory, including recent files", async () => {
  const dir = await fixture();
  for (let i = 0; i < 15; i++) await writeFile(join(dir, `${i}`), "recent");
  await expect(oldFiles(dir, 0, budget(5000, 10))).rejects.toMatchObject({ code: "scan_limit" });
});

it("stops a walk at its total deadline", async () => {
  const dir = await fixture();
  for (let i = 0; i < 100; i++) await writeFile(join(dir, `${i}`), "old");
  await expect(oldFiles(dir, Date.now(), budget(0))).rejects.toMatchObject({ code: "scan_timeout" });
});

it("keeps completed old-file results while skipping beyond the historical depth limit", async () => {
  const dir = await fixture();
  const shallow = join(dir, "old"); await writeFile(shallow, "old"); await utimes(shallow, 1, 1);
  const deep = join(dir, ...Array(14).fill("d")); await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "ignored"), "old");
  expect(await oldFiles(dir, Date.now() + 1000, budget())).toEqual({ paths: [shallow], bytes: 3 });
});

it.skipIf(process.platform === "win32")("rejects symlink leaves and parents, replaced roots, modified content and new children", async () => {
  const dir = await fixture();
  const target = join(dir, "cache");
  await mkdir(target); await writeFile(join(target, "file"), "old");
  const plan = await capturePath(target, budget());
  expect(plan).not.toBeNull();
  await expect(validatePath(plan!, budget())).resolves.toBe(true);
  await writeFile(join(target, "new"), "new");
  await expect(validatePath(plan!, budget())).resolves.toBe(false);
  await rm(join(target, "new"));
  const filePlan = await capturePath(join(target, "file"), budget());
  await writeFile(join(target, "file"), "new");
  await expect(validatePath(filePlan!, budget())).resolves.toBe(false);
  await rename(target, join(dir, "moved")); await mkdir(target); await writeFile(join(target, "file"), "old");
  await expect(validatePath(plan!, budget())).resolves.toBe(false);
  await symlink(join(dir, "moved"), join(dir, "link"));
  expect(await capturePath(join(dir, "link", "file"), budget())).toBeNull();
  await rm(join(target, "file")); await symlink(join(dir, "moved", "file"), join(target, "file"));
  expect(await capturePath(join(target, "file"), budget())).toBeNull();
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("skips unreadable advisory directories while cleanup manifests still fail closed", async () => {
  const dir = await fixture();
  const readable = join(dir, "old");
  await writeFile(readable, "old");
  const locked = join(dir, "locked");
  await mkdir(locked);
  await writeFile(join(locked, "private"), "private");
  await chmod(locked, 0o000);
  try {
    expect(await oldFiles(dir, Date.now() + 1000, budget())).toEqual({ paths: [readable], bytes: 3 });
    expect(await capturePath(dir, budget())).toBeNull();
  } finally { await chmod(locked, 0o700); }
});
