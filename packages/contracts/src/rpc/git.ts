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
import { GitRefreshPayload } from "../git-refresh.ts";
import { FastForwardResult, UpstreamSync, UpstreamSyncFields } from "../git-upstream-sync.ts";
import { UpstreamRefStatus, UpstreamStatusFields } from "../git-upstream.ts";
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
  /** The worktree's local git state (changes, unmerged commits), for the Worktrees list. */
  Rpc.make("worktree.status", {
    payload: WorktreePathFields,
    success: GitState,
    error: errors(GitError),
  }),
  /** Bytes a linked worktree takes on disk; `InvalidState` for the main checkout or a stranger. */
  Rpc.make("worktree.size", {
    payload: WorktreePathFields,
    success: WorktreeSize,
    error: errors(GitError, InvalidState),
  }),
  /** Every known repo's linked worktrees, grouped for Settings › Storage, and the free disk space. */
  Rpc.make("worktree.storage", {
    payload: {},
    success: StorageReport,
    error: errors(GitError),
  }),
  /** What "Clean up inactive" would remove and free; nothing is removed. */
  Rpc.make("worktree.cleanupPlan", {
    payload: CleanupPlanFields,
    success: CleanupPlan,
    error: errors(GitError),
  }),
  /**
   * Removes the worktrees at `paths`, keeping their branches. One an open thread uses is kept, and so
   * is one with uncommitted or unpushed work unless `confirmed` names it.
   */
  Rpc.make("worktree.cleanUp", {
    payload: CleanUpFields,
    success: CleanUpResult,
    error: errors(GitError),
  }),
  /** Like `worktree.pendingPermissions`, by folder, for a worktree no thread has open. */
  Rpc.make("worktree.pendingPermissionsAt", {
    payload: WorktreePathFields,
    success: Schema.Array(Schema.String),
    error: errors(GitError),
  }),
  /** Permission rules approved in the thread's worktree that the main checkout lacks; none for other checkouts. */
  Rpc.make("worktree.pendingPermissions", {
    payload: threadRef,
    success: Schema.Array(Schema.String),
    error: errors(ThreadNotFound, GitError),
  }),
  Rpc.make("git.diff", {
    payload: { ...threadRef, scope: DiffScope },
    success: Diff,
    error: errors(ThreadNotFound, GitError, NotFound),
  }),
  Rpc.make("git.prDetail", {
    payload: threadRef,
    success: PrDetailResult,
    error: errors(ThreadNotFound, GitError),
  }),
  /** The PR's checks alone: one small request, for whoever doesn't need `git.prDetail`'s PR and diff. */
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
  /** Reruns the failed jobs of the PR's failing GitHub Actions runs; `InvalidState` without any. */
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
  /** Merges the base into the PR's head on GitHub, for an out-of-date or conflicting PR. */
  Rpc.make("pr.updateBranch", {
    payload: threadRef,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("pr.reopen", {
    payload: threadRef,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  Rpc.make("git.refresh", { payload: GitRefreshPayload, error: errors(ThreadNotFound, GitError) }),
  /**
   * Pushes the thread's branch, publishing it with `-u origin <branch>` when it has no upstream.
   * `InvalidState` for a detached HEAD, no origin remote, or a branch behind or diverged from its
   * upstream; it never forces. Only ever on a click.
   */
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
  /** When `base`'s remote was last fetched, for the `/new` behind-origin note. No network. */
  Rpc.make("git.baseStatus", {
    payload: BaseRefFields,
    success: BaseRefStatus,
    error: errors(GitError),
  }),
  /** Fetches `base` from origin, on the user's click; reports the commits that arrived. */
  Rpc.make("git.fetchBase", {
    payload: BaseRefFields,
    success: FetchBaseResult,
    error: errors(GitError),
  }),
  /** The current checkout's `origin/` upstream and when it was last fetched. No network. */
  Rpc.make("git.upstreamStatus", {
    payload: UpstreamStatusFields,
    success: UpstreamRefStatus,
    error: errors(GitError),
  }),
  /** The current branch against its `origin/` upstream: ahead, behind, and why it can't fast-forward. No network. */
  Rpc.make("git.upstreamSync", {
    payload: UpstreamSyncFields,
    success: UpstreamSync,
    error: errors(GitError),
  }),
  /**
   * Fast-forwards the current branch onto its upstream (`merge --ff-only`). `InvalidState` for a
   * dirty or diverged checkout, or nothing to take. Only ever on a click.
   */
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
  /** A title and body for a new PR from the branch's commits since `base`. Local data only. */
  Rpc.make("pr.draft", {
    payload: PrDraftFields,
    success: PrDraft,
    error: errors(ThreadNotFound, GitError),
  }),
  /** `gh pr create` for the thread's branch, then binds the new PR and refreshes the badge. */
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
  /**
   * Follows another PR beside the thread's own (`Thread.extraPrs`). `InvalidState` when it is already
   * followed, is the thread's `boundPr`, or the thread is at `MAX_EXTRA_PRS`.
   */
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
  /**
   * Takes a PR's row out of the PR strip (`Thread.hiddenPrs`), replacing an earlier entry for it. The
   * binding, its monitors and babysit mode are untouched.
   */
  Rpc.make("pr.hide", {
    payload: { ...threadRef, pr: HiddenPr },
    error: errors(ThreadNotFound, GitError),
  }),
  /** Puts every hidden PR's row back in the strip. */
  Rpc.make("pr.showHidden", { payload: threadRef, error: errors(ThreadNotFound) }),
  /**
   * Makes an extra PR the thread's `boundPr`, so the PR panel and its actions follow it; the PR it
   * replaces becomes an extra. Refused in babysit mode, which is tied to the PR it started on.
   */
  Rpc.make("pr.promote", {
    payload: { ...threadRef, repo: Schema.String, number: Schema.Int },
    success: BoundPr,
    error: errors(ThreadNotFound, InvalidState),
  }),
  // Review bots; every write goes through `gh api` in the thread's checkout
  Rpc.make("git.prReview", {
    payload: threadRef,
    success: PrReview,
    error: errors(ThreadNotFound, GitError),
  }),
  /** Patches the suggestion into the working tree; nothing is committed. */
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
  /** Posts the bot's configured re-review command as a PR comment. */
  Rpc.make("git.prRequestRereview", {
    payload: threadRef,
    success: Schema.Struct({ command: Schema.String }),
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  /** Asks users (logins) or teams (`org/slug`) to review the thread's PR. */
  Rpc.make("pr.requestReview", {
    payload: { ...threadRef, reviewers: Schema.Array(Schema.String) },
    success: PrRequestReviewResult,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  /** Best effort: an empty list when `gh` can't read the repo's reviewers or collaborators. */
  Rpc.make("pr.reviewerSuggestions", {
    payload: threadRef,
    success: PrReviewerSuggestions,
    error: errors(ThreadNotFound, GitError, InvalidState),
  }),
  // GitHub labels on the thread's PR; thread labels are `labels.*`
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
  /** A new worktree on the PR's head branch, a thread in it, and the PR bound to that thread. */
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
  /** Open PRs requesting the user's review, as last polled through `gh search prs`. Read-only. */
  Rpc.make("reviewRequests.list", { success: ReviewRequests, error: errors() }),
  /**
   * Polls again now, for review requests and open PRs both: at most once a minute (the window
   * regained focus), or at once with `force` (the setting changed).
   */
  Rpc.make("reviewRequests.refresh", {
    payload: { force: Schema.optionalKey(Schema.Boolean) },
    error: errors(),
  }),
  /**
   * The user's own open PRs, drafts included, found by the same poll; `reviewRequests.refresh`
   * polls both. Read-only.
   */
  Rpc.make("openPrs.list", { success: OwnPrs, error: errors() }),
);
