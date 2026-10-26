// The `git diff` parser shared by the diff panel, PR detail and checkpoints, and the working-tree diff:
// tracked changes, synthetic all-added diffs for untracked files, and the clean-tree branch-vs-base
// fallback.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import { openInside } from "./contained.ts";
import type { ProcError } from "./errors.ts";
import { branchExists, git, tryRepoTop } from "./exec.ts";
import { isInside, realPathSync } from "./paths.ts";
import { MAX_OUTPUT_BYTES, type Proc } from "./proc.ts";
import { localBaseRef } from "./refs.ts";

export const MAX_VIEW_BYTES = MAX_OUTPUT_BYTES;
export const DIFF_TOO_LARGE_NOTE = "Diff too large to display";

export type DiffFileStatus = "modified" | "new" | "deleted" | "renamed";

export interface DiffFile {
  readonly path: string;
  readonly status: DiffFileStatus;
  readonly added: number;
  readonly removed: number;
  /** From the first `@@` hunk onward. */
  readonly diff: string;
  /** Untracked specials only; `diff` is empty then. */
  readonly note?: "too large" | "binary";
}

export interface DiffResponse {
  /** False: not a repo; every other field is absent. */
  readonly repo: boolean;
  readonly branch?: string;
  readonly files?: ReadonlyArray<DiffFile>;
  /** The checkout that was diffed. */
  readonly worktree?: string;
  /** Labels the branch-vs-base fallback diff. */
  readonly base?: string;
  /** Set when a body over the view cap was dropped. */
  readonly note?: string;
}

interface Building {
  path: string;
  status: DiffFileStatus;
  added: number;
  removed: number;
  diff: string;
}

const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * The C-quoted path git writes for a name with a quote, backslash or control character (and, under
 * `core.quotepath`, non-ASCII), from the opening `"` at `start`: its exact bytes decoded as UTF-8,
 * and the index after the closing `"`. `undefined` when it isn't a well-formed quoted path.
 */
const quotedPath = (
  text: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined => {
  if (text[start] !== '"') return undefined;
  const bytes: Array<number> = [];
  for (let i = start + 1; i < text.length;) {
    const char = text[i] ?? "";
    if (char === '"') return { value: Buffer.from(bytes).toString("utf8"), end: i + 1 };
    if (char !== "\\") {
      const point = text.codePointAt(i) ?? 0;
      const literal = String.fromCodePoint(point);
      bytes.push(...Buffer.from(literal, "utf8"));
      i += literal.length;
      continue;
    }
    const next = text[i + 1] ?? "";
    const octal = /^[0-3][0-7]{2}/.exec(text.slice(i + 1, i + 4))?.[0];
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8));
      i += 4;
    } else if (C_ESCAPES[next] !== undefined) {
      bytes.push(C_ESCAPES[next]);
      i += 2;
    } else return undefined;
  }
  return undefined;
};

/** A header path as git wrote it: C-quoted when it had to be, else verbatim. */
export const unquoteGitPath = (text: string): string => {
  const quoted = quotedPath(text, 0);
  return quoted !== undefined && quoted.end === text.length ? quoted.value : text;
};

/** `prefix` stripped from a header path, or `undefined` when it lacks it. */
const unprefixed = (path: string | undefined, prefix: "a/" | "b/") =>
  path?.startsWith(prefix) ? path.slice(prefix.length) : undefined;

/**
 * The post-image path of a `diff --git <a> <b>` line. Either side may be quoted. Unquoted, a name can
 * hold ` b/`, so an unrenamed file's two equal halves are split in the middle; a rename's paths come
 * from its `rename to` line instead.
 */
const gitLinePath = (rest: string): string | undefined => {
  if (rest.startsWith('"')) {
    const a = quotedPath(rest, 0);
    if (a === undefined || rest[a.end] !== " ") return undefined;
    return unprefixed(unquoteGitPath(rest.slice(a.end + 1)), "b/");
  }
  if (rest.endsWith('"')) {
    for (let i = rest.lastIndexOf(' "'); i >= 0; i = rest.lastIndexOf(' "', i - 1)) {
      const b = quotedPath(rest, i + 1);
      if (b !== undefined && b.end === rest.length) return unprefixed(b.value, "b/");
      if (i === 0) break;
    }
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    const a = unprefixed(rest.slice(0, half), "a/");
    const b = unprefixed(rest.slice(half + 1), "b/");
    if (a !== undefined && a === b) return b;
  }
  const idx = rest.indexOf(" b/");
  return idx >= 0 ? rest.slice(idx + 3) : undefined;
};

/**
 * A `--- a/…` or `+++ b/…` header's path; `undefined` for `/dev/null`. Git ends an unquoted name
 * holding a space with a tab (an unquoted name never holds one itself, since a tab gets quoted).
 */
const sidePath = (value: string, prefix: "a/" | "b/"): string | undefined => {
  if (value === "/dev/null") return undefined;
  if (value.startsWith('"')) return unprefixed(quotedPath(value, 0)?.value, prefix);
  return unprefixed(value.endsWith("\t") ? value.slice(0, -1) : value, prefix);
};

/**
 * Parse unified `git diff` output per file. The path comes from the header's `+++ b/`, `--- a/`
 * (a deletion) or `rename to` line, unquoting git's C-quoted names and dropping the tab git appends
 * to a name with a space; else from the `diff --git` line. Never from a `+++` line inside a hunk
 * body. Callers pass `-c diff.mnemonicPrefix=false`: that user setting rewrites `a/` and `b/`, and
 * this parser then drops every tracked file.
 */
export const parseGitDiff = (text: string): Array<DiffFile> => {
  const files: Array<DiffFile> = [];
  let current: Building | undefined;
  let inHunk = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const path = gitLinePath(line.slice("diff --git ".length));
      current =
        path === undefined
          ? undefined
          : { path, status: "modified", added: 0, removed: 0, diff: "" };
      inHunk = false;
      continue;
    }
    if (!current) continue;
    if (!inHunk) {
      if (line.startsWith("new file mode")) current.status = "new";
      else if (line.startsWith("deleted file mode")) current.status = "deleted";
      else if (line.startsWith("rename to ")) {
        current.status = "renamed";
        current.path = unquoteGitPath(line.slice("rename to ".length));
      } else if (line.startsWith("+++ ")) {
        current.path = sidePath(line.slice(4), "b/") ?? current.path;
      } else if (line.startsWith("--- ") && current.status === "deleted") {
        current.path = sidePath(line.slice(4), "a/") ?? current.path;
      }
    }
    if (line.startsWith("@@")) inHunk = true;
    else if (inHunk) {
      if (line.startsWith("+")) current.added += 1;
      else if (line.startsWith("-")) current.removed += 1;
    }
    if (inHunk) current.diff += `${line}\n`;
  }
  if (current) files.push(current);
  return files;
};

/** `parseGitDiff` behind the view cap: an over-cap body is dropped with the shared note. */
export const parseGitDiffCapped = (
  text: string,
  truncated = false,
): { readonly files: Array<DiffFile>; readonly note: string | undefined } =>
  truncated || Buffer.byteLength(text) > MAX_VIEW_BYTES
    ? { files: [], note: DIFF_TOO_LARGE_NOTE }
    : { files: parseGitDiff(text), note: undefined };

/** The all-added hunk git omits for an untracked text file. An empty file adds zero lines. */
export const untrackedTextDiff = (
  content: string,
): { readonly added: number; readonly diff: string } => {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = body === "" ? [] : body.split("\n");
  return {
    added: lines.length,
    diff: `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`,
  };
};

/** Untracked files listed per diff; the rest are counted in the response note. */
export const MAX_UNTRACKED_FILES = 1000;

/** `more` undefined: git's listing itself was cut, so the count is unknown. */
export const untrackedOverflowNote = (more: number | undefined) =>
  more === undefined
    ? "More untracked files aren't listed"
    : `${more} more untracked ${more === 1 ? "file isn't" : "files aren't"} listed`;
export const UNTRACKED_BUDGET_NOTE =
  "Some untracked files are past the diff size limit and are listed without their contents";

/** Git's binary sniff: a NUL in the first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * At most `limit` bytes of open regular file `fd`; `binary` after reading only the sniffed prefix.
 * The descriptor is closed.
 */
const readBounded = (fd: number, limit: number): Buffer | "binary" => {
  try {
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, limit));
    const sniff = Math.min(buf.length, BINARY_SNIFF_BYTES);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, (read < sniff ? sniff : buf.length) - read, read);
      if (n === 0) break;
      read += n;
      if (read === sniff && buf.subarray(0, sniff).includes(0)) return "binary";
    }
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
};

/**
 * One untracked entry within `budget` bytes of diff text. A link shows its target text, as git does,
 * and is never followed; a file is read through `openInside`, so no link on the way or swapped in
 * redirects it. A directory, FIFO, socket or device is left out, as is anything `openInside` refuses.
 * A file past the budget is listed `too large` unread.
 */
const untrackedFile = (
  workTree: string,
  realTop: string,
  rel: string,
  budget: number,
): DiffFile | undefined => {
  const abs = nodePath.join(workTree, rel);
  const base = { path: rel, status: "new" as const, removed: 0 };
  const tooLarge = { ...base, added: 0, diff: "", note: "too large" as const };
  const binary = { ...base, added: 0, diff: "", note: "binary" as const };
  const limit = Math.min(MAX_VIEW_BYTES, budget);
  let buf: Buffer;
  try {
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) {
      if (!isInside(realTop, realPathSync(nodePath.dirname(abs)))) return undefined;
      buf = fs.readlinkSync(abs, { encoding: "buffer" });
    } else if (stat.isFile()) {
      if (stat.size > limit) return tooLarge;
      // One byte over the limit tells a file that grew since the `lstat`.
      const read = readBounded(openInside(realTop, rel), limit + 1);
      if (read === "binary") return binary;
      buf = read;
    } else return undefined;
  } catch {
    return undefined;
  }
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return binary;
  const text = untrackedTextDiff(buf.toString("utf8"));
  return Buffer.byteLength(text.diff) > budget ? tooLarge : { ...base, ...text };
};

/**
 * Untracked entries after `used` bytes of tracked diff, sharing one byte budget with it: at most
 * `MAX_UNTRACKED_FILES` are looked at, and a note says when any were cut or listed without contents.
 */
const untrackedFiles = (
  workTree: string,
  paths: ReadonlyArray<string>,
  listingCut: boolean,
  used: number,
): { readonly files: Array<DiffFile>; readonly note: string | undefined } => {
  let realTop: string;
  try {
    realTop = realPathSync(workTree);
  } catch {
    return { files: [], note: undefined };
  }
  const files: Array<DiffFile> = [];
  let remaining = Math.max(0, MAX_VIEW_BYTES - used);
  let overBudget = false;
  for (const rel of paths.slice(0, MAX_UNTRACKED_FILES)) {
    const file = untrackedFile(workTree, realTop, rel, remaining);
    if (file === undefined) continue;
    remaining -= Buffer.byteLength(file.diff) + Buffer.byteLength(file.path);
    remaining = Math.max(0, remaining);
    if (file.note === "too large") overBudget = true;
    files.push(file);
  }
  const notes = [
    ...(overBudget ? [UNTRACKED_BUDGET_NOTE] : []),
    ...(listingCut
      ? [untrackedOverflowNote(undefined)]
      : paths.length > MAX_UNTRACKED_FILES
        ? [untrackedOverflowNote(paths.length - MAX_UNTRACKED_FILES)]
        : []),
  ];
  return { files, note: notes.length === 0 ? undefined : notes.join(". ") };
};

export interface DiffOptions {
  /** The rebase signal's resolved base, so a clean tree diffs against the base the chip names. */
  readonly baseOverride?: string | undefined;
}

/**
 * The working-tree diff for `cwd`. A timed-out git call is an error, never a fabricated empty diff
 * that would be cached until the tree changes.
 */
export const gitDiff = (
  cwd: string,
  options: DiffOptions = {},
): Effect.Effect<DiffResponse, ProcError, Proc> =>
  Effect.gen(function* () {
    const workTree = yield* tryRepoTop(cwd);
    if (workTree === undefined) return { repo: false };
    const branch = (yield* git(workTree, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const hasHead = yield* branchExists(workTree, "HEAD");
    const tracked = yield* git(workTree, [
      "-c",
      "core.quotepath=false",
      "-c",
      "diff.mnemonicPrefix=false",
      "diff",
      ...(hasHead ? ["HEAD"] : []),
      "--no-color",
    ]);
    const capped = parseGitDiffCapped(tracked.stdout, tracked.truncated);
    if (capped.note !== undefined) {
      return { repo: true, branch, files: [], worktree: workTree, note: capped.note };
    }
    const files = capped.files;

    // Exact names, NUL-delimited: porcelain's quoted names would need a full C unquoter.
    const others = yield* git(workTree, ["ls-files", "--others", "--exclude-standard", "-z"], {
      maxOutputBytes: 64 * 1024 * 1024,
    });
    const listed = others.stdout.split("\0");
    // The last name of a cut listing may be partial; a whole listing ends in an empty field.
    listed.pop();
    const untracked = untrackedFiles(
      workTree,
      listed.filter((p) => p !== ""),
      others.truncated,
      Buffer.byteLength(tracked.stdout),
    );
    files.push(...untracked.files);
    if (untracked.note !== undefined) {
      return { repo: true, branch, files, worktree: workTree, note: untracked.note };
    }

    if (files.length > 0 || !hasHead) return { repo: true, branch, files, worktree: workTree };

    const chosen = options.baseOverride ?? (yield* localBaseRef(workTree));
    if (chosen === undefined) return { repo: true, branch, files, worktree: workTree };
    const headOid = (yield* git(workTree, ["rev-parse", "HEAD"])).stdout.trim();
    const baseOid = (yield* git(workTree, ["rev-parse", chosen])).stdout.trim();
    if (headOid === "" || headOid === baseOid)
      return { repo: true, branch, files, worktree: workTree };
    const fallback = yield* git(workTree, [
      "-c",
      "core.quotepath=false",
      "-c",
      "diff.mnemonicPrefix=false",
      "diff",
      `${chosen}...HEAD`,
      "--no-color",
    ]);
    const branchDiff = parseGitDiffCapped(fallback.stdout, fallback.truncated);
    if (branchDiff.note !== undefined) {
      return { repo: true, branch, files, worktree: workTree, base: chosen, note: branchDiff.note };
    }
    if (branchDiff.files.length > 0) {
      return { repo: true, branch, files: branchDiff.files, worktree: workTree, base: chosen };
    }
    return { repo: true, branch, files, worktree: workTree };
  });
