// One file's patch out of a `git diff` limited to its paths: for paging through a file too large for
// the listing, which reads it again on its own up to a larger cap.

import { createHash } from "node:crypto";
import { parseGitDiff, type DiffFileStatus } from "./diff.ts";

/**
 * Bytes of one file's `git diff` read for paging through it. Past this the file's later hunks
 * aren't served; the chunks say the patch was read in part.
 */
export const MAX_FILE_DIFF_READ_BYTES = 16 * 1024 * 1024;

/**
 * `git` options before `diff` for one file's patch: paths are literal (no pathspec magic such as
 * `:(top)` or globs in a name), and names and prefixes come out as the parser reads them.
 */
export const FILE_DIFF_GIT_ARGS: ReadonlyArray<string> = [
  "--literal-pathspecs",
  "-c",
  "core.quotepath=false",
  "-c",
  "diff.mnemonicPrefix=false",
];

/** The paths a `git diff` for `path` names after `--`: a rename's both sides, so git pairs them. */
export const fileDiffPaths = (path: string, oldPath?: string | undefined): Array<string> =>
  oldPath === undefined || oldPath === path ? [path] : [oldPath, path];

export interface FilePatch {
  readonly path: string;
  readonly status: DiffFileStatus;
  readonly binary: boolean;
  /** From the first `@@` onward; empty for a binary file or one with no content change. */
  readonly patch: string;
  readonly additions: number;
  readonly deletions: number;
  /** Stands for the whole patch: equal fingerprints, equal patches. */
  readonly fingerprint: string;
}

const BINARY = /^(?:Binary files .* differ|GIT binary patch)$/m;

/** Each `diff --git` section of `text`. A hunk line never starts with `diff`, so these are headers. */
function* sections(text: string): Generator<string> {
  let start = text.startsWith("diff --git ") ? 0 : text.indexOf("\ndiff --git ");
  if (start === -1) return;
  if (start > 0) start += 1;
  while (start < text.length) {
    const next = text.indexOf("\ndiff --git ", start);
    yield next === -1 ? text.slice(start) : text.slice(start, next + 1);
    if (next === -1) return;
    start = next + 1;
  }
}

export const fingerprintOf = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 32);

/**
 * The section of `git diff` output `text` for `path` (its new path; a deleted file's old one). Output
 * cut at the read cap (`truncated`) ends at its last whole line; its last hunk may be cut short.
 */
export const selectFilePatch = (
  text: string,
  path: string,
  truncated = false,
): FilePatch | undefined => {
  const whole = truncated ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
  for (const section of sections(whole)) {
    // Without the closing newline, which the parser would read as one more (empty) line.
    const file = parseGitDiff(section.endsWith("\n") ? section.slice(0, -1) : section)[0];
    if (file?.path !== path) continue;
    const hunks = section.indexOf("\n@@");
    const head = hunks === -1 ? section : section.slice(0, hunks);
    const binary = file.diff === "" && BINARY.test(head);
    return {
      path: file.path,
      status: file.status,
      binary,
      patch: file.diff,
      additions: file.added,
      deletions: file.removed,
      fingerprint: fingerprintOf(`${truncated ? "cut" : "whole"}\n${section}`),
    };
  }
  return undefined;
};
