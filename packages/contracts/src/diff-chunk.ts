// A file's patch too large to send whole, served in bounded chunks of hunks, and the summary a
// generated file (a lockfile, a minified bundle) gets instead. Pure, so the server and the web's
// mock page through a patch the same way.

import * as Schema from "effect/Schema";
import { DiffScope } from "./git.ts";

/** Where a chunk starts: a hunk of the file's patch, and a line of that hunk's body. */
export const DiffCursor = Schema.Struct({
  hunk: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type DiffCursor = typeof DiffCursor.Type;

export const GeneratedKind = Schema.Literals(["lockfile", "minified", "source map"]);
export type GeneratedKind = typeof GeneratedKind.Type;

/** A part of a generated file the patch changed: a package of a lockfile, say. */
export const DiffSection = Schema.Struct({
  name: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
});
export type DiffSection = typeof DiffSection.Type;

export const DiffSummary = Schema.Struct({
  hunks: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int,
  /** In the order the patch first changes them, at most `MAX_SUMMARY_SECTIONS`. */
  sections: Schema.Array(DiffSection),
  /** Sections changed past the listed ones. */
  moreSections: Schema.Int,
});
export type DiffSummary = typeof DiffSummary.Type;

export const DiffChunkFields = {
  scope: DiffScope,
  /** Relative to the checkout, as `DiffFile.path` has it. */
  path: Schema.String,
  /** A rename's old path, so git pairs the two sides. */
  oldPath: Schema.optionalKey(Schema.String),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  /** Absent: the first chunk. */
  cursor: Schema.optionalKey(DiffCursor),
  /** Hunks wanted, clamped to `1..MAX_CHUNK_HUNKS`; `DEFAULT_CHUNK_HUNKS` when absent. */
  hunks: Schema.optionalKey(Schema.Int),
  /** `summary`: the counts and sections changed, and no lines. */
  mode: Schema.optionalKey(Schema.Literals(["hunks", "summary"])),
  /** The first chunk's `fingerprint`, so a later one can say the file changed in between. */
  fingerprint: Schema.optionalKey(Schema.String),
};
export const DiffChunkRequest = Schema.Struct(DiffChunkFields);
export type DiffChunkRequest = typeof DiffChunkRequest.Type;

export const DiffChunk = Schema.Struct({
  path: Schema.String,
  /** Stands for the file's whole patch as read: equal fingerprints, equal patches. */
  fingerprint: Schema.String,
  /** The request's `fingerprint` no longer matches: the hunks loaded so far are of an older patch. */
  changed: Schema.Boolean,
  binary: Schema.Boolean,
  /** Whole hunks, and a hunk the caps cut split into parts, each with a header of its own. */
  patch: Schema.String,
  /** Where the next chunk starts; absent at the end of what Gram reads. */
  next: Schema.optionalKey(DiffCursor),
  /** Hunks in the file's patch (of the part read, when `partial`). */
  totalHunks: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int,
  /** Lines in `patch` cut at `MAX_LINE_CHARS`, ending in `…`. */
  clippedLines: Schema.Int,
  /** The patch was longer than Gram reads; hunks past that aren't served, and counts are of the part read. */
  partial: Schema.Boolean,
  generated: Schema.optionalKey(GeneratedKind),
  summary: Schema.optionalKey(DiffSummary),
});
export type DiffChunk = typeof DiffChunk.Type;

/** Hunks a chunk holds at most, and when the request doesn't say. */
export const MAX_CHUNK_HUNKS = 50;
export const DEFAULT_CHUNK_HUNKS = 20;
/** Patch lines a chunk holds at most, whatever its hunk count. */
export const MAX_CHUNK_LINES = 1000;
/** UTF-8 bytes of patch a chunk holds at most. */
export const MAX_CHUNK_BYTES = 256 * 1024;
/** Characters a patch line keeps in a chunk; a minified bundle's one line would be megabytes. */
export const MAX_LINE_CHARS = 2000;
/** Sections a summary lists. */
export const MAX_SUMMARY_SECTIONS = 100;

export interface ChunkLimits {
  readonly hunks: number;
  readonly lines: number;
  readonly bytes: number;
}

export const chunkLimits = (hunks: number | undefined): ChunkLimits => ({
  hunks: Math.min(MAX_CHUNK_HUNKS, Math.max(1, Math.trunc(hunks ?? DEFAULT_CHUNK_HUNKS))),
  lines: MAX_CHUNK_LINES,
  bytes: MAX_CHUNK_BYTES,
});

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "deno.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "Podfile.lock",
  "Package.resolved",
  "packages.lock.json",
  "mix.lock",
  "pubspec.lock",
  "gradle.lockfile",
]);

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A changed line this long reads as minified code, whatever the file is called. */
const MINIFIED_LINE_CHARS = 1000;

/**
 * What kind of generated file `path` is, by its name, or by `patch` holding a changed line only a
 * minifier writes; `undefined` for a file people write.
 */
export function generatedKind(path: string, patch?: string): GeneratedKind | undefined {
  const name = baseName(path);
  if (LOCKFILES.has(name)) return "lockfile";
  if (/\.min\.(?:js|mjs|cjs|css)$|[.-]bundle\.(?:js|mjs|cjs)$/.test(name)) return "minified";
  if (/\.(?:js|mjs|cjs|css)\.map$/.test(name)) return "source map";
  if (patch === undefined) return undefined;
  let checked = 0;
  for (const line of patchLines(patch)) {
    if ((line.startsWith("+") || line.startsWith("-")) && line.length > MINIFIED_LINE_CHARS) {
      return "minified";
    }
    if (++checked >= 400) break;
  }
  return undefined;
}

/** `text`'s lines, without the newline and without building an array of them. */
export function* patchLines(text: string): Generator<string> {
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl === -1 ? text.length : nl;
    yield text.charCodeAt(end - 1) === 13 ? text.slice(at, end - 1) : text.slice(at, end);
    at = end + 1;
  }
}

/** UTF-8 bytes of `text`, plus its newline. */
const lineBytes = (text: string) => {
  let bytes = 1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code < 0xdc00 ? 4 : 3;
    if (code >= 0xd800 && code < 0xdc00) i++;
  }
  return bytes;
};

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

interface HunkHead {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly context: string;
}

const parseHeader = (line: string): HunkHead | undefined => {
  const match = HEADER.exec(line);
  if (!match) return undefined;
  const [, oldStart, oldCount, newStart, newCount, context] = match;
  return {
    oldStart: Number(oldStart),
    oldCount: oldCount === undefined ? 1 : Number(oldCount),
    newStart: Number(newStart),
    newCount: newCount === undefined ? 1 : Number(newCount),
    context: context ?? "",
  };
};

/** The line a side's first line is; git names the line before for a side with no lines. */
const firstLine = (start: number, count: number) => (count === 0 ? start + 1 : start);

/** `start,count` as git writes it: the count left out when it is 1, the line before when it is 0. */
const range = (first: number, count: number) =>
  count === 1 ? `${first}` : `${count === 0 ? Math.max(0, first - 1) : first},${count}`;

interface Slice {
  readonly oldFirst: number;
  readonly newFirst: number;
  oldCount: number;
  newCount: number;
  readonly context: string;
  readonly lines: Array<string>;
}

const sliceText = (slice: Slice) =>
  [
    `@@ -${range(slice.oldFirst, slice.oldCount)} +${range(slice.newFirst, slice.newCount)} @@${slice.context === "" ? "" : ` ${slice.context}`}`,
    ...slice.lines,
  ].join("\n");

export interface PatchChunk {
  readonly patch: string;
  readonly next?: DiffCursor;
  readonly totalHunks: number;
  readonly additions: number;
  readonly deletions: number;
  readonly clippedLines: number;
}

/**
 * The chunk of `patch` (a file's, from the first `@@` onward) from `cursor`: up to `limits.hunks`
 * hunks, `limits.lines` lines and `limits.bytes` bytes. A hunk the caps fall inside is split there,
 * each part given a header of its own with the right line numbers, and `next` points at the rest. A
 * `\ No newline` note stays with its line. A cursor past the end gives an empty chunk with no `next`.
 * The whole patch is counted, so the totals don't depend on the cursor.
 */
export function chunkPatch(
  patch: string,
  cursor: DiffCursor = { hunk: 0, line: 0 },
  limits: ChunkLimits = chunkLimits(undefined),
): PatchChunk {
  const slices: Array<Slice> = [];
  let open: Slice | undefined;
  let hunk = -1;
  let line = 0;
  let head: HunkHead | undefined;
  let nextOld = 0;
  let nextNew = 0;
  let lines = 0;
  let bytes = 0;
  let clipped = 0;
  let next: DiffCursor | undefined;
  let additions = 0;
  let deletions = 0;
  const started = () => hunk > cursor.hunk || (hunk === cursor.hunk && line >= cursor.line);
  const collecting = () => next === undefined && started();
  const openSlice = () => {
    open = {
      oldFirst: nextOld,
      newFirst: nextNew,
      oldCount: 0,
      newCount: 0,
      context: head?.context ?? "",
      lines: [],
    };
    slices.push(open);
    bytes += lineBytes(sliceText(open));
  };
  for (const text of patchLines(patch)) {
    const parsed = text.startsWith("@@") ? parseHeader(text) : undefined;
    if (parsed !== undefined) {
      hunk += 1;
      line = 0;
      head = parsed;
      nextOld = firstLine(parsed.oldStart, parsed.oldCount);
      nextNew = firstLine(parsed.newStart, parsed.newCount);
      open = undefined;
      if (collecting()) {
        if (slices.length >= limits.hunks) next = { hunk, line: 0 };
        else openSlice();
      }
      continue;
    }
    if (head === undefined) continue;
    const sign = text[0];
    if (sign === "+") additions += 1;
    else if (sign === "-") deletions += 1;
    if (collecting()) {
      const note = sign === "\\";
      const kept = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
      const size = lineBytes(kept);
      const full = lines >= limits.lines || (lines > 0 && bytes + size > limits.bytes);
      // A note belongs to the line above it, wherever the caps fall.
      if (full && !(note && open !== undefined)) {
        next = { hunk, line };
        open = undefined;
      } else {
        if (open === undefined) {
          if (slices.length >= limits.hunks) next = { hunk, line };
          else openSlice();
        }
        if (open !== undefined) {
          open.lines.push(kept);
          if (kept !== text) clipped += 1;
          if (!note) lines += 1;
          bytes += size;
          if (sign === "-") open.oldCount += 1;
          else if (sign === "+") open.newCount += 1;
          else if (!note) {
            open.oldCount += 1;
            open.newCount += 1;
          }
        }
      }
    }
    if (sign === "-") nextOld += 1;
    else if (sign === "+") nextNew += 1;
    else if (sign !== "\\") {
      nextOld += 1;
      nextNew += 1;
    }
    line += 1;
  }
  return {
    patch: slices.length === 0 ? "" : `${slices.map(sliceText).join("\n")}\n`,
    ...(next === undefined ? {} : { next }),
    totalHunks: hunk + 1,
    additions,
    deletions,
    clippedLines: clipped,
  };
}

/** Package name from a lockfile key: `/@scope/name@1.2.3(peer)` → `@scope/name`. */
const packageName = (key: string) => {
  const bare = key.replace(/^['"/]+|['"]+$/g, "");
  const at = bare.indexOf("@", 1);
  return at === -1 ? bare : bare.slice(0, at);
};

type SectionOf = (line: string) => string | undefined;

/** Per lockfile name, the section a line (sign stripped) opens, if it opens one. */
const SECTION_OPENERS: Readonly<Record<string, SectionOf>> = {
  "pnpm-lock.yaml": (line) => {
    const match = /^ {2}(['"]?[^\s'"][^:]*?['"]?):\s*(?:\{\})?$/.exec(line);
    return match ? packageName(match[1]!) : undefined;
  },
  "package-lock.json": (line) => /^\s*"(?:[^"]*\/)?node_modules\/([^"]+)":\s*\{/.exec(line)?.[1],
  "npm-shrinkwrap.json": (line) => /^\s*"(?:[^"]*\/)?node_modules\/([^"]+)":\s*\{/.exec(line)?.[1],
  "yarn.lock": (line) => {
    const match = /^"?((?:@[^@\s"/]+\/)?[^@\s",]+)@/.exec(line);
    return match?.[1];
  },
  "bun.lock": (line) => /^\s{4}"((?:@[^"/]+\/)?[^"@]+)":\s*\[/.exec(line)?.[1],
  "Cargo.lock": (line) => /^name = "([^"]+)"/.exec(line)?.[1],
  "poetry.lock": (line) => /^name = "([^"]+)"/.exec(line)?.[1],
  "uv.lock": (line) => /^name = "([^"]+)"/.exec(line)?.[1],
  "pdm.lock": (line) => /^name = "([^"]+)"/.exec(line)?.[1],
  "Gemfile.lock": (line) => /^ {4}([\w.-]+) \(/.exec(line)?.[1],
  "composer.lock": (line) => /^\s*"name":\s*"([^"]+)"/.exec(line)?.[1],
  "go.sum": (line) => /^(\S+) v/.exec(line)?.[1],
  "Pipfile.lock": (line) => /^\s{8}"([^"]+)":\s*\{/.exec(line)?.[1],
};

/**
 * What `patch` (a file's, from the first `@@` onward) changed, without its lines: the counts, and
 * the sections the changed lines fall in. A lockfile's section is a package, read off the lines
 * that name one; a line before any of those in its hunk falls in the section git named in the hunk
 * header, else in the hunk's line range.
 */
export function summarizePatch(path: string, patch: string): DiffSummary {
  const opener = SECTION_OPENERS[baseName(path)];
  const sections = new Map<string, { additions: number; deletions: number }>();
  const more = new Set<string>();
  let hunks = 0;
  let additions = 0;
  let deletions = 0;
  let current = "";
  const count = (sign: "+" | "-") => {
    let section = sections.get(current);
    if (section === undefined) {
      if (sections.size >= MAX_SUMMARY_SECTIONS) {
        more.add(current);
        return;
      }
      section = { additions: 0, deletions: 0 };
      sections.set(current, section);
    }
    if (sign === "+") section.additions += 1;
    else section.deletions += 1;
  };
  for (const text of patchLines(patch)) {
    const head = text.startsWith("@@") ? parseHeader(text) : undefined;
    if (head !== undefined) {
      hunks += 1;
      const first = firstLine(head.newStart, head.newCount);
      current =
        head.context.trim() ||
        (head.newCount <= 1 ? `Line ${first}` : `Lines ${first}–${first + head.newCount - 1}`);
      continue;
    }
    if (hunks === 0) continue;
    const sign = text[0];
    const opened = opener?.(text.slice(1));
    if (opened !== undefined && opened !== "") current = opened;
    if (sign === "+") {
      additions += 1;
      count("+");
    } else if (sign === "-") {
      deletions += 1;
      count("-");
    }
  }
  return {
    hunks,
    additions,
    deletions,
    sections: [...sections].map(([name, counts]) => ({ name, ...counts })),
    moreSections: more.size,
  };
}
