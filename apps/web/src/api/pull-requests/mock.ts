import {
  ORCHESTRATOR_HAS_NO_PR,
  type PrDetailResult,
  type PrStatus,
  type ThreadId,
} from "@gram/contracts";

import { createMockExtraPrs, mockExtraBadge } from "../mock-extra-prs";
import { MockInvalidState } from "../mock-fs";
import {
  mockCreatedPrDetail,
  mockDiff,
  mockGitState,
  mockPrDetail,
  type MockCreated,
  type MockPrWrites,
} from "../mock-git";
import { MockReviews } from "../mock-review";
import type { MockWorld } from "../mock-world";
import type { PullRequestsApi } from "./types";

/** What the slice needs of the other slices the core owns. */
export interface PullRequestsDeps {
  /** PR detail with the reviewers and labels the user changed on it since. */
  readonly peopleDetail: (threadId: ThreadId, detail: PrDetailResult) => PrDetailResult;
  readonly bind: (
    threadId: ThreadId,
    repo: string,
    number: number,
    monitor?: boolean,
  ) => ReturnType<PullRequestsApi["prBind"]>;
  readonly unbind: (threadId: ThreadId) => Promise<void>;
  readonly setMonitor: (threadId: ThreadId, monitor: boolean) => Promise<void>;
}

/**
 * The threads' pull requests: their detail and checks, what the PR panel writes to them, pushing and
 * creating one, extra PRs and the review bot. The core builds it, because seeding and babysit read
 * its review state and orchestrator rule; `api` is what joins the `Api`.
 */
export function createPullRequestsMock(world: MockWorld, deps: PullRequestsDeps) {
  const reviews = new MockReviews();
  const extraPrs = createMockExtraPrs({
    thread: (threadId) => world.summary(threadId).thread,
    replace: (thread) => world.replaceThread(thread),
  });
  /** Per-thread CI rollups set by `simulateChecks`; the seed is failing. */
  const checks = new Map<ThreadId, PrStatus["checks"]>();
  /** What the PR panel's merge, draft, close and reopen changed, per thread. */
  const prWrites = new Map<ThreadId, MockPrWrites>();
  /** Threads whose failed checks were rerun; their detail shows the rerun as queued. */
  const rerunChecks = new Set<ThreadId>();
  /** Threads whose branch the mock has published, and the PRs it created. */
  const published = new Set<ThreadId>();
  const createdPrs = new Map<ThreadId, NonNullable<MockCreated["pr"]>>();
  const createdBodies = new Map<ThreadId, string>();
  /** Commits per thread that origin doesn't have yet, set by `simulateUnpushed`. */
  const unpushed = new Map<ThreadId, number>();

  const created = (threadId: ThreadId): MockCreated => {
    const pr = createdPrs.get(threadId);
    return { published: published.has(threadId), ...(pr ? { pr } : {}) };
  };

  /** Pushes the thread's git state with its current review counts, as the server's poll would. */
  const emitReviewState = (threadId: ThreadId) => {
    const summary = world.summary(threadId);
    const git = mockGitState(
      threadId,
      reviews.state(threadId),
      created(threadId),
      checks.get(threadId),
      unpushed.get(threadId),
      prWrites.get(threadId),
    );
    if (!git) return;
    const extras = (summary.thread.extraPrs ?? []).map(mockExtraBadge);
    world.publishGit(threadId, extras.length === 0 ? git : { ...git, extraPrs: extras });
  };

  /** Rejects as the server does for an orchestrator, which follows no PR of its own. */
  const refuseOrchestratorPr = (threadId: ThreadId) => {
    if (world.summary(threadId).thread.role === "orchestrator") {
      throw new MockInvalidState(ORCHESTRATOR_HAS_NO_PR);
    }
  };

  const writePr = (threadId: ThreadId, write: MockPrWrites) => {
    if (mockPrDetail(threadId).detail === undefined) {
      throw new Error("This thread has no pull request");
    }
    prWrites.set(threadId, { ...prWrites.get(threadId), ...write });
    emitReviewState(threadId);
  };

  const prDetail: PullRequestsApi["prDetail"] = async (threadId) => {
    const summary = world.summary(threadId);
    const made = createdPrs.get(threadId);
    if (made) {
      const body = createdBodies.get(threadId) ?? "";
      return mockCreatedPrDetail(made, body, summary.git?.branch ?? "");
    }
    return deps.peopleDetail(
      threadId,
      mockPrDetail(threadId, { rerun: rerunChecks.has(threadId), ...prWrites.get(threadId) }),
    );
  };

  const api: PullRequestsApi = {
    gitDiff: async (threadId, scope) => {
      world.summary(threadId);
      return mockDiff(threadId, scope);
    },
    prDetail,
    prCheckDiagnostic: async (_threadId, selection) => ({
      ...selection,
      attempt: 1,
      name: "test (windows)",
      link: `https://github.com/example/api/actions/runs/${selection.runId}/job/${selection.jobId}`,
      status: "completed",
      conclusion: "failure",
      runner: "synthetic-runner",
      startedAt: "2026-09-16T18:05:00Z",
      completedAt: "2026-09-16T18:06:00Z",
      failingStep: "Run tests",
      explanation: "Evidence reports a test/assertion failure. Its cause is not established.",
      evidence: [
        {
          source: selection.includeLog ? "log" : "annotation",
          text: "AssertionError: expected two attempts, received three",
        },
      ],
    }),
    prChecks: async (threadId) => ({
      checks: (await prDetail(threadId)).detail?.checkRuns ?? [],
    }),
    prMergeOptions: async (threadId) => ({
      strategies: ["squash", "rebase"] as const,
      autoMerge: true,
      babysit: world.summary(threadId).thread.babysit !== undefined,
    }),
    prMerge: async (threadId, _strategy, auto) => {
      const { thread } = world.summary(threadId);
      if (auto && thread.babysit !== undefined) {
        throw new Error("Auto-merge isn't allowed in babysit mode; merge by hand.");
      }
      writePr(threadId, auto ? {} : { state: "MERGED" });
      // Like the server settling the refreshed badge: the thread completes, with one toast.
      if (!auto && thread.completedAt === undefined) {
        world.updateThread(threadId, { completedAt: Date.now() });
        world.emit({
          type: "notify",
          kind: "done",
          title: `#${mockPrDetail(threadId).detail!.number} merged`,
          body: thread.title,
          threadId,
        });
      }
    },
    prReady: async (threadId, draft) => {
      world.summary(threadId);
      writePr(threadId, { isDraft: draft });
    },
    prClose: async (threadId) => {
      world.summary(threadId);
      writePr(threadId, { state: "CLOSED" });
    },
    prUpdateBranch: async (threadId) => {
      world.summary(threadId);
      writePr(threadId, {});
    },
    prReopen: async (threadId) => {
      world.summary(threadId);
      writePr(threadId, { state: "OPEN" });
    },
    prRerunChecks: async (threadId) => {
      world.summary(threadId);
      const detail = mockPrDetail(threadId).detail;
      if (!detail) throw new Error("This thread has no pull request");
      const runIds = [
        ...new Set(
          detail.checkRuns.flatMap((run) =>
            run.status === "failing" && run.runId !== undefined ? [run.runId] : [],
          ),
        ),
      ];
      if (runIds.length === 0) throw new Error("No failed checks to rerun.");
      rerunChecks.add(threadId);
      return { runIds, skipped: [] };
    },
    refreshGit: async (threadId) => {
      world.summary(threadId);
    },
    pushBranch: async (threadId) => {
      await world.delay(150);
      const git = world.summary(threadId).git;
      const branch = git?.branch;
      if (branch === undefined) {
        throw Object.assign(new Error("HEAD isn't on a branch, so there's nothing to push"), {
          _tag: "InvalidState",
        });
      }
      // As the server does: publishing is for a branch origin doesn't have under its own name yet.
      const first = git?.upstream === undefined;
      published.add(threadId);
      unpushed.delete(threadId);
      emitReviewState(threadId);
      return { branch, published: first };
    },
    prDraft: async (threadId) => {
      const title = world.summary(threadId).thread.title;
      if (threadId !== "t-dark") return { title, body: "", commits: 0 };
      return {
        title,
        body: "- Add a dark mode toggle to settings\n- Add dark palette tokens\n- Persist the theme choice",
        commits: 3,
      };
    },
    prCreate: async ({ threadId, title, body, base, draft }) => {
      refuseOrchestratorPr(threadId);
      await world.delay(200);
      const git = world.summary(threadId).git;
      if (!git?.origin || !published.has(threadId)) {
        throw Object.assign(new Error("you must first push the current branch to a remote"), {
          _tag: "InvalidState",
        });
      }
      const number = 418;
      const url = `https://github.com/${git.origin}/pull/${number}`;
      createdPrs.set(threadId, {
        number,
        state: "OPEN",
        url,
        title,
        isDraft: draft,
        checks: "pending",
        headMatches: true,
        aheadOfPr: false,
        baseRef: base,
      });
      createdBodies.set(threadId, body);
      await deps.bind(threadId, git.origin, number, false);
      emitReviewState(threadId);
      return { repo: git.origin, number, url };
    },
    prBind: async (threadId, repo, number, monitor) => {
      refuseOrchestratorPr(threadId);
      const bound = await deps.bind(threadId, repo, number, monitor);
      // Like the server: a PR bound as the main one is no longer followed as an extra.
      extraPrs.unbind(threadId, repo, number);
      emitReviewState(threadId);
      return bound;
    },
    prUnbind: (threadId) => deps.unbind(threadId),
    prSetMonitor: async (threadId, monitor) => {
      if (monitor) refuseOrchestratorPr(threadId);
      return deps.setMonitor(threadId, monitor);
    },
    prBindExtra: async (threadId, repo, number, monitor) => {
      refuseOrchestratorPr(threadId);
      const extras = extraPrs.bind(threadId, repo, number, monitor);
      emitReviewState(threadId);
      return extras;
    },
    prUnbindExtra: async (threadId, repo, number) => {
      extraPrs.unbind(threadId, repo, number);
      emitReviewState(threadId);
    },
    prSetExtraMonitor: async (threadId, repo, number, monitor) => {
      extraPrs.setMonitor(threadId, repo, number, monitor);
    },
    prPromote: async (threadId, repo, number) => {
      const promoted = extraPrs.promote(threadId, repo, number);
      emitReviewState(threadId);
      return promoted;
    },
    prHide: async (threadId, pr) => {
      extraPrs.hide(threadId, pr);
    },
    prShowHidden: async (threadId) => {
      extraPrs.showHidden(threadId);
    },
    prReview: async (threadId) => {
      world.summary(threadId);
      await world.delay(20);
      return reviews.review(threadId);
    },
    prApplySuggestion: async (threadId, commentId) => {
      world.summary(threadId);
      return reviews.applySuggestion(threadId, commentId);
    },
    prReplyThread: async (threadId, reviewThreadId, body) => {
      world.summary(threadId);
      return reviews.reply(threadId, reviewThreadId, body);
    },
    prResolveThread: async (threadId, reviewThreadId) => {
      world.summary(threadId);
      reviews.resolve(threadId, reviewThreadId);
      emitReviewState(threadId);
    },
    prRequestRereview: async (threadId) => {
      world.summary(threadId);
      const result = reviews.startRound(threadId);
      emitReviewState(threadId);
      void world.delay(3000).then(() => {
        const round = reviews.completeRound(threadId);
        emitReviewState(threadId);
        world.emit({ type: "pr.reviewRound", threadId, round });
      });
      return result;
    },
  };

  return {
    api,
    /** The seeded review state of `threadId`'s PR, for its first git state. */
    reviewState: (threadId: ThreadId) => reviews.state(threadId),
    refuseOrchestratorPr,
    /** The agent commits `commits` more on the branch without pushing. */
    simulateUnpushed: (threadId: ThreadId, commits: number) => {
      unpushed.set(threadId, commits);
      emitReviewState(threadId);
    },
    /** The PR's checks settle to `value`, with the server's toast when they do. */
    simulateChecks: (threadId: ThreadId, value: PrStatus["checks"]) => {
      checks.set(threadId, value);
      emitReviewState(threadId);
      const { git, thread } = world.summary(threadId);
      if (!git?.pr || (value !== "failing" && value !== "passing")) return;
      const failed = value === "failing";
      world.emit({
        type: "notify",
        kind: failed ? "error" : "done",
        title: `CI ${failed ? "failed" : "passed"} on #${git.pr.number}`,
        ...(failed ? { ciFailure: git.pr.url } : {}),
        body: failed ? "unit-tests" : thread.title,
        threadId,
      });
    },
  };
}
