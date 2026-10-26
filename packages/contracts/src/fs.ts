import * as Schema from "effect/Schema";

export const FsEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["file", "dir", "symlink"]),
  /** Bytes; files only. */
  size: Schema.optionalKey(Schema.Int),
  /** Epoch ms. */
  modifiedAt: Schema.optionalKey(Schema.Int),
});
export type FsEntry = typeof FsEntry.Type;

/** Served by `fs.tree`, which the server uses for folder browsing; new clients use `fs.list`. */
export const FsTree = Schema.Struct({
  root: Schema.String,
  path: Schema.String,
  entries: Schema.Array(FsEntry),
});
export type FsTree = typeof FsTree.Type;

/** A folder's files and folders, for the Files panel. */
export const FsListing = Schema.Struct({
  path: Schema.String,
  /** Absent at the filesystem root. */
  parent: Schema.optionalKey(Schema.String),
  entries: Schema.Array(FsEntry),
  /** More entries than `limit`. */
  truncated: Schema.Boolean,
});
export type FsListing = typeof FsListing.Type;

export const FsFile = Schema.Struct({
  path: Schema.String,
  /** Bytes on disk. */
  size: Schema.Int,
  binary: Schema.Boolean,
  /** Larger than `maxBytes`. */
  tooLarge: Schema.Boolean,
  /** UTF-8 text; absent for binary or too-large files. */
  content: Schema.optionalKey(Schema.String),
  /** Syntax-highlighting language id, e.g. `typescript`. */
  language: Schema.optionalKey(Schema.String),
});
export type FsFile = typeof FsFile.Type;

export const FolderEntry = Schema.Struct({
  name: Schema.String,
  /** Absolute, with `~` expanded. */
  path: Schema.String,
  isGitRepo: Schema.Boolean,
});
export type FolderEntry = typeof FolderEntry.Type;

export const FolderListing = Schema.Struct({
  /** The folder that was listed, absolute. */
  path: Schema.String,
  /** Absent at the filesystem root. */
  parent: Schema.optionalKey(Schema.String),
  /**
   * The listed folder's own `.git`: a directory makes it a repository's top folder, a file a linked
   * worktree's or a submodule's; `unreadable` when it couldn't be read. Absent without one.
   */
  git: Schema.optionalKey(Schema.Literals(["repository", "linked", "unreadable"])),
  entries: Schema.Array(FolderEntry),
  /** More folders matched than `limit`. */
  truncated: Schema.Boolean,
});
export type FolderListing = typeof FolderListing.Type;
