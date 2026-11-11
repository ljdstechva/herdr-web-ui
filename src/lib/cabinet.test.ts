import { expect, it } from "bun:test";

import type { CabinetFolder, CabinetResult, CabinetRun } from "../../shared/vps.ts";
import { agoLabel, alsoLine, cabinetProblem, elapsedLabel, folderCount, folderLabel, formatFree, freeLine, largestFolders, lastRunLine, previewLine, resultLine, shortPath, workRelative } from "./cabinet.ts";

it("shows a path inside the work folder without the work folder", () => {
  expect(workRelative("/opt/workstation/11 Step Social/.tmp/football-2-music")).toBe("11 Step Social/.tmp/football-2-music");
  expect(workRelative("/opt/workspace/03 SMARCOMMS/clients/")).toBe("03 SMARCOMMS/clients");
  // a path cabinet already gave short, and one outside the work folder, stay as they are
  expect(workRelative("03 SMARCOMMS/clients/acme/work")).toBe("03 SMARCOMMS/clients/acme/work");
  expect(workRelative("/home/laurenz/notes")).toBe("/home/laurenz/notes");
  expect(workRelative("/opt/workstation-old/x")).toBe("/opt/workstation-old/x");
  expect(workRelative("/")).toBe("/");
});

it("shortens a long path in the middle, keeping the first folder and the last ones", () => {
  expect(shortPath("11 Step Social/.tmp/football-2-music", 48)).toBe("11 Step Social/.tmp/football-2-music");
  const long = "03 SMARCOMMS/clients/cardinal-plumbing-drain-services/work/dec2026-revision";
  expect(shortPath(long, 48)).toBe("03 SMARCOMMS/…/work/dec2026-revision");
  expect(shortPath(long, 80)).toBe(long);
  expect(shortPath(long, 31)).toBe("03 SMARCOMMS/…/dec2026-revision");
  // no room for the last name whole: it is cut in its middle, both ends kept
  expect(shortPath("03 SMARCOMMS/clients/a-very-long-folder-name-for-a-single-reel-export-2026", 40)).toBe("03 SMARCOMMS/…/a-very-long-…-export-2026");
  expect(shortPath("one-single-folder-name-that-is-much-too-long", 20)).toBe("one-single…-too-long");
  expect(shortPath("a/b-long-name-of-a-folder-here", 16)).toBe("a/b-long…er-here");
  for (const max of [8, 12, 20, 31, 48]) expect(shortPath(long, max).length).toBeLessThanOrEqual(max);
});

it("names a folder and says where it is", () => {
  expect(folderLabel("/opt/workstation/11 Step Social/.tmp/football-2-music")).toEqual({ name: "football-2-music", where: "11 Step Social/.tmp" });
  expect(folderLabel("/opt/workstation/03 SMARCOMMS/clients/cardinal-plumbing-drain-services/work/dec2026-revision"))
    .toEqual({ name: "dec2026-revision", where: "03 SMARCOMMS/clients/cardinal-plumbing-drain-services/work" });
  // directly in the work folder: nothing to say about where
  expect(folderLabel("/opt/workstation/Week A")).toEqual({ name: "Week A", where: "" });
  expect(folderLabel("03 SMARCOMMS/clients/acme/work")).toEqual({ name: "work", where: "03 SMARCOMMS/clients/acme" });
  expect(folderLabel("/srv")).toEqual({ name: "srv", where: "/" });
  const deep = folderLabel(`/opt/workstation/03 SMARCOMMS/${"deeper-folder/".repeat(8)}last`);
  expect(deep.name).toBe("last");
  expect(deep.where.length).toBeLessThanOrEqual(60);
  expect(deep.where.startsWith("03 SMARCOMMS/…/")).toBe(true);
});

it("says what a dry run found and what a run did", () => {
  expect(folderCount(1)).toBe("1 folder");
  expect(folderCount(68)).toBe("68 folders");
  expect(folderCount(1234)).toBe("1,234 folders");
  expect(formatFree(37)).toBe("37.0 GB");
  expect(formatFree(41.25)).toBe("41.3 GB");
  expect(formatFree(null)).toBe("–");
  expect(previewLine({ folders: 68, bytes: 4_926_428_642 })).toBe("68 folders, 4.6 GB would move.");
  expect(previewLine({ folders: 1, bytes: 712_228_226 })).toBe("1 folder, 679 MB would move.");
  expect(resultLine({ moved: 3, bytes: 123_456_789 })).toBe("Moved 3 folders, 118 MB.");
  expect(resultLine({ moved: 1, bytes: 2048 })).toBe("Moved 1 folder, 2.0 KB.");
  expect(resultLine({ moved: 0, bytes: 0 })).toBe("Nothing was moved.");
  expect(freeLine({ free_before_gb: 37.1, free_after_gb: 41.2 })).toBe("Free: 37.1 GB → 41.2 GB");
  expect(freeLine({ free_before_gb: null, free_after_gb: 41.2 })).toBeNull();
  expect(alsoLine({ scratch_folders: 2, scratch_bytes: 142_880_768, browser_files: 0 })).toBe("Also cleared 2 old scratch folders (136 MB).");
  expect(alsoLine({ scratch_folders: 1, scratch_bytes: 2048, browser_files: 3 })).toBe("Also cleared 1 old scratch folder (2.0 KB) and packed 3 old browser files to Drive.");
  expect(alsoLine({ scratch_folders: 0, scratch_bytes: 0, browser_files: 1 })).toBe("Also packed 1 old browser file to Drive.");
  expect(alsoLine({ scratch_folders: 0, scratch_bytes: 0, browser_files: 0 })).toBeNull();
});

it("lists the largest folders and counts the rest", () => {
  const items: CabinetFolder[] = [100, 900, 300, 700, 500, 200, 800].map((bytes) => ({ path: `/opt/workstation/f${bytes}`, bytes, idle_hours: 30 }));
  const { shown, more } = largestFolders({ folders: 68, items });
  expect(shown.map((item) => item.bytes)).toEqual([900, 800, 700, 500, 300]);
  expect(more).toBe(63);
  expect(largestFolders({ folders: 2, items: items.slice(0, 2) })).toMatchObject({ more: 0 });
  expect(largestFolders({ folders: 0, items: [] })).toEqual({ shown: [], more: 0 });
});

it("tells time spent and time since in short words", () => {
  expect(elapsedLabel(0)).toBe("0 s");
  expect(elapsedLabel(45.4)).toBe("45 s");
  expect(elapsedLabel(95)).toBe("1 min 35 s");
  expect(elapsedLabel(120)).toBe("2 min");
  expect(elapsedLabel(3_725)).toBe("1 h 2 min");
  expect(elapsedLabel(7_200)).toBe("2 h");
  expect(elapsedLabel(-5)).toBe("0 s");
  expect(agoLabel(20_000)).toBe("just now");
  expect(agoLabel(5 * 60_000)).toBe("5 min ago");
  expect(agoLabel(3 * 3_600_000)).toBe("3 h ago");
  expect(agoLabel(26 * 3_600_000)).toBe("1 day ago");
  expect(agoLabel(3 * 86_400_000)).toBe("3 days ago");
  expect(agoLabel(-1000)).toBe("just now");
});

it("puts a refusal in the owner's words", () => {
  expect(cabinetProblem("cabinet_busy", "cabinet sync is running (pid 7)")).toContain("Another cabinet job is running");
  expect(cabinetProblem("cabinet_busy", "x")).toContain("Try again in a few minutes");
  expect(cabinetProblem("preview_timeout", "x")).toContain("took too long");
  expect(cabinetProblem("read_only", "this device can only watch")).toContain("can only watch");
  expect(cabinetProblem("bad_output", "cabinet did not answer in JSON.")).toBe("The check did not work: cabinet did not answer in JSON.");
  expect(cabinetProblem(null, "502 Bad Gateway")).toBe("502 Bad Gateway");
  expect(cabinetProblem("something_new", "the server's own words")).toBe("the server's own words");
});

it("sums up the last run in one line", () => {
  const result: CabinetResult = { ok: true, moved: 3, bytes: 123_456_789, waiting: 0, busy: [], failed: 0, fails: [], scratch_folders: 0, scratch_bytes: 0, browser_files: 0, free_before_gb: 37.1, free_after_gb: 41.2, seconds: 95 };
  const run = (extra: Partial<CabinetRun>): CabinetRun => ({ id: "tidy-1", state: "done", started_at: 1_000_000, finished_at: 1_095_000, result, message: null, ...extra });
  const now = 1_095_000 + 5 * 60_000;
  expect(lastRunLine(run({}), now)).toBe("Last run 5 min ago: moved 3 folders, 118 MB.");
  expect(lastRunLine(run({ result: { ...result, moved: 0, bytes: 0 } }), now)).toBe("Last run 5 min ago: nothing was moved.");
  expect(lastRunLine(run({ result: { ...result, ok: false, moved: 2, failed: 1, fails: ["a/b"] } }), now)).toBe("Last run 5 min ago: moved 2 folders, 118 MB, 1 could not be moved.");
  expect(lastRunLine(run({ state: "busy", result: null, message: "locked" }), now)).toBe("Last try 5 min ago: another cabinet job was running, nothing was changed.");
  expect(lastRunLine(run({ state: "failed", result: null, message: "x" }), now)).toBe("Last try 5 min ago: it did not finish.");
  expect(lastRunLine(run({ state: "running", finished_at: null, result: null }), now)).toBeNull();
});
