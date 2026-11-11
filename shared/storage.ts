/**
 * What the Files browser and the server agree on about a new folder's name. Shared so the field
 * says what is wrong before the request leaves, and the server refuses the same names when a
 * client did not ask first.
 *
 * Stricter than Linux needs: the names Windows refuses are refused here too. A work folder is
 * often mirrored to a Windows PC (Syncthing, a cloud drive), and a folder that PC cannot hold
 * stops the mirror for everything beside it.
 */
export type FolderNameProblem = "empty" | "characters" | "reserved" | "long";

/** A name's length on disk: Linux counts bytes, and most file systems stop at 255. */
const MAX_NAME_BYTES = 255;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** The name as it will be made: without the spaces around it. */
export function folderName(input: string): string {
  return input.trim();
}

/** Why a folder cannot be named this, or null when it can. */
export function folderNameProblem(input: string): FolderNameProblem | null {
  const name = folderName(input);
  if (name === "") return "empty";
  // a path of its own (`a/b`, `..`) is not a name; the rest are what Windows cannot hold
  if (name === "." || name === ".." || /[\\/<>:"|?*\u0000-\u001f]/.test(name) || name.endsWith(".")) return "characters";
  if (WINDOWS_RESERVED.test(name)) return "reserved";
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return "long";
  return null;
}
