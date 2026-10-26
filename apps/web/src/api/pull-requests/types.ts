import type {
  ApplySuggestionResult,
  CiDiagnosticSelection,
  CiJobDiagnostic,
  BoundPr,
  CreatedPr,
  Diff,
  DiffScope,
  HiddenPr,
  MergeStrategy,
  PrChecksResult,
  PrCreateFields,
  PrDetailResult,
  PrDraft,
  PrMergeOptions,
  PrRerunChecksResult,
  PrReview,
  PushResult,
  ReviewComment,
  ThreadId,
} from "@gram/contracts";

/** A thread's diff, its pull requests and their review bots, and pushing its branch. */
export interface PullRequestsApi {
  gitDiff(threadId: ThreadId, scope: DiffScope): Promise<Diff>;
  prDetail(threadId: ThreadId): Promise<PrDetailResult>;
  /** The PR's checks alone, one small request where `prDetail` fetches the whole PR and its diff. */
  prChecks(threadId: ThreadId): Promise<PrChecksResult>;
  prCheckDiagnostic(threadId: ThreadId, selection: CiDiagnosticSelection): Promise<CiJobDiagnostic>;
  /** Reruns the failed jobs of the PR's failing GitHub Actions runs. */
  prRerunChecks(threadId: ThreadId): Promise<PrRerunChecksResult>;
  /** What the merge dialog may offer: the repository's strategies, auto-merge, and babysit mode. */
  prMergeOptions(threadId: ThreadId): Promise<PrMergeOptions>;
  /** Merges now, or with `auto` turns on auto-merge, which babysit mode refuses. */
  prMerge(threadId: ThreadId, strategy: MergeStrategy, auto?: boolean): Promise<void>;
  /** `draft: false` marks the PR ready for review; `true` converts it to a draft. */
  prReady(threadId: ThreadId, draft: boolean): Promise<void>;
  prClose(threadId: ThreadId): Promise<void>;
  prReopen(threadId: ThreadId): Promise<void>;
  /** Merges the base into the PR's head on GitHub. */
  prUpdateBranch(threadId: ThreadId): Promise<void>;
  /** Asks the server to re-read the thread's git state and PR badge now, network included. */
  refreshGit(threadId: ThreadId): Promise<void>;
  /** Pushes the thread's branch, publishing it with an upstream when it has none. Only on a click. */
  pushBranch(threadId: ThreadId): Promise<PushResult>;
  /** A title and body for a new PR from the branch's commits since `base` (`main`, not `origin/main`). */
  prDraft(threadId: ThreadId, base: string): Promise<PrDraft>;
  /** Opens the thread's PR with `gh pr create` and binds it; the badge arrives as `git.state`. */
  prCreate(input: PrCreateFields): Promise<CreatedPr>;
  /** Makes the thread follow a PR (`owner/repo`, number); the change arrives as `thread.upsert`. */
  prBind(threadId: ThreadId, repo: string, number: number, monitor?: boolean): Promise<BoundPr>;
  prUnbind(threadId: ThreadId): Promise<void>;
  /** Queue a message into the thread when the bound PR's checks settle; `InvalidState` when unbound. */
  prSetMonitor(threadId: ThreadId, monitor: boolean): Promise<void>;
  /**
   * Follows another PR beside the thread's own: a badge and CI watching, nothing the PR panel acts
   * on. Rejects with `InvalidState` for a PR the thread already has, and past the server's cap.
   */
  prBindExtra(
    threadId: ThreadId,
    repo: string,
    number: number,
    monitor?: boolean,
  ): Promise<readonly BoundPr[]>;
  prUnbindExtra(threadId: ThreadId, repo: string, number: number): Promise<void>;
  prSetExtraMonitor(
    threadId: ThreadId,
    repo: string,
    number: number,
    monitor: boolean,
  ): Promise<void>;
  /** Swaps an extra PR with the thread's own, so the PR panel follows it; refused while babysitting. */
  prPromote(threadId: ThreadId, repo: string, number: number): Promise<BoundPr>;
  /** Takes a PR's row out of the strip above the composer; its binding and monitors stay. */
  prHide(threadId: ThreadId, pr: HiddenPr): Promise<void>;
  /** Puts every hidden PR's row back in the strip. */
  prShowHidden(threadId: ThreadId): Promise<void>;
  /** The PR's bot review: verdict, meta and every review thread. */
  prReview(threadId: ThreadId): Promise<PrReview>;
  /** Patches a comment's suggestion into the working tree; nothing is committed. */
  prApplySuggestion(threadId: ThreadId, commentId: string): Promise<ApplySuggestionResult>;
  prReplyThread(threadId: ThreadId, reviewThreadId: string, body: string): Promise<ReviewComment>;
  prResolveThread(threadId: ThreadId, reviewThreadId: string): Promise<void>;
  /** Posts the bot's re-review command as a PR comment and returns it. */
  prRequestRereview(threadId: ThreadId): Promise<{ command: string }>;
}
