import type {
  EditorOpened,
  FileImage,
  FolderListing,
  FsFile,
  FsFilesResult,
  FsListing,
  FsPreview,
  FsResolveResult,
  FsSearchResult,
  OutputKind,
  Revealed,
  ThreadId,
  WorkspaceId,
  WorkspaceOutputsPage,
} from "@gram/contracts";

/** `fs.*` and `editor.open`: folders and files to list, preview, search and open elsewhere. */
export interface FilesApi {
  /**
   * Lists folders (`~` expanded). A path ending in `/` lists that folder; otherwise its last
   * segment filters the parent by prefix. Rejects with `NotFound` or `InvalidState`.
   */
  browse(path: string, limit?: number): Promise<FolderListing>;
  /** A folder's files and folders for the Files panel. Rejects with `NotFound` / `InvalidState`. */
  fsList(
    path: string,
    options?: { threadId?: ThreadId; showHidden?: boolean; limit?: number },
  ): Promise<FsListing>;
  /** A file for preview: text with a language id, or the binary / too-large flags. */
  fsFile(path: string, options?: { threadId?: ThreadId; maxBytes?: number }): Promise<FsFile>;
  /** One page of content matches in the thread's checkout. Rejects with `InvalidState` for a bad regex. */
  fsSearch(
    threadId: ThreadId,
    query: string,
    options?: { regex?: boolean; caseSensitive?: boolean; offset?: number; limit?: number },
  ): Promise<FsSearchResult>;
  /** Every file and folder for `@` mentions: a thread's checkout, or an absolute folder. */
  fsFiles(target: { threadId: ThreadId } | { path: string }): Promise<FsFilesResult>;
  /**
   * Which of `paths` an agent's message names are files in the thread's checkouts, and where.
   * At most `FS_RESOLVE_LIMIT` per call.
   */
  fsResolve(threadId: ThreadId, paths: readonly string[]): Promise<FsResolveResult>;
  /**
   * A Markdown or HTML file for the Preview tab: Markdown's text, or the loopback URL an HTML page
   * loads from. `path` is in the thread's folders or a file its Write or Edit calls named.
   */
  previewFile(threadId: ThreadId, path: string): Promise<FsPreview>;
  /** A png / jpg / gif / svg / webp as base64 for previews. */
  fsImage(path: string, options?: { threadId?: ThreadId; maxBytes?: number }): Promise<FileImage>;
  /** Opens a file (at `line`) or folder in the configured editor; `threadId` scopes relative paths. */
  openInEditor(
    path: string,
    options?: { line?: number; threadId?: ThreadId },
  ): Promise<EditorOpened>;
  /** Shows a file or folder selected in Finder / Explorer; `threadId` scopes relative paths. */
  revealPath(path: string, options?: { threadId?: ThreadId }): Promise<Revealed>;
  /**
   * A page of the files the workspace's threads produced, newest first: names, sizes and the
   * thread that made each. Bytes come from the thread's own `fsImage` / `readAttachment` / Files
   * panel. Rejects with `InvalidState` for a cursor that isn't a previous page's `next`.
   */
  listOutputs(
    workspaceId: WorkspaceId,
    options?: { kind?: OutputKind; cursor?: string; limit?: number },
  ): Promise<WorkspaceOutputsPage>;
}
