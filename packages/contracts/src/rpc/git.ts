import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { CheckoutInUse } from "../checkout-use.ts";
import { BoundPr, HiddenPr, Thread } from "../domain.ts";
import {
  AgentUnavailable,
  GitError,
  InvalidState,
  NotFound,
  ThreadNotFound,
  WorktreeDirty,
} from "../errors.ts";
import { BaseRefFields, BaseRefStatus, FetchBaseResult } from "../git-base.ts";
import { PushResult } from "../git-push.ts";
import { PrStatusResult } from "../pr-status.ts";
import { VerifyState } from "../verify-recipe.ts";
import { FileImage } from "../thread-ui.ts";
import { GitRefreshPayload } from "../git-refresh.ts";
import { FastForwardResult, UpstreamSync, UpstreamSyncFields } from "../git-upstream-sync.ts";
import { UpstreamRefStatus, UpstreamStatusFields } from "../git-upstream.ts";
import { DiffChunk, DiffChunkFields } from "../diff-chunk.ts";
import { BranchList, Diff, DiffScope, GitState, PrChecksResult, PrDetailResult } from "../git.ts";
import {
  PrMergeOptions,
  PrMergePayload,
  PrReadyPayload,
  PrRerunChecksResult,
} from "../pr-actions.ts";
import { CreatedPr, PrCreateFields, PrDraft, PrDraftFields } from "../pr-create.ts";
import { PrLabelList, PrRequestReviewResult, PrReviewerSuggestions } from "../pr-people.ts";
import { OwnPrs, ReviewRequests } from "../review-requests.ts";
import { ApplySuggestionResult, PrReview, ReviewComment } from "../review.ts";
import {
  CleanupPlan,
  CleanupPlanFields,
  CleanUpFields,
  CleanUpResult,
  RemoveWorktreeFields,
  StorageReport,
  WorktreeList,
  WorktreePathFields,
  WorktreeRemoval,
  WorktreeSize,
} from "../worktrees.ts";
import { CiDiagnosticSelection, CiJobDiagnostic } from "../ci-diagnostics.ts";
import { errors, threadRef } from "./shared.ts";

/** Git, pull requests and their review bots, and worktrees. */
export const GitRpcs = RpcGroup.make(
  Rpc.make("worktree.list", {
    payload: { repoPath: Schema.String },
    success: WorktreeList,
    error: errors(GitError),
  }),
  Rpc.make("worktree.remove", {
    payload: RemoveWorktreeFields,
    success: WorktreeRemoval,
    error: errors(WorktreeDirty, GitError, InvalidState),
  }),
  Rpc.make("worktree.status", {
    payload: WorktreePathFields,
    success: GitState,
    error: errors(GitError),
  }),
  Rpc.make("worktree.size", {
    payload: WorktreePathFields,
    success: WorktreeSize,
    error: errors(GitError, InvalidState),
  }),
  Rpc.make("worktree.storage", {
    payload: {},
    success: StorageReport,
    error: errors(GitError),
  }),
  Rpc.make("worktree.cleanupPlan", {
    payload: CleanupPlanFields,
    success: CleanupPlan,
    error: errors(GitError),
  }),
  Rpc.make("worktree.cleanUp", {
    payload: CleanUpFields,
    success: CleanUpResult,
    error: errors(GitError),
  }),
  Rpc.make("worktree.pendingPermissionsAt", {
    payload: WorktreePathFields,
    success: Schema.Array(Schema.String),
    error: errors(GitError),
  }),
  Rpc.make("worktree.pendingPermissions", {
    payload: threadRef,
    success: Schema.Array(Schema.String),
    error: errors(ThreadNotFound, GitError),
  }),
  Rpc.make("git.diff", {
    /** `ignoreWhitespace` leaves whitespace-only changes out, as `git diff -w` does. */
    payload: {
      ...threadRef,
      scope: DiffScope,
      ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
    },
    success: Diff,
    error: errors(ThreadNotFound, GitError, NotFound),
  }),
  Rpc.make("git.diffChunk", {
    payload: { ...threadRef, ...DiffChunkFields },
    success: DiffChunk,
    error: errors(ThreadNotFound, GitError, NotFound),
  }),
  Rpc.make("git.prDetail", {
    payload: threadRef,
    success: PrDetailResult,
    error: errors(ThreadNotFound, GitError),
  }),
  Rpc.make("git.verifyState", {
    payload: threadRef,
    success: VerifyState,
    error: errors(ThreadNotFound),
  }),
  Rpc.make("git.verifyEvidence", {
    payload: {
      ...threadRef,
      driver: Schema.String.check(Schema.isMaxLength(48)),
      file: Schema.String.check(Schema.isMaxLength(255)),
    },
    success: FileImage,
    error: errors(ThreadNotFound, NotFound),
  }),
  Rpc.make("git.prChecks", {
    payload: threadRef,
    success: PrChecksResult,
    error: errors(ThreadNotFound, GitError),
  }),
  Rpc.make("git.prCheckDiagnostic", {
    payload: { ...threadRef, selection: CiDiagnosticSelection },
    success: CiJobDiagnostic,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("git.prRerunChecks", {
    payload: threadRef,
    success: PrRerunChecksResult,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.mergeOptions", {
    payload: threadRef,
    success: PrMergeOptions,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.merge", {
    payload: PrMergePayload,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.ready", {
    payload: PrReadyPayload,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.close", {
    payload: threadRef,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.updateBranch", {
    payload: threadRef,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.reopen", {
    payload: threadRef,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("git.refresh", { payload: GitRefreshPayload, error: errors(ThreadNotFound, GitError) }),
  Rpc.make("git.push", {
    payload: threadRef,
    success: PushResult,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("git.branches", {
    payload: { repoPath: Schema.String },
    success: BranchList,
    error: errors(GitError),
  }),
  Rpc.make("git.baseStatus", {
    payload: BaseRefFields,
    success: BaseRefStatus,
    error: errors(GitError),
  }),
  Rpc.make("git.fetchBase", {
    payload: BaseRefFields,
    success: FetchBaseResult,
    error: errors(GitError),
  }),
  Rpc.make("git.upstreamStatus", {
    payload: UpstreamStatusFields,
    success: UpstreamRefStatus,
    error: errors(GitError),
  }),
  Rpc.make("git.upstreamSync", {
    payload: UpstreamSyncFields,
    success: UpstreamSync,
    error: errors(GitError),
  }),
  Rpc.make("git.fastForward", {
    payload: UpstreamSyncFields,
    success: FastForwardResult,
    error: errors(GitError, InvalidState),
  }),
  Rpc.make("pr.bind", {
    payload: {
      ...threadRef,
      repo: Schema.String,
      number: Schema.Int,
      monitor: Schema.optionalKey(Schema.Boolean),
    },
    success: BoundPr,
    /** `InvalidState` for an orchestrator, which follows no PR of its own. */
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.draft", {
    payload: PrDraftFields,
    success: PrDraft,
    error: errors(ThreadNotFound, GitError),
  }),
  Rpc.make("pr.create", {
    payload: PrCreateFields,
    success: CreatedPr,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.unbind", { payload: threadRef, error: errors(ThreadNotFound) }),
  Rpc.make("pr.status", {
    payload: threadRef,
    success: PrStatusResult,
    error: errors(ThreadNotFound, GitError),
  }),
  Rpc.make("pr.setMonitor", {
    payload: { ...threadRef, monitor: Schema.Boolean },
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("pr.bindExtra", {
    payload: {
      ...threadRef,
      repo: Schema.String,
      number: Schema.Int,
      monitor: Schema.optionalKey(Schema.Boolean),
    },
    success: Schema.Array(BoundPr),
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.unbindExtra", {
    payload: { ...threadRef, repo: Schema.String, number: Schema.Int },
    error: errors(ThreadNotFound),
  }),
  Rpc.make("pr.setExtraMonitor", {
    payload: { ...threadRef, repo: Schema.String, number: Schema.Int, monitor: Schema.Boolean },
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("pr.hide", {
    payload: { ...threadRef, pr: HiddenPr },
    error: errors(ThreadNotFound, GitError),
  }),
  Rpc.make("pr.showHidden", { payload: threadRef, error: errors(ThreadNotFound) }),
  Rpc.make("pr.promote", {
    payload: { ...threadRef, repo: Schema.String, number: Schema.Int },
    success: BoundPr,
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("git.prReview", {
    payload: threadRef,
    success: PrReview,
    error: errors(ThreadNotFound, GitError),
  }),
  Rpc.make("git.prApplySuggestion", {
    payload: { ...threadRef, commentId: Schema.String },
    success: ApplySuggestionResult,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("git.prReplyThread", {
    payload: { ...threadRef, reviewThreadId: Schema.String, body: Schema.String },
    success: ReviewComment,
    error: errors(ThreadNotFound, GitError),
  }),
  Rpc.make("git.prResolveThread", {
    payload: { ...threadRef, reviewThreadId: Schema.String },
    error: errors(ThreadNotFound, GitError),
  }),
  Rpc.make("git.prRequestRereview", {
    payload: threadRef,
    success: Schema.Struct({ command: Schema.String }),
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.requestReview", {
    payload: { ...threadRef, reviewers: Schema.Array(Schema.String) },
    success: PrRequestReviewResult,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.reviewerSuggestions", {
    payload: threadRef,
    success: PrReviewerSuggestions,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.labels.list", {
    payload: threadRef,
    success: PrLabelList,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.labels.add", {
    payload: { ...threadRef, labels: Schema.Array(Schema.String) },
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.labels.remove", {
    payload: { ...threadRef, labels: Schema.Array(Schema.String) },
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.checkout", {
    payload: {
      projectRoot: Schema.String,
      number: Schema.Int,
      /** `owner/repo`; the project's own repository when absent. */
      repo: Schema.optionalKey(Schema.String),
    },
    success: Thread,
    error: errors(
      NotFound,
      AgentUnavailable,
      GitError,
      InvalidState,
      CheckoutInUse,
      ThreadNotFound,
    ),
  }),
  Rpc.make("reviewRequests.list", { success: ReviewRequests, error: errors() }),
  Rpc.make("reviewRequests.refresh", {
    payload: { force: Schema.optionalKey(Schema.Boolean) },
    error: errors(),
  }),
  Rpc.make("openPrs.list", { success: OwnPrs, error: errors() }),
);
