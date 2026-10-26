import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";

/**
 * `fs.files`: every file and folder for `@` mentions, in a thread's checkout or, before a thread
 * exists, in a folder.
 */
export const FsFilesFields = {
  /** Lists the thread's checkout; a `path` resolves inside it. */
  threadId: Schema.optionalKey(ThreadId),
  /** Without a thread, an absolute folder. */
  path: Schema.optionalKey(Schema.String),
};

export const FsFileName = Schema.Struct({
  /** Relative to the listed folder, `/`-separated, no trailing slash. */
  path: Schema.String,
  kind: Schema.Literals(["file", "dir"]),
});
export type FsFileName = typeof FsFileName.Type;

export const FsFilesResult = Schema.Struct({
  /** Sorted by path. Git-ignored files, `.git` and `node_modules` are left out. */
  entries: Schema.Array(FsFileName),
  /** The folder holds more than the server lists. */
  truncated: Schema.Boolean,
});
export type FsFilesResult = typeof FsFilesResult.Type;

/** Files `fs.files` lists at most; their folders come on top. */
export const FS_FILES_LIMIT = 20_000;

/** Paths `fs.resolve` checks in one call; a message rarely names more. */
export const FS_RESOLVE_LIMIT = 64;

/** `fs.resolve`: which paths an agent wrote name a file, in the thread's checkouts or elsewhere. */
export const FsResolveFields = {
  threadId: ThreadId,
  /** As written: relative to a checkout, absolute, or a bare file name. */
  paths: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
    Schema.isMaxLength(FS_RESOLVE_LIMIT),
  ),
};

export const FsResolvedFile = Schema.Struct({
  /** One of the requested `paths`, unchanged. */
  path: Schema.String,
  /** The absolute path of the file it names. */
  resolved: Schema.String,
});
export type FsResolvedFile = typeof FsResolvedFile.Type;

export const FsResolveResult = Schema.Struct({
  /**
   * The paths that name exactly one regular file: a relative path or a bare name inside the
   * thread's checkout or its other worktrees, an absolute one in the checkout holding it or, in
   * none, anywhere on disk when the thread's messages write it. A path that names none, a folder, several files, or leads out of a
   * checkout it starts in is left out.
   */
  files: Schema.Array(FsResolvedFile),
});
export type FsResolveResult = typeof FsResolveResult.Type;

/**
 * A file shown in the Preview tab: Markdown with its text, which the app renders, or HTML with the
 * loopback URL the shell's preview loads it from, the files beside it included.
 */
export const FsPreview = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("markdown"), path: Schema.String, content: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("html"), path: Schema.String, url: Schema.String }),
]);
export type FsPreview = typeof FsPreview.Type;
