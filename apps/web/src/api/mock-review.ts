import type {
  ApplySuggestionResult,
  PrReview,
  PrReviewState,
  ReviewComment,
  ReviewRound,
  ReviewThread,
  ThreadId,
} from "@gram/contracts";

import { MockInvalidState } from "./mock-fs";

// Review-bot fixtures for MockApi: one bot review on t-flaky's PR, mutated by the review actions.

const BOT = "example-code-review[bot]";
const PR_URL = "https://github.com/example/api/pull/412";
export const MOCK_HEAD_OID = "9a1e77c0d2f4b6a8c0e2d4f6a8b0c2d4e6f8a0b2";

const comment = (id: string, body: string, extra: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  author: BOT,
  body,
  createdAt: "2026-09-16T11:20:00Z",
  url: `${PR_URL}#discussion_${id}`,
  ...extra,
});

const seedThreads = (): ReviewThread[] => [
  {
    id: "PRRT_retry_last_error",
    path: "src/retry.ts",
    line: 42,
    startLine: 38,
    isResolved: false,
    isOutdated: false,
    severity: "blocker",
    byBot: true,
    comments: [
      comment(
        "PRRC_1",
        "[blocker] `retry` swallows the last error once attempts run out, so callers see `undefined` instead of the failure.\n\n- The loop returns after the final attempt without rethrowing.\n- Rethrow the last error so `retries twice` can assert on the real rejection.",
      ),
    ],
  },
  {
    id: "PRRT_restore_timers",
    path: "src/retry.test.ts",
    line: 13,
    isResolved: false,
    isOutdated: false,
    severity: "blocker",
    byBot: true,
    comments: [
      comment(
        "PRRC_2",
        "[blocker] The fake clock is never restored, so every later test in this file runs on fake timers.\n\n```suggestion\n  const clock = useFakeTimers();\n  onTestFinished(() => clock.uninstall());\n```",
        {
          suggestion:
            "  const clock = useFakeTimers();\n  onTestFinished(() => clock.uninstall());",
        },
      ),
    ],
  },
  {
    id: "PRRT_tick_async",
    path: "src/retry.test.ts",
    line: 18,
    isResolved: false,
    isOutdated: false,
    severity: "suggestion",
    byBot: true,
    comments: [
      comment(
        "PRRC_3",
        "[suggestion] Drain pending timers instead of ticking a fixed 100 ms, so the test doesn't depend on the backoff constant.\n\n```suggestion\n  await clock.runAllAsync();\n```",
        { suggestion: "  await clock.runAllAsync();" },
      ),
    ],
  },
  {
    id: "PRRT_backoff_name",
    path: "src/retry.ts",
    line: 8,
    isResolved: false,
    isOutdated: false,
    severity: "finding",
    byBot: true,
    comments: [
      comment(
        "PRRC_4",
        "`delayMs` reads as a fixed delay, but it's the base of an exponential backoff; `baseDelayMs` would say what it does.",
      ),
    ],
  },
  {
    id: "PRRT_sleep_import",
    path: "src/retry.test.ts",
    isResolved: false,
    isOutdated: true,
    severity: "suggestion",
    byBot: true,
    comments: [
      comment(
        "PRRC_5",
        "[suggestion] `sleep` is no longer used once the fake clock drives the test; drop the import.\n\n```suggestion\n```",
        { suggestion: "", createdAt: "2026-09-16T10:30:00Z" },
      ),
    ],
  },
  {
    id: "PRRT_jitter",
    path: "src/retry.ts",
    line: 30,
    isResolved: true,
    isOutdated: false,
    severity: "blocker",
    byBot: true,
    comments: [
      comment(
        "PRRC_6",
        "[blocker] Jitter uses `Math.random()` directly, so the test can't pin it.",
        {
          createdAt: "2026-09-16T10:30:00Z",
        },
      ),
      comment("PRRC_7", "Fixed in 3f9c2d1: jitter now comes from an injected `random`.", {
        author: "alex",
        createdAt: "2026-09-16T10:50:00Z",
      }),
    ],
  },
];

const SUMMARY = [
  "Re-reviewed; the jitter blocker is resolved, but two blockers remain.",
  "",
  "- `retry` still drops the final error once attempts run out.",
  "- The fake clock leaks into later tests because it's never restored.",
  "",
  "Checked: `src/retry.ts` and `src/retry.test.ts` against the interdiff since the last round.",
].join("\n");

interface MockPrReview {
  review: PrReview;
  roundInFlight: boolean;
  round: number;
}

const countsOf = (threads: readonly ReviewThread[]): PrReviewState["threads"] => {
  const unresolved = threads.filter((t) => t.byBot && !t.isResolved);
  const humanUnresolved = threads.filter((t) => !t.byBot && !t.isResolved).length;
  return {
    unresolved: unresolved.length,
    blockers: unresolved.filter((t) => t.severity === "blocker").length,
    suggestions: unresolved.filter((t) => t.severity === "suggestion").length,
    outdatedUnresolved: unresolved.filter((t) => t.isOutdated).length,
    ...(humanUnresolved === 0 ? {} : { humanUnresolved }),
  };
};

/** The seeded bot review per thread, with the reply / resolve / re-review mutations applied. */
export class MockReviews {
  readonly #byThread = new Map<string, MockPrReview>();
  #seq = 0;

  constructor() {
    this.#byThread.set("t-flaky", {
      roundInFlight: false,
      round: 2,
      review: {
        available: true,
        pr: {
          number: 412,
          url: PR_URL,
          headRefOid: MOCK_HEAD_OID,
          reviewDecision: "CHANGES_REQUESTED",
          mergeStateStatus: "BLOCKED",
        },
        latestReview: {
          id: "PRR_round_2",
          author: BOT,
          verdict: "changesRequested",
          body: SUMMARY,
          commitOid: MOCK_HEAD_OID,
          submittedAt: "2026-09-16T11:20:00Z",
          onHead: true,
          meta: {
            model: "openai/gpt-5.6-sol",
            effort: "medium",
            strictness: "rigorous",
            scope: "interdiff",
          },
        },
        threads: seedThreads(),
      },
    });
  }

  #entry(threadId: ThreadId): MockPrReview {
    const entry = this.#byThread.get(threadId);
    if (!entry) throw new MockInvalidState("This thread has no PR");
    return entry;
  }

  #setThreads(entry: MockPrReview, fn: (t: ReviewThread) => ReviewThread) {
    entry.review = { ...entry.review, threads: entry.review.threads.map(fn) };
  }

  /** `PrStatus.review` for the thread's badge; `undefined` without a bot review. */
  state(threadId: ThreadId): PrReviewState | undefined {
    const entry = this.#byThread.get(threadId);
    if (!entry) return undefined;
    const latest = entry.review.latestReview;
    const verdictOnHead =
      latest?.onHead && latest.verdict !== "commented" ? latest.verdict : undefined;
    return {
      bots: [BOT],
      ...(verdictOnHead ? { verdictOnHead, verdictOnHeadBy: BOT } : {}),
      ...(latest ? { latestVerdict: latest.verdict, latestReviewId: latest.id } : {}),
      reviewedHead: latest?.onHead ?? false,
      roundInFlight: entry.roundInFlight,
      threads: countsOf(entry.review.threads),
    };
  }

  review(threadId: ThreadId): PrReview {
    if (threadId === "t-question") return { available: false, threads: [] };
    const entry = this.#byThread.get(threadId);
    if (!entry) return { available: true, threads: [] };
    const state = this.state(threadId);
    return { ...entry.review, ...(state ? { state } : {}) };
  }

  applySuggestion(threadId: ThreadId, commentId: string): ApplySuggestionResult {
    const thread = this.#entry(threadId).review.threads.find((t) =>
      t.comments.some((c) => c.id === commentId),
    );
    const suggestion = thread?.comments.find((c) => c.id === commentId)?.suggestion;
    if (!thread || suggestion === undefined) {
      throw new MockInvalidState("That comment has no suggestion");
    }
    if (thread.isOutdated || thread.line === undefined) {
      throw new MockInvalidState("The suggestion is outdated: its lines changed since the review");
    }
    return { path: thread.path, startLine: thread.startLine ?? thread.line, endLine: thread.line };
  }

  reply(threadId: ThreadId, reviewThreadId: string, body: string): ReviewComment {
    const entry = this.#entry(threadId);
    const reply: ReviewComment = {
      id: `PRRC_mock_${++this.#seq}`,
      author: "alex",
      body,
      createdAt: new Date().toISOString(),
      url: `${PR_URL}#discussion_mock_${this.#seq}`,
    };
    if (!entry.review.threads.some((t) => t.id === reviewThreadId)) {
      throw new MockInvalidState(`Review thread not found: ${reviewThreadId}`);
    }
    this.#setThreads(entry, (t) =>
      t.id === reviewThreadId ? { ...t, comments: [...t.comments, reply] } : t,
    );
    return reply;
  }

  resolve(threadId: ThreadId, reviewThreadId: string) {
    this.#setThreads(this.#entry(threadId), (t) =>
      t.id === reviewThreadId ? { ...t, isResolved: true } : t,
    );
  }

  /** Marks a round as running; `completeRound` finishes it. */
  startRound(threadId: ThreadId): { command: string } {
    const entry = this.#entry(threadId);
    if (entry.roundInFlight) throw new MockInvalidState("A review round is already running");
    entry.roundInFlight = true;
    return { command: "/agent review" };
  }

  /** Ends the running round: a new summary review on head, verdict from the open blockers. */
  completeRound(threadId: ThreadId): ReviewRound {
    const entry = this.#entry(threadId);
    entry.roundInFlight = false;
    entry.round += 1;
    const counts = countsOf(entry.review.threads);
    const verdict = counts.blockers > 0 ? "changesRequested" : "approved";
    const id = `PRR_round_${entry.round}`;
    entry.review = {
      ...entry.review,
      latestReview: {
        ...entry.review.latestReview!,
        id,
        verdict,
        body:
          verdict === "approved"
            ? "Re-reviewed; no blockers remain outstanding."
            : `Re-reviewed; ${counts.blockers} blocker${counts.blockers === 1 ? "" : "s"} still outstanding.`,
        submittedAt: new Date().toISOString(),
        onHead: true,
      },
    };
    return { number: entry.round, reviewId: id, verdict, verdictOnHead: verdict, counts };
  }
}
