const REVIEW_BOT_FIXTURE = [
  { loginPattern: "example-code-review[bot]", rereviewCommand: "/agent review", canApprove: true },
];
import { describe, it } from "vitest";
import { PrReview, ReviewBot, ReviewRound } from "./review.ts";
import { expectRoundTrip } from "./test-utils.ts";

describe("review contracts", () => {
  it("round-trip a full PR review and a round event", () => {
    expectRoundTrip(ReviewBot, REVIEW_BOT_FIXTURE[0]!);
    expectRoundTrip(PrReview, {
      available: true,
      pr: {
        number: 1943,
        url: "https://github.com/acme/web/pull/1943",
        headRefOid: "b04f64e",
        reviewDecision: "CHANGES_REQUESTED",
        mergeStateStatus: "BLOCKED",
      },
      state: {
        bots: ["example-code-review"],
        verdictOnHead: "changesRequested",
        latestVerdict: "changesRequested",
        reviewedHead: true,
        roundInFlight: false,
        latestReviewId: "PRR_1",
        threads: { unresolved: 3, blockers: 1, suggestions: 1, outdatedUnresolved: 1 },
      },
      latestReview: {
        id: "PRR_1",
        author: "example-code-review",
        verdict: "changesRequested",
        body: "Re-reviewed; one prior blocker remains.",
        commitOid: "b04f64e",
        submittedAt: "2026-09-10T10:00:00Z",
        onHead: true,
        meta: { model: "openai/gpt-5.6-sol", scope: "interdiff" },
      },
      threads: [
        {
          id: "PRRT_1",
          path: "src/confirmations.py",
          line: 118,
          isResolved: false,
          isOutdated: false,
          severity: "suggestion",
          byBot: true,
          comments: [
            {
              id: "PRRC_1",
              author: "example-code-review",
              body: "[suggestion] Remove this.\n```suggestion\n```",
              createdAt: "2026-09-10T10:00:00Z",
              url: "https://github.com/acme/web/pull/1943#discussion_r1",
              suggestion: "",
            },
          ],
        },
      ],
    });
    expectRoundTrip(ReviewRound, {
      number: 7,
      reviewId: "PRR_2",
      verdict: "approved",
      verdictOnHead: "approved",
      counts: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
    });
  });
});
