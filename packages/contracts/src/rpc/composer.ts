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
  Rpc.make("palette.filters", {
    payload: { ...threadRef, query: Schema.String },
    success: Schema.Array(PaletteFilter),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("attachment.upload", {
    payload: AttachmentUpload,
    success: Attachment,
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("attachment.read", {
    payload: { ...threadRef, path: Schema.String },
    success: FileImage,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("thread.promptHistory", {
    payload: PromptHistoryFields,
    success: PromptHistory,
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.recap", {
    payload: RecapPayload,
    success: Schema.NullOr(RecapView),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.catchUp", {
    payload: RecapPayload,
    success: Schema.NullOr(CatchUpView),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("orchestrator.featureSummary", {
    payload: { workspaceId: WorkspaceId, feature: Schema.String },
    success: Schema.NullOr(FeatureCardSummary),
    error: errors(NotFound),
  }),
  Rpc.make("thread.whyStuck", {
    payload: RecapPayload,
    success: Schema.NullOr(StuckView),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.suggestions", {
    payload: SuggestionsPayload,
    success: Schema.NullOr(ThreadSuggestions),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("request.replies", {
    payload: RequestRepliesPayload,
    success: Schema.Array(Schema.String),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("request.noticeTitle", {
    payload: NoticeTitlePayload,
    success: Schema.NullOr(Schema.String),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("helper.recordEvent", { payload: HelperEventPayload, error: errors() }),
  Rpc.make("thread.stash.list", {
    payload: StashListFields,
    success: DraftStashList,
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.stash.add", {
    payload: StashAddFields,
    success: DraftStash,
    error: errors(ThreadNotFound, NotFound),
  }),
  Rpc.make("thread.stash.take", {
    payload: StashTakeFields,
    success: DraftStash,
    error: errors(ThreadNotFound, NotFound),
  }),
  Rpc.make("thread.stash.remove", {
    payload: StashRemoveFields,
    error: errors(ThreadNotFound, NotFound),
  }),
);
