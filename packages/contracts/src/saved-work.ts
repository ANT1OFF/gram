// What was last saved of a thread's work on a joined machine (`host.stop.keep`, a stop's keep):
// when, and which files it held against the branch's base. A machine that is lost gives that back,
// and nothing after it, so the thread, its card and its row say so in those terms.
import * as Schema from "effect/Schema";
import { DiffFile } from "./git.ts";

/** The most files a saved record names; the rest are counted (`more`). */
export const SAVED_FILES_MAX = 50;

/** The longest path a saved record names. */
const SAVED_PATH_MAX = 1024;

/** The diff a host sends with each keep, at most: past it the largest files go without bodies. */
export const SAVED_DIFF_BYTES = 512 * 1024;

/** One file a save held: its path and its line counts against the branch's base. */
export const SavedFile = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(SAVED_PATH_MAX)),
  additions: Schema.Int,
  deletions: Schema.Int,
});
export type SavedFile = typeof SavedFile.Type;

/**
 * What a host's keep held of one folder (`HostStopKept.saved`): the diff of the kept commit against
 * the branch's base, so it can be shown while the machine is away. Bodies past `SAVED_DIFF_BYTES`
 * are dropped, largest first, and those files listed `tooLarge`.
 */
export const SavedDiff = Schema.Struct({
  /** The ref the files are against (`origin/main`); absent when only the uncommitted are. */
  base: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  files: Schema.Array(DiffFile).check(Schema.isMaxLength(5000)),
  /** The working tree held edits that weren't committed. */
  uncommitted: Schema.Boolean,
  /** Why files are missing or bodiless, when some are. */
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});
export type SavedDiff = typeof SavedDiff.Type;

/**
 * `Thread.savedWork`: the last save of the thread's work on a joined machine that reached the
 * remote. Kept on the thread, so it outlives a restart of Gram; the diff behind it does not
 * (`thread.savedDiff`).
 */
export const SavedWork = Schema.Struct({
  /** Epoch ms of the save. */
  at: Schema.Number,
  /** The files changed against the branch's base, the first `SAVED_FILES_MAX`. */
  files: Schema.Array(SavedFile).check(Schema.isMaxLength(SAVED_FILES_MAX)),
  /** Files changed past those listed. */
  more: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int,
  /** The save held edits that weren't committed. */
  uncommitted: Schema.Boolean,
  base: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});
export type SavedWork = typeof SavedWork.Type;

/** A thread's saved record from a host's diff, taken `at`. */
export const savedWorkOf = (diff: SavedDiff, at: number): SavedWork => ({
  at,
  files: diff.files.slice(0, SAVED_FILES_MAX).map((file) => ({
    path: file.path.slice(0, SAVED_PATH_MAX),
    additions: file.additions,
    deletions: file.deletions,
  })),
  more: Math.max(0, diff.files.length - SAVED_FILES_MAX),
  additions: diff.files.reduce((sum, file) => sum + file.additions, 0),
  deletions: diff.files.reduce((sum, file) => sum + file.deletions, 0),
  uncommitted: diff.uncommitted,
  ...(diff.base === undefined ? {} : { base: diff.base }),
});

/** How many files a saved record counts. */
export const savedFileCount = (saved: SavedWork): number => saved.files.length + saved.more;
