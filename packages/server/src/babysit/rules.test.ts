import { describe, expect, it } from "@effect/vitest";
import {
  initialBabysitState,
  type PrReview,
  type PrReviewState,
  type PrStatus,
  type ReviewThread,
} from "@gram/contracts";
import {
  alreadyReported,
  buildReport,
  checkDecision,
  citedShas,
  countRound,
  failingCheck,
  isReadyToMerge,
  leavesWork,
  markDeclined,
  markHandled,
  noticeReasons,
  openFindings,
  pickBot,
  stopReasonOf,
  uncountedReview,
} from "./rules.ts";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const badge = (overrides: Partial<PrStatus> = {}): PrStatus => ({
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

const thread = (overrides: Partial<ReviewThread>): ReviewThread => ({
  id: "PRRT_1",
  path: "src/app.ts",
  line: 3,
  isResolved: false,
  isOutdated: false,
  severity: "suggestion",
  byBot: true,
  comments: [
    {
      id: "PRRC_1",
      author: "example-code-review",
      body: "[suggestion] Name this.",
      createdAt: "2026-09-16T10:00:00Z",
      url: "https://github.com/acme/web/pull/12#discussion_r1",
    },
  ],
  ...overrides,
});

const state = initialBabysitState(0);

describe("citedShas", () => {
  it("reads SHAs cited as fixes, case-insensitively and with backticks", () => {
    expect(citedShas("Fixed in 1a2b3c4: renamed it")).toEqual(["1a2b3c4"]);
    expect(citedShas("fixed in `ABCDEF1234` and fixed in 9999999")).toEqual([
      "abcdef1234",
      "9999999",
    ]);
  });

  it("ignores short hashes and replies that don't claim a fix", () => {
    expect(citedShas("Fixed in abc12")).toEqual([]);
    expect(citedShas("See 1a2b3c4 for context")).toEqual([]);
  });
});

describe("noticeReasons", () => {
  const snap = {
    checks: "pending",
    verdict: undefined,
    reviewed: true,
    mergeState: "BLOCKED",
  } as const;

  it("wakes on a CI settle, a new verdict, or an actionable merge state", () => {
    expect(noticeReasons(snap, { ...snap, checks: "failing" })).toEqual(["ci"]);
    expect(noticeReasons(snap, { ...snap, verdict: "changesRequested" })).toEqual(["verdict"]);
    expect(noticeReasons(snap, { ...snap, mergeState: "DIRTY" })).toEqual(["merge"]);
    // Mergeable past a check nobody requires.
    expect(noticeReasons(snap, { ...snap, mergeState: "UNSTABLE" })).toEqual(["merge"]);
  });

  it("stays quiet for checks restarting, a verdict cleared by a push, or passing merge states", () => {
    expect(noticeReasons({ ...snap, checks: "passing" }, snap)).toEqual([]);
    expect(noticeReasons({ ...snap, verdict: "approved" }, snap)).toEqual([]);
    const clean = { ...snap, mergeState: "CLEAN" } as const;
    expect(noticeReasons(clean, { ...snap, mergeState: "UNSTABLE" })).toEqual([]);
    expect(noticeReasons({ ...snap, mergeState: "UNSTABLE" }, clean)).toEqual([]);
    // A verdict first read, after badges that didn't read the reviews, is a baseline.
    expect(
      noticeReasons({ ...snap, reviewed: false }, { ...snap, verdict: "changesRequested" }),
    ).toEqual([]);
    expect(
      noticeReasons({ ...snap, mergeState: undefined }, { ...snap, mergeState: "CLEAN" }),
    ).toEqual([]);
  });
});

describe("openFindings", () => {
  it("splits current unresolved bot threads into blockers and suggestions", () => {
    const review: PrReview = {
      available: true,
      threads: [
        thread({ id: "B", severity: "blocker" }),
        thread({ id: "O", severity: "outstanding" }),
        thread({ id: "S", severity: "suggestion" }),
        thread({ id: "F", severity: "finding" }),
        thread({ id: "R", severity: "blocker", isResolved: true }),
        thread({ id: "X", severity: "blocker", isOutdated: true }),
        thread({ id: "H", severity: "blocker", byBot: false }),
      ],
    };
    const { blockers, suggestions } = openFindings(review);
    expect(blockers.map((f) => f.reviewThreadId)).toEqual(["B", "O"]);
    expect(suggestions.map((f) => f.reviewThreadId)).toEqual(["S", "F"]);
    expect(blockers[0]).toEqual({
      reviewThreadId: "B",
      path: "src/app.ts",
      line: 3,
      body: "[suggestion] Name this.",
      url: "https://github.com/acme/web/pull/12#discussion_r1",
    });
  });
});

describe("pickBot", () => {
  const bots = [
    { loginPattern: "other-bot", rereviewCommand: "/other", canApprove: false },
    { loginPattern: "example-code-review", rereviewCommand: "/agent review", canApprove: true },
  ];

  it("prefers the configured bot that reviewed the PR", () => {
    expect(pickBot(bots, ["example-code-review[bot]"])?.rereviewCommand).toBe("/agent review");
    expect(pickBot(bots, [])?.rereviewCommand).toBe("/other");
    expect(pickBot([], ["example-code-review"])).toBeUndefined();
  });
});

describe("isReadyToMerge", () => {
  const approved = badge({
    mergeState: "CLEAN",
    review: {
      bots: ["example-code-review"],
      verdictOnHead: "approved",
      reviewedHead: true,
      roundInFlight: false,
      threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
    },
  });

  it("needs approval on head, green or no checks, and a clean merge state", () => {
    expect(isReadyToMerge(approved)).toBe(true);
    expect(isReadyToMerge({ ...approved, checks: "none" })).toBe(true);
    expect(isReadyToMerge({ ...approved, checks: "pending" })).toBe(false);
    expect(isReadyToMerge({ ...approved, mergeState: "BLOCKED" })).toBe(false);
    expect(isReadyToMerge(badge({ mergeState: "CLEAN" }))).toBe(false);
  });

  it("goes by the required checks, and merges past UNSTABLE when they pass", () => {
    const unstable = { ...approved, mergeState: "UNSTABLE" };
    expect(isReadyToMerge({ ...unstable, checks: "failing", requiredChecks: "passing" })).toBe(
      true,
    );
    expect(isReadyToMerge({ ...unstable, checks: "pending", requiredChecks: "passing" })).toBe(
      true,
    );
    expect(isReadyToMerge({ ...approved, checks: "failing", requiredChecks: "pending" })).toBe(
      false,
    );
    // Where GitHub wasn't asked which checks are required, every one of them is.
    expect(isReadyToMerge({ ...unstable, checks: "failing" })).toBe(false);
    for (const mergeState of ["BLOCKED", "BEHIND", "DIRTY"]) {
      expect(isReadyToMerge({ ...approved, mergeState, requiredChecks: "passing" })).toBe(false);
    }
  });
});

describe("rounds and disagreements", () => {
  it("counts a declined thread that stays open across a round as a disagreement", () => {
    const declined = markDeclined(markDeclined(state, "T1"), "T2");
    const afterRound = countRound(declined, new Set(["T1"]));
    expect(afterRound).toMatchObject({ rounds: 1, disagreements: { T1: 1 }, pendingDeclines: [] });
    expect(afterRound.declined).toEqual(["T1", "T2"]);
    expect(countRound(afterRound, new Set(["T1"])).disagreements).toEqual({ T1: 1 });
  });

  it("forgets a decline once the thread is fixed", () => {
    const fixed = markHandled(markDeclined(state, "T1"), "T1");
    expect(fixed).toMatchObject({ handled: ["T1"], declined: [], pendingDeclines: [] });
  });
});

describe("stopReasonOf", () => {
  it("stops for a closed or merged PR", () => {
    expect(stopReasonOf(state, badge({ state: "MERGED" }))?.reason).toBe("prMerged");
    expect(stopReasonOf(state, badge({ state: "CLOSED" }))?.reason).toBe("prClosed");
  });

  it("stops after two disagreement rounds on one thread", () => {
    expect(stopReasonOf({ ...state, disagreements: { T1: 1 } }, badge())).toBeUndefined();
    expect(stopReasonOf({ ...state, disagreements: { T1: 2 } }, badge())).toMatchObject({
      reason: "disagreement",
    });
  });

  it("stops once the round budget is used, unless head is already approved", () => {
    expect(stopReasonOf({ ...state, rounds: 5 }, badge())).toBeUndefined();
    expect(stopReasonOf({ ...state, rounds: 6 }, badge())?.reason).toBe("rounds");
    const approved = badge({
      review: {
        bots: [],
        verdictOnHead: "approved",
        reviewedHead: true,
        roundInFlight: false,
        threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
      },
    });
    expect(stopReasonOf({ ...state, rounds: 6 }, approved)).toBeUndefined();
    expect(stopReasonOf({ ...state, rounds: 6 }, badge({ reviewUnread: true }))).toBeUndefined();
  });
});

describe("checkDecision", () => {
  const build = failingCheck("build", "https://github.com/acme/web/actions/runs/99/job/1");

  it("reads the Actions run id from a check link", () => {
    expect(build).toEqual({ name: "build", runId: "99" });
    expect(failingCheck("lint", "https://organization.example.invalid/lint")).toEqual({
      name: "lint",
    });
  });

  it("reruns a check once, then reports it, then stops when it fails again on a later head", () => {
    const first = checkDecision(state, [build], HEAD_A);
    expect(first).toMatchObject({ rerun: [{ name: "build", runId: "99" }], real: [] });
    expect(first.stop).toBeUndefined();

    const second = checkDecision(first.state, [build], HEAD_A);
    expect(second).toMatchObject({ rerun: [], real: ["build"] });
    expect(second.state.failedChecks).toEqual({ build: HEAD_A });
    expect(checkDecision(second.state, [build], HEAD_A).stop).toBeUndefined();

    const third = checkDecision(second.state, [build], HEAD_B);
    expect(third.stop).toMatchObject({ reason: "checkFailedTwice" });
  });

  it("reports a check with no rerunnable run right away", () => {
    const lint = failingCheck("lint", "https://organization.example.invalid/lint");
    expect(checkDecision(state, [lint], HEAD_A)).toMatchObject({ rerun: [], real: ["lint"] });
  });
});

const reviewOf = (overrides: Partial<PrReviewState> = {}): PrReviewState => ({
  bots: ["example-code-review"],
  reviewedHead: true,
  roundInFlight: false,
  latestReviewId: "PRR_1",
  threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
  ...overrides,
});

describe("catching up", () => {
  const fresh = initialBabysitState(0);

  it("owes a round for a completed review it hasn't counted", () => {
    expect(uncountedReview(fresh, reviewOf())).toBe("PRR_1");
    expect(uncountedReview({ ...fresh, countedReviewId: "PRR_1" }, reviewOf())).toBeUndefined();
    expect(uncountedReview(fresh, reviewOf({ roundInFlight: true }))).toBeUndefined();
    expect(uncountedReview(fresh, undefined)).toBeUndefined();
  });

  it("takes an earlier review as work only when it asks for something on head", () => {
    expect(leavesWork(reviewOf({ verdictOnHead: "changesRequested" }))).toBe(true);
    expect(leavesWork(reviewOf({ threads: { ...reviewOf().threads, unresolved: 1 } }))).toBe(true);
    expect(leavesWork(reviewOf({ verdictOnHead: "approved" }))).toBe(false);
    expect(
      leavesWork(
        reviewOf({ reviewedHead: false, threads: { ...reviewOf().threads, unresolved: 1 } }),
      ),
    ).toBe(false);
  });

  it("reads a round event's id when the badge still names the counted review", () => {
    const counted = { ...fresh, countedReviewId: "PRR_1" };
    expect(uncountedReview(counted, reviewOf(), "PRR_2")).toBe("PRR_2");
    expect(uncountedReview(counted, reviewOf(), "PRR_1")).toBeUndefined();
  });

  it("owes the review already there at kick-off only until something is counted", () => {
    const kickoff = { ...fresh, existingReviewId: "PRR_1" };
    expect(uncountedReview(kickoff, reviewOf())).toBe("PRR_1");
    const later = { ...kickoff, countedReviewId: "PRR_2" };
    expect(uncountedReview(later, reviewOf(), "PRR_3")).toBe("PRR_3");
    expect(uncountedReview(later, reviewOf())).toBeUndefined();
  });

  it("doesn't take outdated threads as work", () => {
    const threads = { ...reviewOf().threads, unresolved: 2, outdatedUnresolved: 2 };
    expect(leavesWork(reviewOf({ threads }))).toBe(false);
    expect(leavesWork(reviewOf({ threads: { ...threads, unresolved: 3 } }))).toBe(true);
  });

  it("knows a failure as reported by check, not by head", () => {
    const reported = { ...fresh, failedChecks: { build: HEAD_A } };
    const build = failingCheck("build", "https://organization.example.invalid/b");
    const lint = failingCheck("lint", "https://organization.example.invalid/l");
    expect(alreadyReported(reported, [build], HEAD_A)).toBe(true);
    expect(alreadyReported(reported, [build, lint], HEAD_A)).toBe(false);
    expect(alreadyReported(reported, [build], HEAD_B)).toBe(false);
    expect(alreadyReported(reported, [], HEAD_A)).toBe(false);
  });
});

describe("buildReport", () => {
  it("lists the declined findings and never claims a merge", () => {
    const review: PrReview = { available: true, threads: [thread({ id: "T1" })] };
    const report = buildReport(
      { ...markDeclined(state, "T1"), rounds: 3, handled: ["T2", "T3"] },
      badge({ mergeState: "CLEAN" }),
      review,
    );
    expect(report).toMatchObject({
      number: 12,
      headRefOid: HEAD_A,
      checks: "passing",
      mergeState: "CLEAN",
      rounds: 3,
      handled: 2,
      merged: false,
    });
    expect(report.declined.map((f) => f.reviewThreadId)).toEqual(["T1"]);
  });
});
