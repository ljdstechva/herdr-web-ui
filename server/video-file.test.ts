import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chatVideo } from "./video-file.ts";

describe("chat video", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const setup = () => {
    const base = mkdtempSync(join(tmpdir(), "herdr-video-"));
    dirs.push(base);
    const root = join(base, "work");
    mkdirSync(join(root, "client folder"), { recursive: true });
    for (const name of ["client folder/a.mp4", "client folder/b.WEBM", "client folder/c.mov", "client folder/d.jpg", "client folder/e.txt"]) writeFileSync(join(root, name), "x");
    writeFileSync(join(base, "secret.mp4"), "x");
    writeFileSync(join(base, "secret.txt"), "x");
    return { base, root };
  };

  it("serves an .mp4 or .webm inside the folder", () => {
    const { root } = setup();
    expect(chatVideo(join(root, "client folder/a.mp4"), root)?.mime).toBe("video/mp4");
    expect(chatVideo(join(root, "client folder/b.WEBM"), root)?.mime).toBe("video/webm");
  });

  it("serves nothing but those two types", () => {
    const { root } = setup();
    for (const name of ["c.mov", "d.jpg", "e.txt"]) expect(chatVideo(join(root, "client folder", name), root)).toBeNull();
    expect(chatVideo(join(root, "client folder"), root)).toBeNull();
    expect(chatVideo(join(root, "client folder/missing.mp4"), root)).toBeNull();
  });

  it("refuses a path out of the folder, however it is written", () => {
    const { base, root } = setup();
    expect(chatVideo(join(base, "secret.mp4"), root)).toBeNull();
    expect(chatVideo(`${root}/../secret.mp4`, root)).toBeNull();
    expect(chatVideo(`${root}/client folder/../a.mp4`, root)).toBeNull();
    expect(chatVideo("client folder/a.mp4", root)).toBeNull();
    expect(chatVideo("~/a.mp4", root)).toBeNull();
    expect(chatVideo("", root)).toBeNull();
    expect(chatVideo(`${root}/client folder/a.mp4\0.txt`, root)).toBeNull();
    // a sibling that only starts with the folder's name
    mkdirSync(`${root}-other`); writeFileSync(`${root}-other/x.mp4`, "x"); dirs.push(`${root}-other`);
    expect(chatVideo(`${root}-other/x.mp4`, root)).toBeNull();
  });

  it("follows links before it judges", () => {
    const { base, root } = setup();
    symlinkSync(join(base, "secret.mp4"), join(root, "out.mp4"));
    symlinkSync(join(base, "secret.txt"), join(root, "out-text.mp4"));
    symlinkSync(join(root, "client folder/e.txt"), join(root, "in-text.mp4"));
    symlinkSync(join(root, "client folder/a.mp4"), join(root, "fine.mp4"));
    symlinkSync(root, join(base, "alias"));
    expect(chatVideo(join(root, "out.mp4"), root)).toBeNull();
    expect(chatVideo(join(root, "out-text.mp4"), root)).toBeNull();
    expect(chatVideo(join(root, "in-text.mp4"), root)).toBeNull();
    expect(chatVideo(join(root, "fine.mp4"), root)?.name).toBe("a.mp4");
    // /opt/workspace is such an alias of /opt/workstation
    expect(chatVideo(join(base, "alias/client folder/a.mp4"), root)?.name).toBe("a.mp4");
  });
});
