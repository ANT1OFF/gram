import type { PrReviewState, PrStatus, ReviewThread } from "@gram/contracts";

export const HEAD_A = "a".repeat(40);
export const HEAD_B = "b".repeat(40);

export const noThreads = { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 };

export const reviewState = (overrides: Partial<PrReviewState> = {}): PrReviewState => ({
  bots: ["example-code-review"],
  reviewedHead: true,
  roundInFlight: false,
  threads: noThreads,
  ...overrides,
});

export const badge = (overrides: Partial<PrStatus> = {}): PrStatus => ({
  number: 12,
  state: "OPEN",
  url: "https://github.com/acme/web/pull/12",
  title: "t",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: HEAD_A,
  mergeState: "BLOCKED",
  ...overrides,
});

export const botThread = (
  id: string,
  severity: ReviewThread["severity"],
  isResolved = false,
): ReviewThread => ({
  id,
  path: "src/app.ts",
  line: 3,
  isResolved,
  isOutdated: false,
  severity,
  byBot: true,
  comments: [
    {
      id: `${id}_c`,
      author: "example-code-review",
      body: `[${severity}] Finding ${id}.`,
      createdAt: "2026-09-16T10:00:00Z",
      url: `https://github.com/acme/web/pull/12#${id}`,
    },
  ],
});
