import { createContext } from "react";

/**
 * File paths in the chat, as agents write them ("saved to docs/demo.mp4", `~/out/x.png`),
 * opened in the file viewer. A bare path needs a folder in it and an extension, so words
 * like "and/or" or "e.g." stay text; code spans need only look like one file name.
 */

// a path starts where a run of its characters starts, `+` among them: a line of plus signs is
// otherwise tried as a path from every one of them, to its end. `~/` still starts one after a
// plus sign (`+~/notes/a.md`, a line of a diff)
const BARE_PATH = /(?<![\w/.@~-])(?<!\+(?!~))((?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)+[\w@+-][\w@.+-]*\.[A-Za-z0-9]{1,8})(?![\w/])/g;
// backticks say it is one name, so `café.jpg`'s letters count here; a bare path stays stricter
const CODE_PATH = /^(?:~\/|\.{1,2}\/|\/)?(?:[\p{L}\p{N}\p{M}_@.+-]+\/)*[\p{L}\p{N}\p{M}_@+-][\p{L}\p{N}\p{M}_@.+-]*\.[A-Za-z0-9]{1,8}$/u;
// a number in brackets before the extension is a download's name (`shot(1).jpg`), `fn(1).map` stays code
const NUMBERED_CODE_PATH = /^(?:~\/|\.{1,2}\/|\/)?(?:[\p{L}\p{N}\p{M}_@.+-]+\/)*[\p{L}\p{N}\p{M}_@+-][\p{L}\p{N}\p{M}_@.+-]*\(\d+\)\.(?:png|jpe?g|gif|webp|svg|avif|pdf|docx?|xlsx?|pptx?)$/iu;

/**
 * A bare dotted name that is code or a host, not a file: what agents write in backticks all the
 * time (`process.env`, `Math.random`, `tool.monitor`). Named one
 * by one, not by the word before the dot: `tool.vue`, `os.conf` and `std.lock` are files, and
 * so is anything else with an extension, as a list of extensions always misses some.
 */
const CODE_NAME = /^(?:process\.(?:env|argv|cwd|exit|platform|stdout|stderr|stdin)(?:\.\w+)?|Math\.(?:random|floor|ceil|round|max|min|abs|pow|sqrt|trunc|sign)|JSON\.(?:parse|stringify)|console\.(?:log|error|warn|info|debug)|Object\.(?:keys|values|entries|assign|freeze)|Array\.(?:from|isArray)|Promise\.(?:all|race|any|allSettled|resolve|reject)|Number\.(?:isFinite|isInteger|parseInt|parseFloat)|tool\.(?:monitor|read|bash|grep|write|edit)|os\.(?:path|environ|getcwd|getenv)|sys\.(?:argv|path|exit|stdout|stderr)|window\.(?:location|history|open)|document\.(?:body|title|cookie))$/;
function isCodeName(name: string): boolean {
  return !name.includes("/") && CODE_NAME.test(name);
}

/** The document and media files a path with spaces may end in: the viewer shows them all. */
const VIEWED_EXTENSION = "pdf|docx?|docm|dotx?|odt|rtf|xlsx?|xlsm|xlsb|ods|pptx?|pptm|ppsx?|potx?|odp|csv|png|jpe?g|gif|webp|svg|mp4|m4v|mov|webm|mp3|m4a|wav|ogg";
/**
 * A rooted path whose folders hold spaces, written bare (`saved to /opt/work/03 Social/a.jpg`): on
 * this PC nearly every work file has one, and cut at the space it read as the wrong file
 * (`Social/a.jpg`). Prose has spaces too, so it stays narrow: it ends at the first document or media
 * extension, a segment holds at most five words and none of a sentence's punctuation, and `isSpacedFolder`
 * asks for a space in a FOLDER, as `/usr/bin/convert in.png` is a command naming a file.
 */
const WORD = "[^\\s/\\\\,;:!?*|\"'`<>()\\[\\]]+";
const NAME_WORD = "[^\\s/\\\\,;:!?*|\"'`<>\\[\\]]+?";
const SPACED_BARE_PATH = new RegExp(`(?<![\\w/.@~-])((?:~/|/)(?:${WORD}(?: ${WORD}){0,4}/){1,24}${NAME_WORD}(?: ${NAME_WORD}){0,4}?\\.(?:${VIEWED_EXTENSION}))(?![\\w/]|\\.\\w)`, "gi");
const isSpacedFolder = (path: string): boolean => path.slice(0, path.lastIndexOf("/")).includes(" ");

/** The paths with no space in them, in a run of text with none of the spaced ones. */
function pushPlainPaths(parts: (string | { path: string })[], text: string): void {
  let offset = 0;
  for (const match of text.matchAll(BARE_PATH)) {
    const index = match.index ?? 0;
    // a version number or a domain is not a path: one of its segments must hold a letter
    if (!/[A-Za-z]/.test(match[1]!.replace(/\.[A-Za-z0-9]{1,8}$/, ""))) continue;
    if (index > offset) parts.push(text.slice(offset, index));
    parts.push({ path: match[1]! });
    offset = index + match[0].length;
  }
  if (offset < text.length) parts.push(text.slice(offset));
}

/** Text split into plain runs and the file paths in it. */
export function splitFilePaths(text: string): (string | { path: string })[] {
  const parts: (string | { path: string })[] = [];
  let offset = 0;
  // a space is what a spaced path needs: most text has neither it and a slash, so most text skips this
  if (text.includes("/") && text.includes(" ")) {
    for (const match of text.matchAll(SPACED_BARE_PATH)) {
      if (!isSpacedFolder(match[1]!)) continue;
      const index = match.index ?? 0;
      if (index > offset) pushPlainPaths(parts, text.slice(offset, index));
      parts.push({ path: match[1]! });
      offset = index + match[0].length;
    }
  }
  if (offset === 0) pushPlainPaths(parts, text);
  else if (offset < text.length) pushPlainPaths(parts, text.slice(offset));
  return parts;
}

/**
 * A rooted path with spaces in its folders or name (`/opt/work/09 Online Jobs/Report.docx`),
 * which counts only when it ends in a document or media file the viewer shows: a command line
 * in backticks has spaces too (`/usr/bin/env python3 x.py`), and so does one that names files
 * (`/usr/bin/convert in.png out.pdf`), hence no extension may stand before a space either.
 */
const SPACED_CODE_PATH = new RegExp(`^(?:~\\/|\\.{1,2}\\/|\\/)(?:[^/\\n\`]+\\/)*[^/\\n\`]+\\.(?:${VIEWED_EXTENSION})$`, "i");

/** A code span that is a single file name or path (`README.md`, `src/app.ts`). */
export function codeIsFilePath(code: string): boolean {
  if (code.includes(" ")) return SPACED_CODE_PATH.test(code) && !/\.[A-Za-z0-9]{1,8}\s|\s-|\s{2}|\s\/|\/\s/.test(code);
  return (CODE_PATH.test(code) || NUMBERED_CODE_PATH.test(code)) && !isCodeName(code) && /[A-Za-z]/.test(code.replace(/\.[A-Za-z0-9]{1,8}$/, "")) && !/^\d+(?:\.\d+)+$/.test(code);
}

/** Opens a path in the file viewer; null where nothing can open one (paths stay text). */
export const OpenFileContext = createContext<((path: string) => void) | null>(null);

/** An image file the chat draws as a thumbnail, as it does an `@path` the composer attached. */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg|avif)$/i;
export function isImagePath(path: string): boolean {
  return IMAGE_FILE.test(path);
}

/**
 * A video the chat plays in place when an answer writes it as `![…](path)`. Only these two: the
 * /api/fs/video route serves nothing else, and a .mov stays the link it was.
 */
const VIDEO_FILE = /\.(?:mp4|webm)$/i;
export function isVideoPath(path: string): boolean {
  return VIDEO_FILE.test(path);
}
/** The picture a player shows before it is played: the one the preview script leaves beside the video, `reel.mp4` -> `reel.poster.jpg`. */
export function videoPosterPath(path: string): string {
  return path.replace(VIDEO_FILE, ".poster.jpg");
}

/** The address an <img> reads a file from, for the pane the chat belongs to; null where no pane serves one (images stay paths). */
export const FileUrlContext = createContext<((path: string) => string) | null>(null);
