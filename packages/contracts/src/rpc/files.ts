import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { EditorOpened, Revealed } from "../depth.ts";
import { InvalidState, NotFound, FsError } from "../errors.ts";
import {
  FsFilesFields,
  FsFilesResult,
  FsPreview,
  FsResolveFields,
  FsResolveResult,
} from "../fs-files.ts";
import { FsSearchFields, FsSearchResult } from "../fs-search.ts";
import { FolderListing, FsListing, FsTree, FsFile } from "../fs.ts";
import { ThreadId } from "../ids.ts";
import { WorkspaceOutputsFields, WorkspaceOutputsPage } from "../outputs.ts";
import { FileImage } from "../thread-ui.ts";
import { errors, PositiveInt } from "./shared.ts";

/** Files: folder listings and previews, `@` mentions and search, and opening paths elsewhere. */
export const FileRpcs = RpcGroup.make(
  Rpc.make("fs.tree", {
    payload: { root: Schema.String, path: Schema.optionalKey(Schema.String) },
    success: FsTree,
    error: errors(FsError),
  }),
  /**
   * A folder's files and folders for the Files panel (`fs.browse` stays folders-only). Hidden
   * entries only with `showHidden`. `threadId` scopes and validates `path` within the thread's
   * checkout.
   */
  Rpc.make("fs.list", {
    payload: {
      path: Schema.String,
      threadId: Schema.optionalKey(ThreadId),
      showHidden: Schema.optionalKey(Schema.Boolean),
      limit: Schema.optionalKey(PositiveInt),
    },
    success: FsListing,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * A file preview for the Files panel. Binary files, and files over `maxBytes` (at most 2 MiB), come
   * back without `content`. `threadId` scopes `path` to the thread's checkouts, or, for an absolute
   * path outside them, to the paths the thread's messages name, in their text or a finished Write
   * or Edit, never a credential file (`isCredentialPath`). Without `threadId` it is refused.
   */
  Rpc.make("fs.file", {
    payload: {
      path: Schema.String,
      threadId: Schema.optionalKey(ThreadId),
      maxBytes: Schema.optionalKey(PositiveInt),
    },
    success: FsFile,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * Content search in the thread's checkout: tracked files and untracked ones git doesn't ignore,
   * skipping binary files. Paged by `offset`, and capped by match count, output size and time.
   */
  Rpc.make("fs.search", {
    payload: FsSearchFields,
    success: FsSearchResult,
    error: errors(NotFound, InvalidState),
  }),
  /** Every file and folder in the thread's checkout for `@` mentions, capped. */
  Rpc.make("fs.files", {
    payload: FsFilesFields,
    success: FsFilesResult,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * Which of the paths an agent's message names are files, so the transcript links only those. A
   * path into a checkout never resolves outside it, lexically or through a symlink; an absolute
   * path in no checkout is only checked to be a file, and only when the thread's messages write it.
   * Reads no content.
   */
  Rpc.make("fs.resolve", {
    payload: FsResolveFields,
    success: FsResolveResult,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * A png / jpg / gif / svg / webp image as base64 for previews, up to `maxBytes` (at most 5 MiB);
   * other extensions are refused.
   * `threadId` scopes `path` as `fs.file` does; without one it is refused.
   */
  Rpc.make("fs.image", {
    payload: {
      path: Schema.String,
      threadId: Schema.optionalKey(ThreadId),
      maxBytes: Schema.optionalKey(PositiveInt),
    },
    success: FileImage,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * A Markdown or HTML file for the Preview tab. `path` must be inside the thread's checkouts or
   * folders it was granted, or a file the thread's own Write or Edit calls named, such as a report
   * written to a temp folder. Anything else, and any other kind of file, is `InvalidState`.
   */
  Rpc.make("fs.preview", {
    payload: { threadId: ThreadId, path: Schema.String },
    success: FsPreview,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * Folder autocomplete for the project picker. Expands `~` and lists directories only. A `path`
   * ending in `/` lists that folder; otherwise the last segment is a case-insensitive name prefix
   * matched within its parent. Dotfolders appear only when that prefix starts with `.`. At most
   * `limit` entries (default 500), with `truncated` set when more matched.
   */
  Rpc.make("fs.browse", {
    payload: {
      path: Schema.String,
      limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    },
    success: FolderListing,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * Opens a file (at `line`) or a folder in `settings.editor.command`. `threadId` scopes and validates
   * `path` within the thread's checkout.
   */
  Rpc.make("editor.open", {
    payload: {
      path: Schema.String,
      line: Schema.optionalKey(PositiveInt),
      threadId: Schema.optionalKey(ThreadId),
    },
    success: EditorOpened,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * Shows a file or folder in the system file manager, selected in Finder or Explorer. A relative
   * `path` resolves within the thread's checkout.
   */
  Rpc.make("fs.reveal", {
    payload: { path: Schema.String, threadId: Schema.optionalKey(ThreadId) },
    success: Revealed,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * The files the workspace's threads produced, newest first, `limit` a page (`OUTPUTS_PAGE`, at
   * most `OUTPUTS_PAGE_MAX`). Lists what was recorded as it was written; reads no file. Each entry's
   * bytes are read through its thread's scoped paths. `InvalidState` for a cursor this didn't make.
   */
  Rpc.make("workspace.outputs", {
    payload: WorkspaceOutputsFields,
    success: WorkspaceOutputsPage,
    error: errors(InvalidState),
  }),
);
