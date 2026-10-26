import { PaletteFilter } from "../palette-filters.ts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import {
  CatchUpView,
  HelperEventPayload,
  NoticeTitlePayload,
  RecapPayload,
  RecapView,
  RequestRepliesPayload,
  SuggestionsPayload,
  ThreadSuggestions,
} from "../assist.ts";
import { AttachmentUpload } from "../attachments.ts";
import { Attachment } from "../domain.ts";
import { FeatureCardSummary } from "../feature-cards.ts";
import { WorkspaceId } from "../ids.ts";
import {
  DraftStash,
  DraftStashList,
  StashAddFields,
  StashListFields,
  StashRemoveFields,
  StashTakeFields,
} from "../draft-stash.ts";
import { InvalidState, NotFound, ThreadNotFound } from "../errors.ts";
import { PromptHistory, PromptHistoryFields } from "../prompt-history.ts";
import { StuckView } from "../reaching-workers.ts";
import { FileImage } from "../thread-ui.ts";
import { errors, threadRef } from "./shared.ts";

/** What a thread's composer asks for: attachments, stashed drafts, prompt history, the recap and suggested replies, and the helper events they record. */
export const ComposerRpcs = RpcGroup.make(
  /** Optional, visible proposals only; governed by suggest consent and the helper scheduler. */
  Rpc.make("palette.filters", {
    payload: { ...threadRef, query: Schema.String },
    success: Schema.Array(PaletteFilter),
    error: errors(ThreadNotFound),
  }),
  /**
   * Stores a pasted or dropped file for a thread, or stages it for a draft, and returns it with an
   * absolute path the agent can read. `InvalidState`: empty, over `MAX_ATTACHMENT_BYTES`, or not an
   * image or text file.
   */
  Rpc.make("attachment.upload", {
    payload: AttachmentUpload,
    success: Attachment,
    error: errors(ThreadNotFound, InvalidState),
  }),
  /**
   * An attachment of `threadId` as base64, for the transcript's inline previews. `path` is served
   * only when one of that thread's stored messages references it, so this can't read a file the
   * thread never had; `InvalidState` otherwise, and for an extension `fs.image` can't preview.
   */
  Rpc.make("attachment.read", {
    payload: { ...threadRef, path: Schema.String },
    success: FileImage,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * The prompts ↑ recalls in the composer, derived from stored user messages: this thread's newest
   * first, then the project's recently active threads, duplicates collapsed.
   */
  Rpc.make("thread.promptHistory", {
    payload: PromptHistoryFields,
    success: PromptHistory,
    error: errors(ThreadNotFound),
  }),
  /**
   * Where you left off in a thread you're opening, when `recapDue` says it deserves one: the stored
   * recap if nothing changed since it was made, else a new one (about 1.5 s). `null` when it isn't
   * due, the helper is off or its call failed.
   */
  Rpc.make("thread.recap", {
    payload: RecapPayload,
    success: Schema.NullOr(RecapView),
    error: errors(ThreadNotFound),
  }),
  /**
   * For a worker with a report filed since you last looked (`catchUpDue`): one or two sentences on
   * what changed, from the helper's `recap` kind with its consent and ledger, stored per last report.
   * `null` when nothing is new, the helper is off or not allowed the conversation, or the call failed.
   */
  Rpc.make("thread.catchUp", {
    payload: RecapPayload,
    success: Schema.NullOr(CatchUpView),
    error: errors(ThreadNotFound),
  }),
  /**
   * A feature card's one plain sentence for its current version, from the helper's `recap` kind
   * with its consent and ledger, cached per feature (a card whose versions only moved its now lines
   * costs no call). `null` with helpers off, without consent, or when the call failed.
   */
  Rpc.make("orchestrator.featureSummary", {
    payload: { workspaceId: WorkspaceId, feature: Schema.String },
    success: Schema.NullOr(FeatureCardSummary),
    error: errors(NotFound),
  }),
  /**
   * "Why is it stuck?" for a worker that hasn't moved for `STUCK_AFTER_MS`: the facts it stands on
   * and, through the helper's `stuck` kind with its consent and ledger, one sentence on them, stored
   * per last movement. `null` for a thread that isn't a stalled worker. Nothing is sent to anyone.
   */
  Rpc.make("thread.whyStuck", {
    payload: RecapPayload,
    success: Schema.NullOr(StuckView),
    error: errors(ThreadNotFound),
  }),
  /**
   * Suggested replies for the thread's last turn, as `thread.suggestions` last sent them, or made
   * now for a thread opened without any. `null` when the thread is busy, its last turn didn't end
   * normally, or the helper is off.
   */
  Rpc.make("thread.suggestions", {
    payload: SuggestionsPayload,
    success: Schema.NullOr(ThreadSuggestions),
    error: errors(ThreadNotFound),
  }),
  /**
   * Up to three short replies (six words or fewer each) the helper drafts for a pending free-form
   * question, one with a single question and no options, to fill the reply field with; never sent.
   * Empty for any other request, one no longer pending, or with suggested replies off.
   */
  Rpc.make("request.replies", {
    payload: RequestRepliesPayload,
    success: Schema.Array(Schema.String),
    error: errors(ThreadNotFound),
  }),
  /**
   * A short title the helper suggests for a pending request's desktop notification, or `null`:
   * with notification titles off, without consent, for a request no longer pending, or on any
   * failure. Only ever a title; the notification shows the exact command under it.
   */
  Rpc.make("request.noticeTitle", {
    payload: NoticeTitlePayload,
    success: Schema.NullOr(Schema.String),
    error: errors(ThreadNotFound),
  }),
  /** Counts what the user did with a helper surface, for the dogfood kill criteria; local only. */
  Rpc.make("helper.recordEvent", { payload: HelperEventPayload, error: errors() }),
  /** The thread's stashed drafts (⌘S in the composer), newest first. */
  Rpc.make("thread.stash.list", {
    payload: StashListFields,
    success: DraftStashList,
    error: errors(ThreadNotFound),
  }),
  /** Stashes a draft; past `DRAFT_STASH_LIMIT` the oldest go, with the files they uploaded. */
  Rpc.make("thread.stash.add", {
    payload: StashAddFields,
    success: DraftStash,
    error: errors(ThreadNotFound, NotFound),
  }),
  /** Takes a stash back into the composer: deletes it and returns it, keeping its attachments. */
  Rpc.make("thread.stash.take", {
    payload: StashTakeFields,
    success: DraftStash,
    error: errors(ThreadNotFound, NotFound),
  }),
  /** Discards a stash and the files it uploaded; attachments from disk are never touched. */
  Rpc.make("thread.stash.remove", {
    payload: StashRemoveFields,
    error: errors(ThreadNotFound, NotFound),
  }),
);
