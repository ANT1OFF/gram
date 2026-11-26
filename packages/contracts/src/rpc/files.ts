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
import {
  Doc,
  DocList,
  DocMeta,
  DocArchiveFields,
  DocOpenedFields,
  DocReadFields,
  DocSaveFields,
  DocsArchived,
  DocsArchiveOlderFields,
  DocsListFields,
} from "../docs.ts";
import { WorkspaceOutputsFields, WorkspaceOutputsPage } from "../outputs.ts";
import { FileImage } from "../thread-ui.ts";
import { ProjectVocabulary, ProjectVocabularyFields } from "../vocabulary.ts";
import { errors, PositiveInt } from "./shared.ts";

/** Files: folder listings and previews, `@` mentions and search, and opening paths elsewhere. */
export const FileRpcs = RpcGroup.make(
  Rpc.make("fs.tree", {
    payload: { root: Schema.String, path: Schema.optionalKey(Schema.String) },
    success: FsTree,
    error: errors(FsError),
  }),
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
  Rpc.make("fs.file", {
    payload: {
      path: Schema.String,
      threadId: Schema.optionalKey(ThreadId),
      maxBytes: Schema.optionalKey(PositiveInt),
    },
    success: FsFile,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("fs.search", {
    payload: FsSearchFields,
    success: FsSearchResult,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("fs.files", {
    payload: FsFilesFields,
    success: FsFilesResult,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("fs.vocabulary", {
    payload: ProjectVocabularyFields,
    success: ProjectVocabulary,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("fs.resolve", {
    payload: FsResolveFields,
    success: FsResolveResult,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("fs.image", {
    payload: {
      path: Schema.String,
      threadId: Schema.optionalKey(ThreadId),
      maxBytes: Schema.optionalKey(PositiveInt),
    },
    success: FileImage,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("fs.preview", {
    payload: { threadId: ThreadId, path: Schema.String },
    success: FsPreview,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("fs.browse", {
    payload: {
      path: Schema.String,
      limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    },
    success: FolderListing,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("editor.open", {
    payload: {
      path: Schema.String,
      line: Schema.optionalKey(PositiveInt),
      threadId: Schema.optionalKey(ThreadId),
    },
    success: EditorOpened,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("fs.reveal", {
    payload: { path: Schema.String, threadId: Schema.optionalKey(ThreadId) },
    success: Revealed,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("workspace.outputs", {
    payload: WorkspaceOutputsFields,
    success: WorkspaceOutputsPage,
    error: errors(InvalidState),
  }),
  Rpc.make("docs.list", {
    payload: DocsListFields,
    success: DocList,
    error: errors(InvalidState, FsError),
  }),
  Rpc.make("docs.read", {
    payload: DocReadFields,
    success: Doc,
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("docs.save", {
    payload: DocSaveFields,
    success: DocMeta,
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("docs.listArchived", {
    payload: DocsListFields,
    success: DocList,
    error: errors(InvalidState, FsError),
  }),
  Rpc.make("docs.archive", {
    payload: DocArchiveFields,
    success: DocMeta,
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("docs.restore", {
    payload: DocArchiveFields,
    success: DocMeta,
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("docs.opened", {
    payload: DocOpenedFields,
    error: errors(InvalidState, FsError),
  }),
  Rpc.make("docs.archiveOlderThan", {
    payload: DocsArchiveOlderFields,
    success: DocsArchived,
    error: errors(InvalidState, FsError),
  }),
);
