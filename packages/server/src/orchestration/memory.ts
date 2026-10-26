/**
 * The orchestrator's file memory, and the only door to it.
 *
 * Invariant: every filesystem operation on a workspace's memory tree, a read, a write, a history
 * copy, a prune or the `CURRENT` pointer, takes its path from `resolveInTree` below. Nothing in
 * this module, and nothing outside it, builds a path into the tree by hand. The user edits this
 * tree in an editor and a dream's output is agent-written, so the resolver trusts none of it: the
 * tree may hold regular files and directories only, and a symlink anywhere between the workspace
 * folder and the target refuses the operation instead of being followed.
 *
 * ```
 * <root>/<workspaceId>/
 *   CURRENT               text naming the adopted version; a file, never a symlink
 *   versions/<NNNN>/      MEMORY.md, goals.md, repos/<name>.md, …
 *     .history/<file>/    the previous versions of one file, from live writes
 * ```
 *
 * `adopt` is how a dream's output gets in: it adds `versions/<NNNN+1>/` by writing file by file
 * through the resolver, never by renaming or linking a directory an agent produced, and rewrites
 * `CURRENT` last. `confinedTree` hands the same contract to `dream-files.ts`. Dream and adoption
 * request its directory-fd implementation; ordinary memory operations use the path resolver.
 *
 * Live writes change the adopted version in place, so `versions/<NNNN>/` is not a record of what
 * a dream started from: whoever needs that baseline later has to keep its own copy (`snapshot`
 * for the hashes, the dream's out-of-folder manifest for the text).
 */
import { FsError, InvalidState, NotFound, type MemoryWrite } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { ServerConfig } from "../config.ts";
import { redactText } from "../logging/redact.ts";
import { anchoredTree } from "./anchored-tree.ts";
import type { AnchoredOptions } from "./anchored-files.ts";
import { isInside, realPath } from "@gram/git";
import { makeKeyedLock } from "../git/keyed-lock.ts";

/** The index every orchestrator session starts from. */
export const MEMORY_INDEX = "MEMORY.md";
/**
 * The user's standing decisions, which every boot digest carries whole beside the index: rulings
 * that hold until they say otherwise, such as "visual PRs merge when green", in the user's words.
 * Not `decisions.md`, which records what was decided by anyone, the orchestrator and dreams too.
 */
export const DECISIONS_FILE = "standing-decisions.md";
/** Cap on `MEMORY.md`, which is loaded into context at every boot. */
export const MEMORY_INDEX_MAX_BYTES = 8 * 1024;
/** Cap on any one memory file. */
export const MEMORY_FILE_MAX_BYTES = 32 * 1024;
/** Cap on the files of one version. */
export const MEMORY_MAX_FILES = 40;
/** Folders below the version root a file may sit in, counting the file itself. */
export const MEMORY_MAX_DEPTH = 3;
/** Previous versions kept per file. */
export const MEMORY_HISTORY_KEEP = 20;
/** Cap on each side of the diff a write reports; the file itself holds the full text. */
export const MEMORY_DIFF_MAX_BYTES = 8 * 1024;
/** A hand-edited file past this is refused rather than read into an agent's context. */
const MEMORY_READ_MAX_BYTES = 256 * 1024;

/** Adopted versions kept besides the current one; older ones are pruned at the next adoption. */
export const MEMORY_VERSIONS_KEEP = 5;

const FIRST_VERSION = "0001";
const HISTORY_DIR = ".history";
/** When a version was adopted and from what; dotted, so no memory path can name it. */
const ADOPTED_FILE = ".adopted";
const VERSION = /^\d{4}$/;
const SEGMENT_MAX_LENGTH = 100;

/** What a new workspace's `MEMORY.md` starts as. */
export const MEMORY_INDEX_TEMPLATE = `# Memory index

One line per file, plus the few facts worth having in every session. Keep this file under 8 KB.
Date every entry and name its source (a feature, a PR, a thread): an undated fact can't be judged
stale. Nothing derivable belongs here: worker states, PRs and budgets come from \`list_workers\`,
and what a repo's CLAUDE.md already says stays there.

New workspaces start with only this index. The names below are suggestions, not an inventory.
Use \`memory_list\` to see which files exist. Create a topic file only when there is something
to record, then add it to the index; a missing suggested file has no recorded content yet.

## Suggested files (created only when needed)

- goals.md: what the user wants from this workspace, in priority order, dated
- decisions.md: what was decided, why, and which feature or PR it came from
- standing-decisions.md: the user's rulings that hold until they say otherwise, in their words
- map.md: how the repos relate: who calls whom, where contracts live, merge and deploy order
- questions.md: open questions for the user; each has an id and is closed, not deleted
- repos/<name>.md: what was learned about working in one repo that its CLAUDE.md doesn't say
- workers/<id>.md: optional notes on one worker
`;

/** One memory file, as `list` reports it. */
export interface MemoryFile {
  /** POSIX path relative to the current version. */
  readonly path: string;
  readonly bytes: number;
  /** Epoch ms. */
  readonly modifiedAt: number;
}

/** Why a memory operation was refused or failed. */
export type MemoryError = InvalidState | NotFound | FsError;

/** One file of a whole memory set, as an adoption takes it. */
export interface MemorySetFile {
  /** POSIX path relative to the version. */
  readonly path: string;
  readonly content: string;
}

/** One kept version, as `versions` reports it. */
export interface MemoryVersion {
  /** `0007`. */
  readonly version: string;
  /** Epoch ms; for a version `init` made, when its folder was created. */
  readonly adoptedAt: number;
  readonly files: number;
  /** Whether `CURRENT` names it. */
  readonly current: boolean;
}

/** The current version by content hash, to tell later which files were written since. */
export interface MemorySnapshot {
  /** `""` before there is any memory. */
  readonly version: string;
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly bytes: number }>>;
}

export interface OrchestrationMemoryShape {
  /** Creates the tree with a seeded index. Safe to call again; an existing tree is left alone. */
  init(workspaceId: string): Effect.Effect<void, MemoryError>;
  /** The current version's files, by path, without `.history`. Empty before `init`. */
  list(workspaceId: string): Effect.Effect<ReadonlyArray<MemoryFile>, MemoryError>;
  /** One file's text, scrubbed again in case it was edited by hand. */
  read(workspaceId: string, path: string): Effect.Effect<string, MemoryError>;
  /** `MEMORY.md`, or `""` when there is none yet. */
  index(workspaceId: string): Effect.Effect<string, MemoryError>;
  /**
   * Replaces or creates a file, atomically, after scrubbing `content` and checking the caps. The
   * old text goes to `.history` first. Initialises the tree when there is none.
   */
  write(
    workspaceId: string,
    path: string,
    content: string,
  ): Effect.Effect<MemoryWrite, MemoryError>;
  /**
   * `write` of what `change` makes of the file's current text, `undefined` when there is none. The
   * read and the write hold one lock, so no other write lands between them; what `change` fails with
   * fails the whole, and nothing is written.
   */
  modify<A, E>(
    workspaceId: string,
    path: string,
    change: (
      current: string | undefined,
    ) => Effect.Effect<{ readonly content: string; readonly result: A }, E>,
  ): Effect.Effect<{ readonly write: MemoryWrite; readonly result: A }, MemoryError | E>;
  /** Deletes a file, keeping its text in `.history`. */
  remove(workspaceId: string, path: string): Effect.Effect<MemoryWrite, MemoryError>;
  /** The adopted version `CURRENT` names, e.g. `0001`. */
  currentVersion(workspaceId: string): Effect.Effect<string, MemoryError>;
  /** Absolute path of the adopted version's folder: what a dream copies from and diffs against. */
  root(workspaceId: string): Effect.Effect<string, MemoryError>;
  /** The kept versions, oldest first. Empty before `init`. */
  versions(workspaceId: string): Effect.Effect<ReadonlyArray<MemoryVersion>, MemoryError>;
  /** One file of a kept version, scrubbed like `read`. `NotFound` for a version that isn't kept. */
  readVersion(
    workspaceId: string,
    version: string,
    path: string,
  ): Effect.Effect<string, MemoryError>;
  /** Hashes of the current version's files as they are on disk. Empty before `init`. */
  snapshot(workspaceId: string): Effect.Effect<MemorySnapshot, MemoryError>;
  /**
   * Makes `files` the next version and points `CURRENT` at it; returns its id. The set **is** the
   * new version: nothing is carried over from the one before, its `.history` included. Every path
   * and every scrubbed content is checked against the path rules and the caps before anything is
   * written, a failure part-way removes the half-written folder and leaves `CURRENT` alone, and
   * versions beyond the newest `MEMORY_VERSIONS_KEEP` besides the current are pruned afterwards.
   * `basedOn` refuses the adoption when `CURRENT` no longer names that version (`""`: no memory
   * yet), which is how a dream that started before another adoption is stopped.
   * Optional `basedOnDigest` also fences same-version edits, comparing raw disk file hashes
   * inside this instance's memory lock. Omitted retains existing caller behavior.
   */
  adopt(
    workspaceId: string,
    files: ReadonlyArray<MemorySetFile>,
    options?: { readonly basedOn: string; readonly basedOnDigest?: string },
  ): Effect.Effect<string, MemoryError>;
  /** Points `CURRENT` back at a kept version. Nothing is copied or deleted. */
  restore(workspaceId: string, version: string): Effect.Effect<void, MemoryError>;
}

/** Same fingerprint from raw disk hashes; version is fenced separately by `basedOn`. */
export const memorySnapshotDigest = (snapshot: MemorySnapshot): string => {
  const hash = createHash("sha256");
  for (const [path, file] of Object.entries(snapshot.files).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    hash.update(JSON.stringify([path, file.sha256, file.bytes]), "utf8");
  }
  return hash.digest("hex");
};

const refuse = (message: string) => new InvalidState({ message });

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | undefined)?.code;

/** Never the raw error: its message carries absolute paths. */
const fsError = (rel: string, error: unknown) => {
  const code = codeOf(error);
  return new FsError({
    path: rel,
    message: `Can't access memory at ${rel === "" ? "its root" : rel} (${typeof code === "string" ? code : "unknown error"})`,
  });
};

const attempt = <A>(rel: string, run: () => Promise<A>): Effect.Effect<A, FsError> =>
  Effect.tryPromise({ try: run, catch: (error) => fsError(rel, error) });

/** `undefined` for a path that isn't there; every other failure is an error. */
const attemptExisting = <A>(
  rel: string,
  run: () => Promise<A>,
): Effect.Effect<A | undefined, FsError> =>
  Effect.tryPromise({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      codeOf(error) === "ENOENT" ? Effect.succeed(undefined) : Effect.fail(fsError(rel, error)),
    ),
  );

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Characters Windows gives a meaning to. `:` is the dangerous one: `goals.md:x.md` ends in `.md`
// and names an alternate data stream of `goals.md` on NTFS.
const FORBIDDEN_CHARS = /[\\:*?"<>|]/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

const hasControlChar = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** A workspace id becomes a folder name, so it has to be one safe path segment. */
export const validateWorkspaceId = (workspaceId: string): Effect.Effect<string, InvalidState> =>
  WORKSPACE_ID.test(workspaceId)
    ? Effect.succeed(workspaceId)
    : Effect.fail(refuse("Not a workspace id a memory folder can be named after"));

/**
 * The lexical half of confinement, as a pure function: a relative POSIX path to a `.md` file, at
 * most `MEMORY_MAX_DEPTH` deep, with no segment that is empty, dotted, reserved or able to mean
 * something to a filesystem. Returns why the path is refused, or `undefined` when it may go on to
 * the resolver.
 */
export const memoryPathProblem = (path: string): string | undefined => {
  if (path === "") return "Name a memory file, e.g. decisions.md";
  if (hasControlChar(path)) return "A memory path can't hold control characters";
  if (path.includes("\\")) return "Use forward slashes in a memory path";
  if (path.startsWith("/") || isAbsolute(path)) {
    return "A memory path is relative to the memory root, e.g. repos/gram.md";
  }
  const segments = path.split("/");
  if (segments.length > MEMORY_MAX_DEPTH) {
    return `A memory path is at most ${MEMORY_MAX_DEPTH} levels deep`;
  }
  for (const segment of segments) {
    if (segment === "") return "A memory path can't have an empty segment";
    if (segment === "..") return "A memory path can't leave the memory root";
    if (segment.startsWith(".")) {
      return segment === HISTORY_DIR
        ? "History is kept by the server and isn't a memory file"
        : "A memory path can't have a segment that starts with a dot";
    }
    if (FORBIDDEN_CHARS.test(segment)) return `A memory path can't hold ${'\\ : * ? " < > |'}`;
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      return "A memory path segment can't end in a dot or a space";
    }
    if (DEVICE_NAME.test(segment)) return `${segment} is a reserved name on Windows`;
    if (segment.length > SEGMENT_MAX_LENGTH) return "A memory path segment is too long";
  }
  const name = segments.at(-1)!;
  if (!name.endsWith(".md") || name === ".md")
    return "Memory files are Markdown: end the name in .md";
  // On a case-insensitive disk `memory.md` is the index, and would get the larger per-file cap.
  if (path.toLowerCase() === MEMORY_INDEX.toLowerCase() && path !== MEMORY_INDEX) {
    return `The index is spelled ${MEMORY_INDEX}`;
  }
  return undefined;
};

const validatePath = (path: string): Effect.Effect<string, InvalidState> => {
  const problem = memoryPathProblem(path);
  return problem === undefined ? Effect.succeed(path) : Effect.fail(refuse(problem));
};

/** Text for the diff card: at most `MEMORY_DIFF_MAX_BYTES`, cut on a character boundary. */
const capForDiff = (text: string): string => {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= MEMORY_DIFF_MAX_BYTES) return text;
  // A cut through a multi-byte character decodes to U+FFFD; drop it rather than show it.
  const head = buffer
    .subarray(0, MEMORY_DIFF_MAX_BYTES)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  return `${head}\n… [truncated: ${kb(buffer.byteLength)} in all]`;
};

/** `memory_append`: `text` on lines of its own after what the file holds, ending in a newline. */
export const appendEntry = (current: string | undefined, text: string): string => {
  const entry = text.endsWith("\n") ? text : `${text}\n`;
  if (current === undefined || current === "") return entry;
  return `${current}${current.endsWith("\n") ? "" : "\n"}${entry}`;
};

/**
 * `memory_edit`: `old` replaced by `new` in the file as it reads back, scrubbed, or why not. `old`
 * must be there, and only once unless `replaceAll`, so an edit never lands somewhere unmeant.
 */
export const editPassage = (
  current: string | undefined,
  edit: { readonly old: string; readonly new: string; readonly replaceAll?: boolean | undefined },
): string | { readonly problem: string } => {
  if (current === undefined)
    return { problem: "There is no such file; make it with memory_write." };
  const found = current.split(edit.old).length - 1;
  if (found === 0) {
    return {
      problem:
        "`old` isn't in the file. Read it again with memory_read and copy the passage exactly.",
    };
  }
  if (found > 1 && edit.replaceAll !== true) {
    return {
      problem: `\`old\` appears ${found} times. Quote more of the passage so it is unique, or pass replaceAll.`,
    };
  }
  return edit.replaceAll === true
    ? current.replaceAll(edit.old, () => edit.new)
    : current.replace(edit.old, () => edit.new);
};

// `/` can't appear in a segment and `%` is escaped first, so distinct paths never share a folder.
const historyKey = (path: string): string => path.replaceAll("%", "%25").replaceAll("/", "%2F");

const HISTORY_ENTRY = /^\d{15}\.md$/;
const historyName = (at: number): string => `${String(at).padStart(15, "0")}.md`;

const capProblem = (path: string, bytes: number): string | undefined => {
  const cap = path === MEMORY_INDEX ? MEMORY_INDEX_MAX_BYTES : MEMORY_FILE_MAX_BYTES;
  if (bytes <= cap) return undefined;
  const what = path === MEMORY_INDEX ? "the index" : "one memory file";
  return (
    `${path} would be ${kb(bytes)} (${bytes} bytes); the cap for ${what} is ${kb(cap)}. ` +
    "Consolidate it: fold old entries together or move detail to another file. " +
    "If memory as a whole has outgrown its caps, ask the user to run a dream."
  );
};

const no = (problem: string) => ({ ok: false as const, problem });

/**
 * A whole memory set against the rules a live write meets one file at a time: the path rules, the
 * per-file caps on the **scrubbed** text, the file count, and what only a set can get wrong, two
 * paths that are one file on a case-insensitive disk or a file where another path needs a folder.
 * Pure. Returns the scrubbed set, or why it is refused.
 */
export const checkMemorySet = (
  files: ReadonlyArray<MemorySetFile>,
):
  | { readonly ok: true; readonly files: ReadonlyArray<MemorySetFile> }
  | { readonly ok: false; readonly problem: string } => {
  if (files.length === 0) return no("A memory version needs at least one file");
  if (files.length > MEMORY_MAX_FILES) {
    return no(`${files.length} files; a memory version holds at most ${MEMORY_MAX_FILES}`);
  }
  const seen = new Set<string>();
  const scrubbed: Array<MemorySetFile> = [];
  for (const file of files) {
    const problem = memoryPathProblem(file.path);
    if (problem !== undefined) return no(`${JSON.stringify(file.path)}: ${problem}`);
    // APFS and NTFS fold case, and APFS folds Unicode normalisation forms too.
    const key = file.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) return no(`${file.path} is in the set twice`);
    seen.add(key);
    const content = redactText(file.content);
    const bytes = Buffer.byteLength(content, "utf8");
    const cap = file.path === MEMORY_INDEX ? MEMORY_INDEX_MAX_BYTES : MEMORY_FILE_MAX_BYTES;
    if (bytes > cap) return no(`${file.path} is ${kb(bytes)}; the cap is ${kb(cap)}`);
    scrubbed.push({ path: file.path, content });
  }
  for (const key of seen) {
    const segments = key.split("/");
    for (let i = 1; i < segments.length; i++) {
      const folder = segments.slice(0, i).join("/");
      if (seen.has(folder)) return no(`${folder} can't be both a file and a folder`);
    }
  }
  return { ok: true, files: scrubbed };
};

const versionMissing = (version: string) =>
  new NotFound({ entity: "file", id: version, message: `No memory version ${version} is kept` });

const versionRel = (version: string): string => `versions/${version}`;

/** Where a path in a workspace's tree leads, once the resolver has let it through. */
export interface Resolved {
  readonly abs: string;
  readonly kind: "file" | "dir" | "missing";
  readonly stats?: Pick<Stats, "size" | "mtimeMs" | "birthtimeMs"> | undefined;
}

/** One entry of a folder in a workspace's tree. */
export interface TreeEntry {
  readonly name: string;
  readonly kind: "file" | "dir" | "other";
}

/**
 * The confined filesystem operations on the trees under one root. `rel` is always a POSIX path
 * below the workspace folder, and `within` the part of the tree the target has to stay inside.
 * Memory and a dream's folder (`dream-files.ts`) share this one door, so they refuse the same
 * things.
 */
export interface ConfinedTree {
  resolveInTree(
    workspaceId: string,
    rel: string,
    within: string,
  ): Effect.Effect<Resolved, InvalidState | FsError>;
  /** Creates the folder and any missing parents, and returns its absolute path. */
  ensureDir(
    workspaceId: string,
    rel: string,
    within: string,
  ): Effect.Effect<string, InvalidState | FsError>;
  /** Temp file beside the target, then rename: a crash leaves the old file or the new, never half. */
  writeAtomic(
    workspaceId: string,
    rel: string,
    within: string,
    content: string,
    mode?: number,
  ): Effect.Effect<void, InvalidState | FsError>;
  /**
   * A regular file's text; `shown` is the name errors use for it. A file past `maxBytes`
   * (`MEMORY_READ_MAX_BYTES` unless given) is refused rather than read.
   */
  readText(
    workspaceId: string,
    rel: string,
    within: string,
    shown: string,
    maxBytes?: number,
  ): Effect.Effect<string, MemoryError>;
  /** Hash and length of the bounded original bytes, before decoding or redaction. */
  fingerprint(
    workspaceId: string,
    rel: string,
    within: string,
    shown: string,
    maxBytes?: number,
  ): Effect.Effect<{ readonly sha256: string; readonly bytes: number }, MemoryError>;
  /**
   * What a folder holds, by name, or `undefined` when it isn't there. `other` is anything that is
   * neither a regular file nor a folder, a symlink included, since nothing here follows one.
   */
  listDir(
    workspaceId: string,
    rel: string,
    within: string,
  ): Effect.Effect<ReadonlyArray<TreeEntry> | undefined, InvalidState | FsError>;
  /** Deletes one regular file; one that isn't there is already deleted. */
  removeFile(
    workspaceId: string,
    rel: string,
    within: string,
  ): Effect.Effect<void, InvalidState | FsError>;
  /**
   * Removes a folder and everything below it, without following a link: a symlink inside is
   * unlinked, never entered. A folder that isn't there is already removed.
   */
  removeTree(
    workspaceId: string,
    rel: string,
    within: string,
  ): Effect.Effect<void, InvalidState | FsError>;
}

/** The refusal of `at` (`""` for the workspace folder) for being a symlink or a special file. */
const notPlain = (at: string) =>
  refuse(
    `${at === "" ? "The memory folder" : at} is a symlink or a special file. ` +
      "Memory holds regular files and folders only, so nothing was read or written.",
  );

/** Strong directory-fd operations when requested; otherwise the memory path resolver. */
export const confinedTree = (
  root: string,
  options?: AnchoredOptions & { readonly anchored: true },
): ConfinedTree => {
  if (options?.anchored) return anchoredTree(root, options);
  /**
   * The one resolver. `rel` is a POSIX path below the workspace folder (`""` is the folder itself)
   * and `within` the part of the tree the target has to stay inside. In order: lexical
   * containment; an `lstat` of the workspace folder and of every existing segment below it, which
   * refuses anything that isn't a regular file or a directory; then `realpath` of the target's
   * nearest existing parent against `realpath` of `within`. The walk stops at the workspace folder
   * because the data dir above it may legitimately sit behind a symlink (`/tmp` on macOS).
   */
  const resolveInTree = (
    workspaceId: string,
    rel: string,
    within: string,
  ): Effect.Effect<Resolved, InvalidState | FsError> =>
    Effect.gen(function* () {
      const wsRoot = join(root, workspaceId);
      const segments = rel === "" ? [] : rel.split("/");
      if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes(sep))) {
        return yield* refuse(`${rel} is not a path inside memory`);
      }
      const abs = join(wsRoot, ...segments);
      const withinAbs = join(wsRoot, ...(within === "" ? [] : within.split("/")));
      if (!isInside(wsRoot, withinAbs) || !isInside(withinAbs, abs)) {
        return yield* refuse(`${rel} is outside memory`);
      }
      let current = wsRoot;
      let parent = wsRoot;
      let stats = yield* attemptExisting("", () => lstat(wsRoot));
      if (stats === undefined) return { abs, kind: "missing" };
      if (!stats.isDirectory()) return yield* notPlain("");
      for (const [i, segment] of segments.entries()) {
        const at = segments.slice(0, i + 1).join("/");
        parent = current;
        current = join(current, segment);
        stats = yield* attemptExisting(at, () => lstat(current));
        if (stats === undefined) break;
        const last = i === segments.length - 1;
        if (stats.isSymbolicLink() || !(stats.isDirectory() || stats.isFile())) {
          return yield* notPlain(at);
        }
        if (!last && !stats.isDirectory()) return yield* refuse(`${at} is a file, not a folder`);
      }

      if (segments.length > 0) {
        // Before `within` exists (the first `init`) the nearest existing parent is above it, and
        // the workspace folder is what it has to be inside.
        const bound = isInside(withinAbs, parent) ? withinAbs : wsRoot;
        const realParent = yield* attempt(rel, () => realPath(parent));
        const realBound = yield* attempt(within, () => realPath(bound));
        if (!isInside(realBound, realParent)) return yield* refuse(`${rel} is outside memory`);
      }
      if (stats === undefined) return { abs, kind: "missing" };
      return { abs, kind: stats.isDirectory() ? "dir" : "file", stats };
    });

  const ensureDir = (
    workspaceId: string,
    rel: string,
    within: string,
  ): Effect.Effect<string, InvalidState | FsError> =>
    Effect.gen(function* () {
      const before = yield* resolveInTree(workspaceId, rel, within);
      if (before.kind === "dir") return before.abs;
      if (before.kind === "file") return yield* refuse(`${rel} is a file, not a folder`);
      yield* attempt(rel, () => mkdir(before.abs, { recursive: true }));
      // A recursive mkdir follows a symlink swapped in since the walk; resolving again refuses to
      // go on to write through it.
      const after = yield* resolveInTree(workspaceId, rel, within);
      if (after.kind !== "dir") return yield* refuse(`${rel} is not a folder`);
      return after.abs;
    });

  /** Temp file beside the target, then rename: a crash leaves the old file or the new, never half. */
  const writeAtomic = (
    workspaceId: string,
    rel: string,
    within: string,
    content: string,
    mode = 0o600,
  ): Effect.Effect<void, InvalidState | FsError> =>
    Effect.gen(function* () {
      const slash = rel.lastIndexOf("/");
      const dir = yield* ensureDir(workspaceId, slash === -1 ? "" : rel.slice(0, slash), within);
      const target = yield* resolveInTree(workspaceId, rel, within);
      if (target.kind === "dir") return yield* refuse(`${rel} is a folder`);
      const temp = join(dir, `.tmp-${randomUUID()}`);
      yield* attempt(rel, async () => {
        try {
          // `wx` refuses an existing name, symlink included, so the temp file is ours.
          await writeFile(temp, content, { encoding: "utf8", flag: "wx", mode });
          await rename(temp, target.abs);
        } catch (error) {
          await unlink(temp).catch(() => undefined);
          throw error;
        }
      });
    });

  const readBytes = (
    workspaceId: string,
    rel: string,
    within: string,
    shown: string,
    maxBytes = MEMORY_READ_MAX_BYTES,
  ): Effect.Effect<Buffer, MemoryError> =>
    Effect.gen(function* () {
      const target = yield* resolveInTree(workspaceId, rel, within);
      if (target.kind === "missing") {
        return yield* new NotFound({
          entity: "file",
          id: shown,
          message: `No memory file ${shown}`,
        });
      }
      if (target.kind === "dir") return yield* refuse(`${shown} is a folder`);
      if ((target.stats?.size ?? 0) > maxBytes) {
        return yield* refuse(
          `${shown} is ${kb(target.stats?.size ?? 0)}, past the ${kb(maxBytes)} it is read at`,
        );
      }
      return yield* attempt(shown, async () => {
        // Protect the final component and bound the opened file. This path branch does not
        // anchor ancestors; Dream and adoption explicitly request the stronger implementation.
        const handle = await open(target.abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const checked = await handle.stat();
          if (!checked.isFile() || checked.nlink !== 1)
            throw new Error("not a singly linked regular file");
          if (checked.size > maxBytes) throw new Error("file exceeds read cap");
          const bytes = Buffer.alloc(maxBytes + 1);
          let length = 0;
          while (length < bytes.length) {
            const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
            if (bytesRead === 0) break;
            length += bytesRead;
          }
          const after = await handle.stat();
          if (length > maxBytes || after.size > maxBytes || after.nlink !== 1)
            throw new Error("file exceeds read cap or link count changed");
          return bytes.subarray(0, length);
        } finally {
          await handle.close();
        }
      });
    });

  const readText: ConfinedTree["readText"] = (...args) =>
    readBytes(...args).pipe(Effect.map((bytes) => bytes.toString("utf8")));

  const fingerprint: ConfinedTree["fingerprint"] = (...args) =>
    readBytes(...args).pipe(
      Effect.map((bytes) => ({
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      })),
    );

  const removeTree = (
    workspaceId: string,
    rel: string,
    within: string,
  ): Effect.Effect<void, InvalidState | FsError> =>
    Effect.gen(function* () {
      if (rel === "" || rel === within) return yield* refuse("Refusing to remove a whole tree");
      const dir = yield* resolveInTree(workspaceId, rel, within);
      if (dir.kind === "missing") return;
      if (dir.kind !== "dir") return yield* refuse(`${rel} is a file, not a folder`);
      const entries = yield* attempt(rel, () => readdir(dir.abs, { withFileTypes: true }));
      for (const entry of entries) {
        // Dirents don't follow links: a symlink to a folder is not a directory here, so it is
        // unlinked below and what it points at is left alone.
        if (entry.isDirectory()) {
          yield* removeTree(workspaceId, `${rel}/${entry.name}`, within);
        } else {
          const target = join(dir.abs, entry.name);
          yield* attempt(rel, async () => {
            try {
              await unlink(target);
            } catch (error) {
              // Windows won't delete a read-only file, which is what a dream's inputs are.
              if (codeOf(error) !== "EPERM" && codeOf(error) !== "EACCES") throw error;
              await chmod(target, 0o600);
              await unlink(target);
            }
          });
        }
      }
      yield* attempt(rel, () => rmdir(dir.abs));
    });

  const listDir = (
    workspaceId: string,
    rel: string,
    within: string,
  ): Effect.Effect<ReadonlyArray<TreeEntry> | undefined, InvalidState | FsError> =>
    Effect.gen(function* () {
      const dir = yield* resolveInTree(workspaceId, rel, within);
      if (dir.kind === "missing") return undefined;
      if (dir.kind !== "dir") return yield* refuse(`${rel} is a file, not a folder`);
      const entries = yield* attempt(rel, () => readdir(dir.abs, { withFileTypes: true }));
      return entries
        .map((entry): TreeEntry => ({
          name: entry.name,
          kind: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
        }))
        .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    });

  const removeFile = (
    workspaceId: string,
    rel: string,
    within: string,
  ): Effect.Effect<void, InvalidState | FsError> =>
    Effect.gen(function* () {
      const target = yield* resolveInTree(workspaceId, rel, within);
      if (target.kind === "missing") return;
      if (target.kind !== "file") return yield* refuse(`${rel} is a folder`);
      yield* attempt(rel, () => unlink(target.abs));
    });

  return {
    resolveInTree,
    ensureDir,
    writeAtomic,
    readText,
    fingerprint,
    removeTree,
    listDir,
    removeFile,
  };
};

/** Runs `run` once the workspace id, and `path` when given, are ones memory accepts. */
const guarded = <A, E = never>(
  workspaceId: string,
  path: string | undefined,
  run: () => Effect.Effect<A, MemoryError | E>,
): Effect.Effect<A, MemoryError | E> =>
  Effect.gen(function* () {
    yield* validateWorkspaceId(workspaceId);
    if (path !== undefined) yield* validatePath(path);
    return yield* run();
  });

const make = (root: string): OrchestrationMemoryShape => {
  const locks = makeKeyedLock<string>();
  const locked = <A, E>(workspaceId: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    locks.withLock(workspaceId, effect);

  const ordinaryTree = confinedTree(root);
  const adoptionTree = confinedTree(root, { anchored: true });
  const { resolveInTree, ensureDir, writeAtomic, readText } = ordinaryTree;

  /** `undefined` before `init`. A `CURRENT` that is a symlink, or names no version, is refused. */
  const adopted = (
    workspaceId: string,
    tree = ordinaryTree,
  ): Effect.Effect<string | undefined, MemoryError> =>
    Effect.gen(function* () {
      const pointer = yield* tree.resolveInTree(workspaceId, "CURRENT", "");
      if (pointer.kind === "missing") return undefined;
      const version = (yield* tree.readText(workspaceId, "CURRENT", "", "CURRENT")).trim();
      if (!VERSION.test(version)) return yield* refuse("CURRENT doesn't name a memory version");
      return version;
    });

  const requireAdopted = (workspaceId: string) =>
    Effect.flatMap(adopted(workspaceId), (version) =>
      version === undefined
        ? Effect.fail(refuse("This workspace has no memory yet"))
        : Effect.succeed(version),
    );

  const initLocked = (workspaceId: string): Effect.Effect<string, MemoryError> =>
    Effect.gen(function* () {
      const existing = yield* adopted(workspaceId);
      if (existing !== undefined) {
        const dir = yield* resolveInTree(workspaceId, versionRel(existing), "");
        if (dir.kind !== "dir") {
          return yield* refuse(`CURRENT names memory version ${existing}, which isn't there`);
        }
        return existing;
      }
      yield* attempt("", () => mkdir(root, { recursive: true }));
      const versionsDir = yield* ensureDir(workspaceId, "versions", "");
      // A lost `CURRENT` must not hide versions a dream adopted: take up the newest again.
      const found = (yield* attempt("versions", () =>
        readdir(versionsDir, { withFileTypes: true }),
      ))
        .filter((entry) => entry.isDirectory() && VERSION.test(entry.name))
        .map((entry) => entry.name)
        .toSorted();
      const version = found.at(-1) ?? FIRST_VERSION;
      const within = versionRel(version);
      yield* ensureDir(workspaceId, within, "");
      const indexRel = `${within}/${MEMORY_INDEX}`;
      if ((yield* resolveInTree(workspaceId, indexRel, within)).kind === "missing") {
        yield* writeAtomic(workspaceId, indexRel, within, MEMORY_INDEX_TEMPLATE);
      }
      // Last, so a crash before here leaves a tree the next `init` finishes.
      yield* writeAtomic(workspaceId, "CURRENT", "", `${version}\n`);
      return version;
    });

  const listVersion = (workspaceId: string, version: string) =>
    Effect.gen(function* () {
      const within = versionRel(version);
      const files: Array<MemoryFile> = [];
      const walk = (relDir: string, depth: number): Effect.Effect<void, MemoryError> =>
        Effect.gen(function* () {
          const treeRel = relDir === "" ? within : `${within}/${relDir}`;
          const dir = yield* resolveInTree(workspaceId, treeRel, relDir === "" ? "" : within);
          if (dir.kind !== "dir") return;
          const entries = yield* attempt(treeRel, () => readdir(dir.abs, { withFileTypes: true }));
          for (const entry of entries) {
            const path = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
            // Dirents don't follow links, so a symlink is neither: it is skipped, never entered.
            if (entry.isDirectory()) {
              if (!entry.name.startsWith(".") && depth < MEMORY_MAX_DEPTH) {
                yield* walk(path, depth + 1);
              }
            } else if (entry.isFile() && memoryPathProblem(path) === undefined) {
              const file = yield* resolveInTree(workspaceId, `${within}/${path}`, within);
              if (file.kind === "file" && file.stats !== undefined) {
                files.push({
                  path,
                  bytes: file.stats.size,
                  modifiedAt: Math.round(file.stats.mtimeMs),
                });
              }
            }
          }
        });
      yield* walk("", 1);
      return files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    });

  /** Copies `text` into the file's history and drops what is older than the newest twenty. */
  const archive = (workspaceId: string, version: string, path: string, text: string) =>
    Effect.gen(function* () {
      const within = versionRel(version);
      const dirRel = `${within}/${HISTORY_DIR}/${historyKey(path)}`;
      const dir = yield* ensureDir(workspaceId, dirRel, within);
      const entries = (yield* attempt(dirRel, () => readdir(dir)))
        .filter((name) => HISTORY_ENTRY.test(name))
        .toSorted();
      const newest = entries.at(-1);
      const now = yield* Clock.currentTimeMillis;
      // Two writes in one millisecond, or a clock that stepped back, still get their own entry.
      const at = Math.max(now, newest === undefined ? 0 : Number.parseInt(newest, 10) + 1);
      const name = historyName(at);
      yield* writeAtomic(workspaceId, `${dirRel}/${name}`, within, redactText(text));
      const stale = [...entries, name].slice(0, -MEMORY_HISTORY_KEEP);
      for (const old of stale) {
        const target = yield* resolveInTree(workspaceId, `${dirRel}/${old}`, within);
        if (target.kind === "file") yield* attempt(dirRel, () => unlink(target.abs));
      }
    });

  /** The version folders there are, oldest first. */
  const versionNames = (workspaceId: string, tree = ordinaryTree) =>
    Effect.gen(function* () {
      return ((yield* tree.listDir(workspaceId, "versions", "")) ?? [])
        .filter((entry) => entry.kind === "dir" && VERSION.test(entry.name))
        .map((entry) => entry.name)
        .toSorted();
    });

  const adoptedAtOf = (workspaceId: string, version: string) =>
    Effect.gen(function* () {
      const within = versionRel(version);
      const rel = `${within}/${ADOPTED_FILE}`;
      const note = yield* resolveInTree(workspaceId, rel, within);
      if (note.kind === "file") {
        const text = yield* readText(workspaceId, rel, within, ADOPTED_FILE);
        try {
          const at: unknown = (JSON.parse(text) as { adoptedAt?: unknown }).adoptedAt;
          if (typeof at === "number" && Number.isFinite(at)) return at;
        } catch {
          // Hand-edited into something else; the folder's own age is the next best answer.
        }
      }
      const dir = yield* resolveInTree(workspaceId, within, "");
      return Math.round(dir.stats?.birthtimeMs || dir.stats?.mtimeMs || 0);
    });

  const requireVersion = (workspaceId: string, version: string) =>
    Effect.gen(function* () {
      if (!VERSION.test(version))
        return yield* refuse("A memory version is four digits, e.g. 0007");
      const dir = yield* resolveInTree(workspaceId, versionRel(version), "");
      if (dir.kind !== "dir") return yield* versionMissing(version);
      return version;
    });

  /** Everything but the current version and the newest `MEMORY_VERSIONS_KEEP` others goes. */
  const prune = (workspaceId: string, current: string, tree = ordinaryTree) =>
    Effect.gen(function* () {
      const others = (yield* versionNames(workspaceId, tree)).filter((name) => name !== current);
      for (const stale of others.slice(0, Math.max(0, others.length - MEMORY_VERSIONS_KEEP))) {
        yield* tree.removeTree(workspaceId, versionRel(stale), "versions");
      }
    });

  const adoptLocked = (
    workspaceId: string,
    files: ReadonlyArray<MemorySetFile>,
    basedOn: string | undefined,
    basedOnDigest: string | undefined,
  ): Effect.Effect<string, MemoryError> =>
    Effect.gen(function* () {
      // Adoption copies candidate text into a NEW live version. Its reads, writes, CURRENT
      // switch and cleanup must use the same anchored boundary as candidate collection.
      const { ensureDir: ensureAdoptionDir, writeAtomic: writeAdoption, removeTree } = adoptionTree;
      const current = yield* adopted(workspaceId, adoptionTree);
      if (basedOn !== undefined && basedOn !== (current ?? "")) {
        return yield* refuse(
          `Memory is at version ${current ?? "none"}, not the ${basedOn === "" ? "empty memory" : basedOn} this was based on. ` +
            "Another version was adopted or restored in between; review against the current one.",
        );
      }
      // Live writes keep CURRENT's version, so version alone cannot fence an awaited adoption.
      // All Gram writers share this lock. Hand edits and other processes do not (see verification).
      if (basedOnDigest !== undefined) {
        const live: Record<string, { sha256: string; bytes: number }> = {};
        if (current !== undefined) {
          const within = versionRel(current);
          const visit = (dir: string, depth: number): Effect.Effect<void, MemoryError> =>
            Effect.gen(function* () {
              for (const entry of (yield* adoptionTree.listDir(
                workspaceId,
                dir === "" ? within : `${within}/${dir}`,
                within,
              )) ?? []) {
                if (entry.name.startsWith(".")) continue;
                const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
                if (entry.kind === "dir" && depth < MEMORY_MAX_DEPTH) yield* visit(path, depth + 1);
                else if (entry.kind === "file" && memoryPathProblem(path) === undefined) {
                  live[path] = yield* adoptionTree.fingerprint(
                    workspaceId,
                    `${within}/${path}`,
                    within,
                    path,
                  );
                } else
                  return yield* refuse("Memory contains an invalid entry; adoption was refused.");
              }
            });
          yield* visit("", 1);
        }
        if (memorySnapshotDigest({ version: current ?? "", files: live }) !== basedOnDigest) {
          return yield* refuse(
            "Memory files changed before adoption could commit. Nothing was adopted; review against the current memory.",
          );
        }
      }
      yield* ensureAdoptionDir(workspaceId, "versions", "");
      const newest = [...(yield* versionNames(workspaceId, adoptionTree)), current ?? "0000"]
        .toSorted()
        .at(-1)!;
      const number = Number.parseInt(newest, 10) + 1;
      if (number > 9999) return yield* refuse("This workspace has run out of memory versions");
      const version = String(number).padStart(4, "0");
      const within = versionRel(version);
      const now = yield* Clock.currentTimeMillis;
      const writeAll = Effect.gen(function* () {
        yield* ensureAdoptionDir(workspaceId, within, "versions");
        for (const file of files) {
          yield* writeAdoption(workspaceId, `${within}/${file.path}`, within, file.content);
        }
        const note = { adoptedAt: now, ...(current === undefined ? {} : { basedOn: current }) };
        yield* writeAdoption(
          workspaceId,
          `${within}/${ADOPTED_FILE}`,
          within,
          JSON.stringify(note),
        );
      });
      // Until `CURRENT` moves nothing reads this folder, so a failure or an interrupt only has to
      // take it away again for the tree to be as it was.
      yield* writeAll.pipe(
        Effect.onError(() => Effect.ignore(removeTree(workspaceId, within, "versions"))),
      );
      yield* writeAdoption(workspaceId, "CURRENT", "", `${version}\n`);
      // The adoption has happened; a version that won't delete is left for the next one to prune.
      yield* prune(workspaceId, version, adoptionTree).pipe(
        Effect.catch((error) =>
          Effect.logWarning("orchestration memory: pruning old versions failed", error.message),
        ),
      );
      return version;
    });

  /** `write`, for a caller that holds the workspace's lock. */
  const writeLocked = (
    workspaceId: string,
    path: string,
    content: string,
  ): Effect.Effect<MemoryWrite, MemoryError> =>
    Effect.gen(function* () {
      const after = redactText(content);
      const bytes = Buffer.byteLength(after, "utf8");
      const tooBig = capProblem(path, bytes);
      if (tooBig !== undefined) return yield* refuse(tooBig);

      const version = yield* initLocked(workspaceId);
      const within = versionRel(version);
      const rel = `${within}/${path}`;
      const target = yield* resolveInTree(workspaceId, rel, within);
      if (target.kind === "dir") return yield* refuse(`${path} is a folder`);
      if (target.kind === "missing") {
        const count = (yield* listVersion(workspaceId, version)).length;
        if (count >= MEMORY_MAX_FILES) {
          return yield* refuse(
            `Memory already holds ${count} files; the cap is ${MEMORY_MAX_FILES}. ` +
              "Consolidate: fold a file into another and delete it, or ask the user to run a dream.",
          );
        }
      }
      const before =
        target.kind === "file" ? yield* readText(workspaceId, rel, within, path) : undefined;
      if (before !== after) {
        if (before !== undefined) yield* archive(workspaceId, version, path, before);
        yield* writeAtomic(workspaceId, rel, within, after);
      }
      return {
        path,
        action: "write" as const,
        ...(before === undefined ? {} : { before: capForDiff(redactText(before)) }),
        after: capForDiff(after),
        bytes,
      };
    });

  return {
    init: (workspaceId) =>
      guarded(workspaceId, undefined, () =>
        locked(workspaceId, Effect.asVoid(initLocked(workspaceId))),
      ),

    list: (workspaceId) =>
      guarded(workspaceId, undefined, () =>
        Effect.flatMap(adopted(workspaceId), (version) =>
          version === undefined ? Effect.succeed([]) : listVersion(workspaceId, version),
        ),
      ),

    read: (workspaceId, path) =>
      guarded(workspaceId, path, () =>
        Effect.gen(function* () {
          const version = yield* adopted(workspaceId);
          if (version === undefined) {
            return yield* new NotFound({
              entity: "file",
              id: path,
              message: `No memory file ${path}`,
            });
          }
          const within = versionRel(version);
          return redactText(yield* readText(workspaceId, `${within}/${path}`, within, path));
        }),
      ),

    index: (workspaceId) =>
      guarded(workspaceId, undefined, () =>
        Effect.gen(function* () {
          const version = yield* adopted(workspaceId);
          if (version === undefined) return "";
          const within = versionRel(version);
          return yield* readText(
            workspaceId,
            `${within}/${MEMORY_INDEX}`,
            within,
            MEMORY_INDEX,
          ).pipe(
            Effect.map(redactText),
            Effect.catchTag("NotFound", () => Effect.succeed("")),
          );
        }),
      ),

    write: (workspaceId, path, content) =>
      guarded(workspaceId, path, () =>
        locked(workspaceId, writeLocked(workspaceId, path, content)),
      ),

    modify: (workspaceId, path, change) =>
      guarded(workspaceId, path, () =>
        locked(
          workspaceId,
          Effect.gen(function* () {
            const version = yield* initLocked(workspaceId);
            const within = versionRel(version);
            const rel = `${within}/${path}`;
            const target = yield* resolveInTree(workspaceId, rel, within);
            const current =
              target.kind === "file"
                ? redactText(yield* readText(workspaceId, rel, within, path))
                : undefined;
            const { content, result } = yield* change(current);
            return { write: yield* writeLocked(workspaceId, path, content), result };
          }),
        ),
      ),

    remove: (workspaceId, path) =>
      guarded(workspaceId, path, () =>
        locked(
          workspaceId,
          Effect.gen(function* () {
            const version = yield* requireAdopted(workspaceId);
            const within = versionRel(version);
            const rel = `${within}/${path}`;
            const before = yield* readText(workspaceId, rel, within, path);
            yield* archive(workspaceId, version, path, before);
            const target = yield* resolveInTree(workspaceId, rel, within);
            if (target.kind === "file") yield* attempt(path, () => unlink(target.abs));
            return {
              path,
              action: "delete" as const,
              before: capForDiff(redactText(before)),
              bytes: 0,
            };
          }),
        ),
      ),

    currentVersion: (workspaceId) =>
      guarded(workspaceId, undefined, () => requireAdopted(workspaceId)),

    root: (workspaceId) =>
      guarded(workspaceId, undefined, () =>
        Effect.gen(function* () {
          const version = yield* requireAdopted(workspaceId);
          const dir = yield* resolveInTree(workspaceId, versionRel(version), "");
          if (dir.kind !== "dir") {
            return yield* refuse(`CURRENT names memory version ${version}, which isn't there`);
          }
          return dir.abs;
        }),
      ),

    versions: (workspaceId) =>
      guarded(workspaceId, undefined, () =>
        Effect.gen(function* () {
          const current = yield* adopted(workspaceId);
          const out: Array<MemoryVersion> = [];
          for (const version of yield* versionNames(workspaceId)) {
            out.push({
              version,
              adoptedAt: yield* adoptedAtOf(workspaceId, version),
              files: (yield* listVersion(workspaceId, version)).length,
              current: version === current,
            });
          }
          return out;
        }),
      ),

    readVersion: (workspaceId, version, path) =>
      guarded(workspaceId, path, () =>
        Effect.gen(function* () {
          const within = versionRel(yield* requireVersion(workspaceId, version));
          return redactText(yield* readText(workspaceId, `${within}/${path}`, within, path));
        }),
      ),

    snapshot: (workspaceId) =>
      guarded(workspaceId, undefined, () =>
        Effect.gen(function* () {
          const version = yield* adopted(workspaceId);
          if (version === undefined) return { version: "", files: {} };
          const within = versionRel(version);
          const files: Record<string, { sha256: string; bytes: number }> = {};
          for (const file of yield* listVersion(workspaceId, version)) {
            files[file.path] = yield* ordinaryTree.fingerprint(
              workspaceId,
              `${within}/${file.path}`,
              within,
              file.path,
            );
          }
          return { version, files };
        }),
      ),

    adopt: (workspaceId, files, options) =>
      guarded(workspaceId, undefined, () =>
        Effect.gen(function* () {
          // Before the lock and before any I/O: a refused set must not have touched the tree.
          const checked = checkMemorySet(files);
          if (!checked.ok) return yield* refuse(checked.problem);
          return yield* locked(
            workspaceId,
            adoptLocked(workspaceId, checked.files, options?.basedOn, options?.basedOnDigest),
          );
        }),
      ),

    restore: (workspaceId, version) =>
      guarded(workspaceId, undefined, () =>
        locked(
          workspaceId,
          Effect.gen(function* () {
            yield* requireVersion(workspaceId, version);
            yield* writeAtomic(workspaceId, "CURRENT", "", `${version}\n`);
          }),
        ),
      ),
  };
};

/** The orchestrator's memory, one tree per workspace under the data dir. */
export class OrchestrationMemory extends Context.Service<
  OrchestrationMemory,
  OrchestrationMemoryShape
>()("@gram/server/OrchestrationMemory") {
  /** Memory under `root`, the folder that holds one folder per workspace. */
  static readonly layerAt = (root: string): Layer.Layer<OrchestrationMemory> =>
    Layer.sync(OrchestrationMemory, () => make(root));

  /** Memory under `<dataDir>/orchestration`. */
  static readonly layer: Layer.Layer<OrchestrationMemory, never, ServerConfig> = Layer.effect(
    OrchestrationMemory,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return make(join(config.dataDir, "orchestration"));
    }),
  );
}
