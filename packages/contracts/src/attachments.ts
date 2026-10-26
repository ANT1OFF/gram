import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";

/** The largest attachment `attachment.upload` accepts, in decoded bytes. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * A `/new` draft's client-generated id. Files attached before the thread exists are staged under it
 * and move into the thread on `thread.create`. Restricted to a safe folder name.
 */
export const DraftId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{8,64}$/)).pipe(
  Schema.brand("DraftId"),
);
export type DraftId = typeof DraftId.Type;

/**
 * A pasted or dropped file with no path on disk, for `attachment.upload`: for an existing thread,
 * or staged for a draft. Exactly one of `threadId` and `draftId`.
 */
export const AttachmentUpload = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId),
  draftId: Schema.optionalKey(DraftId),
  /** The original file name; the server sanitises it. */
  name: Schema.String,
  /** `File.type`; empty when the browser doesn't know it. */
  mediaType: Schema.String,
  /** The file's bytes, base64-encoded. */
  data: Schema.String,
}).check(
  Schema.makeFilter(
    (upload) =>
      (upload.threadId === undefined) !== (upload.draftId === undefined) ||
      "an upload needs exactly one of threadId and draftId",
  ),
);
export type AttachmentUpload = typeof AttachmentUpload.Type;
