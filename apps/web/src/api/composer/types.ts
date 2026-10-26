import type {
  PaletteFilter,
  Attachment,
  CatchUpView,
  DraftStash,
  FileImage,
  HelperEventPayload,
  RecapView,
  RequestId,
  StashId,
  StuckView,
  ThreadId,
  ThreadSuggestions,
} from "@gram/contracts";

import type { AttachmentTarget, UploadFile } from "../types";

/** What a thread's composer asks for: attachments, stashed drafts, ↑ history, recap and replies. */
export interface ComposerApi {
  /** Optional search chips, never applied or acted on automatically. */
  paletteFilters(threadId: ThreadId, query: string): Promise<readonly PaletteFilter[]>;
  /**
   * Stores a file that has no path on disk for a thread, or stages it for a draft; resolves with its
   * absolute path on the server.
   */
  uploadAttachment(target: AttachmentTarget, file: UploadFile): Promise<Attachment>;
  /**
   * One of the thread's own attachments as base64, for the transcript's inline previews. Rejects
   * with `InvalidState` for a path the thread's messages never referenced or an extension that
   * can't be previewed, and `NotFound` once the file is gone.
   */
  readAttachment(threadId: ThreadId, path: string): Promise<FileImage>;
  /** The prompts ↑ recalls: this thread's stored user messages, then its project's recent threads. */
  promptHistory(threadId: ThreadId, limit?: number): Promise<readonly string[]>;
  /** The thread's stashed drafts (⌘S), newest first. */
  listStashes(threadId: ThreadId): Promise<readonly DraftStash[]>;
  /** Sets a draft aside; the composer clears once it's stored. */
  stashDraft(
    threadId: ThreadId,
    draft: { id: StashId; text: string; attachments: readonly Attachment[] },
  ): Promise<DraftStash>;
  /** Takes a stash back into the composer: it's deleted and returned, attachments kept. */
  takeStash(threadId: ThreadId, stashId: StashId): Promise<DraftStash>;
  /**
   * Discards a stash and the files it uploaded, except any another stash still references or `keep`
   * lists (the composer's live draft).
   */
  removeStash(threadId: ThreadId, stashId: StashId, keep?: readonly string[]): Promise<void>;
  /**
   * Where you left off in a thread being opened, when the server says it deserves a recap; `null`
   * otherwise, or when the helper is off or failed. Can take a second or two when it isn't stored.
   */
  threadRecap(threadId: ThreadId): Promise<RecapView | null>;
  /**
   * For a worker with a report filed since you last looked, the helper's one or two sentences on
   * what changed; `null` when nothing is new, or the helper is off, not allowed or failed.
   */
  threadCatchUp(threadId: ThreadId): Promise<CatchUpView | null>;
  /**
   * "Why is it stuck?" for a worker that hasn't moved in a while: the facts, and the helper's one
   * sentence on them when it is on and allowed; `null` for a thread that isn't a stalled worker.
   */
  threadWhyStuck(threadId: ThreadId): Promise<StuckView | null>;
  /**
   * The suggested replies for the thread's last turn, made now if it has none; `null` when it is
   * busy, its last turn didn't end normally, or the helper is off.
   */
  threadSuggestions(threadId: ThreadId): Promise<ThreadSuggestions | null>;
  /**
   * Up to three short replies the helper drafts for a free-form question the thread asks; empty when
   * the helper is off, not allowed, or had nothing. Never sent on their own.
   */
  requestReplies(threadId: ThreadId, requestId: RequestId): Promise<readonly string[]>;
  /**
   * A short title the helper suggests for a pending request's desktop notification, `count` asking
   * the same; `null` with notification titles off, not allowed, or none made.
   */
  requestNoticeTitle(
    threadId: ThreadId,
    requestId: RequestId,
    count: number,
  ): Promise<string | null>;
  /** Counts what the user did with a helper surface, for the dogfood kill criteria. */
  recordHelperEvent(event: HelperEventPayload): Promise<void>;
}
