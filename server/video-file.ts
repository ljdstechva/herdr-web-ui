/**
 * The one file the chat's inline player may read: an .mp4 or .webm inside the work folder. The
 * path is judged after every link in it is followed, so a link in the folder cannot reach out of
 * it, and a link named .mp4 cannot hand over some other file. Who may ask at all is decided
 * before this runs, as for every /api/fs/ route (a watching device is refused there).
 */
import { realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

import type { FileInfo } from "../shared/protocol.ts";
import { fileInfo } from "./file-view.ts";

const VIDEO_ROOT = "/opt/workstation";
const VIDEO_FILE = /\.(?:mp4|webm)$/i;

/** The video at this path, or null for anything it may not serve: the caller does not say which. */
export function chatVideo(path: string, root = VIDEO_ROOT): FileInfo | null {
  if (!isAbsolute(path) || path.includes("\0") || path.split("/").includes("..") || !VIDEO_FILE.test(path)) return null;
  let real: string;
  let top: string;
  try {
    real = realpathSync(path);
    top = realpathSync(root);
  } catch {
    return null;
  }
  if (!real.startsWith(top + sep) || !VIDEO_FILE.test(real)) return null;
  const info = fileInfo(real);
  return info !== null && info.kind === "video" ? info : null;
}
