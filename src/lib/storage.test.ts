import { describe, expect, it } from "bun:test";

import type { DirectoryListing, StorageUsage } from "../../shared/protocol.ts";
import { browserRows, childPath, formatSize, volumeUsed } from "./storage.ts";

describe("formatSize", () => {
  it("reads as a file manager does, up to terabytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(812)).toBe("812 B");
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(14_500)).toBe("14 KB");
    expect(formatSize(3.4 * 1024 ** 2)).toBe("3.4 MB");
    expect(formatSize(250 * 1024 ** 2)).toBe("250 MB");
    expect(formatSize(15_894_437_179)).toBe("14.8 GB");
    expect(formatSize(96 * 1024 ** 3)).toBe("96 GB");
    expect(formatSize(250 * 1024 ** 3)).toBe("250 GB");
    expect(formatSize(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatSize(2.25 * 1024 ** 4)).toBe("2.3 TB");
    expect(formatSize(5000 * 1024 ** 4)).toBe("5000 TB");
  });
  it("never shows 1024 of a unit, or less than nothing", () => {
    expect(formatSize(1024 ** 2 - 1)).toBe("1 MB");
    expect(formatSize(1024 ** 3 - 1)).toBe("1 GB");
    expect(formatSize(-5)).toBe("0 B");
  });
});

const listing: DirectoryListing = {
  path: "/work", parent: "/", home: "/home/me", truncated: false,
  directories: ["archive", "brand", "linked", "work"],
  files: [{ name: "brief.md", size: 2000 }, { name: "reel.mp4", size: 800_000 }, { name: "empty.txt", size: 0 }],
};
const usage: StorageUsage = {
  path: "/work", name: "work", kind: "folder", size: 1_902_000, disk: 1_910_000, files: 9, folders: 5, modified: "2026-11-11T00:00:00.000Z", partial: false,
  children: { archive: { size: 100_000, files: 3 }, brand: { size: 0, files: 0 }, work: { size: 1_000_000, files: 3 } }, volume: { total: 100, free: 40 },
};

describe("browserRows", () => {
  it("lists folders then files, each with its part of the largest row", () => {
    const rows = browserRows(listing, usage, "name");
    expect(rows.map((row) => row.name)).toEqual(["archive", "brand", "linked", "work", "brief.md", "reel.mp4", "empty.txt"]);
    expect(rows.find((row) => row.name === "work")).toEqual({ name: "work", folder: true, size: 1_000_000, files: 3, share: 100 });
    expect(rows.find((row) => row.name === "reel.mp4")!.share).toBe(80);
    // something in it: a sliver, never nothing
    expect(rows.find((row) => row.name === "brief.md")!.share).toBe(1);
    expect(rows.find((row) => row.name === "brand")!.share).toBe(0);
    expect(rows.find((row) => row.name === "empty.txt")!.share).toBe(0);
  });

  it("leaves a folder the walk did not enter without a size", () => {
    expect(browserRows(listing, usage, "name").find((row) => row.name === "linked")).toEqual({ name: "linked", folder: true, size: null, files: null, share: 0 });
  });

  it("puts the largest first by size, what is not measured last", () => {
    expect(browserRows(listing, usage, "size").map((row) => row.name)).toEqual(["work", "reel.mp4", "archive", "brief.md", "brand", "empty.txt", "linked"]);
  });

  it("shows files at once and folders unmeasured until this folder's walk answers", () => {
    const before = browserRows(listing, null, "name");
    expect(before.filter((row) => row.folder).every((row) => row.size === null)).toBe(true);
    expect(before.find((row) => row.name === "reel.mp4")!.share).toBe(100);
    // the walk of the folder left behind says nothing about this one
    const other = browserRows(listing, { ...usage, path: "/elsewhere" }, "name");
    expect(other.find((row) => row.name === "work")!.size).toBeNull();
  });

  it("reads a folder named like an object's own member as a folder", () => {
    const odd = browserRows({ ...listing, directories: ["constructor", "toString"], files: [] }, { ...usage, children: Object.assign(Object.create(null), { constructor: { size: 5, files: 1 } }) }, "name");
    expect(odd.map((row) => row.size)).toEqual([5, null]);
  });
});

describe("paths and the volume meter", () => {
  it("joins a name to its folder, the root included", () => {
    expect(childPath("/opt/work", "a b")).toBe("/opt/work/a b");
    expect(childPath("/", "etc")).toBe("/etc");
  });
  it("says how full the volume is", () => {
    expect(volumeUsed({ total: 96, free: 38 })).toBe(60);
    expect(volumeUsed({ total: 0, free: 0 })).toBe(0);
    expect(volumeUsed({ total: 10, free: 20 })).toBe(0);
  });
});
