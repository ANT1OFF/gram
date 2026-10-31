import {
  ArrowDown,
  Ban,
  Bot,
  BotMessageSquare,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CirclePause,
  CircleX,
  GitMerge,
  GitMergeConflict,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link2,
  MessageSquare,
  MessageSquareWarning,
  OctagonX,
  Timer,
  UserRoundCheck,
  UserRoundSearch,
  Wrench,
} from "lucide-react";
import { describe, expect, it } from "vitest";

import { RingSpinner } from "@/motion/spinner";

import {
  BOT_DISPLAY,
  CHECKS_DISPLAY,
  checksMarkOf,
  diffText,
  MERGE_DISPLAY,
  mergeMarkOf,
  mergeMarksOf,
  mergeWaitsOn,
  PR_STATE_DISPLAY,
  prLifecycleOf,
  prMarksOf,
  worstPrMark,
  prRefText,
  prStateMarkOf,
  prTooltipOf,
  REVIEW_DISPLAY,
  reviewMarkOf,
  reviewThreadsMarkOf,
  type BotMarkKind,
  type ChecksMarkKind,
  type MergeMarkKind,
  type MergeSource,
  type PrLifecycle,
  type ReviewMarkKind,
} from "./pr-marks-model";

describe("PR state marks", () => {
  it.each([
    [{ state: "OPEN" }, "open", GitPullRequest, "text-success"],
    [{ state: "open" }, "open", GitPullRequest, "text-success"],
    [{ state: "OPEN", isDraft: true }, "draft", GitPullRequestDraft, "text-muted-foreground"],
    [{ state: "MERGED" }, "merged", GitMerge, "text-merged"],
    [{ state: "merged" }, "merged", GitMerge, "text-merged"],
    [{ state: "CLOSED" }, "closed", GitPullRequestClosed, "text-destructive"],
    [{ state: "closed", isDraft: true }, "closed", GitPullRequestClosed, "text-destructive"],
    [{}, "open", GitPullRequest, "text-success"],
  ] as const)("%o is %s", (source, kind, icon, tone) => {
    expect(prLifecycleOf(source)).toBe(kind);
    expect(PR_STATE_DISPLAY[kind]).toEqual({ icon, tone });
  });

  it("a merged or closed PR of a reused branch name reads as open, not as a phantom merge", () => {
    expect(prLifecycleOf({ state: "MERGED", headMatches: false })).toBe("open");
    expect(prLifecycleOf({ state: "CLOSED", headMatches: false, isDraft: true })).toBe("draft");
  });

  it("names every state in a word", () => {
    const words = (["open", "draft", "merged", "closed"] as const satisfies PrLifecycle[]).map(
      (kind) =>
        prStateMarkOf({
          state: kind === "draft" ? "open" : kind,
          isDraft: kind === "draft",
        }).word,
    );
    expect(words).toEqual(["Open", "Draft", "Merged", "Closed"]);
  });
});

describe("checks marks", () => {
  it.each([
    ["pending", RingSpinner, "text-status-working", "Checks running"],
    ["passing", CircleCheck, "text-success", "Checks passing"],
    ["failing", CircleX, "text-destructive", "Checks failing"],
    ["fixing", Wrench, "text-status-working", "Checks failing; its worker is fixing them"],
    ["none", CircleMinus, "text-muted-foreground", "No checks"],
    ["unknown", CircleHelp, "text-muted-foreground", "Checks unknown"],
  ] as const satisfies readonly (readonly [ChecksMarkKind, unknown, string, string])[])(
    "%s",
    (kind, icon, tone, detail) => {
      expect(CHECKS_DISPLAY[kind]).toEqual({ icon, tone });
      const rollup = kind === "fixing" ? "failing" : kind === "unknown" ? undefined : kind;
      expect(checksMarkOf(rollup, { fixing: kind === "fixing" })).toMatchObject({ kind, detail });
    },
  );

  it("failing CI its worker owns is fixing, informational rather than red", () => {
    expect(checksMarkOf("failing", { fixing: true }).kind).toBe("fixing");
    expect(CHECKS_DISPLAY.fixing.tone).not.toBe("text-destructive");
    // Ownership changes nothing for checks that aren't failing.
    expect(checksMarkOf("passing", { fixing: true }).kind).toBe("passing");
  });

  it("says when the checks shown are the required ones", () => {
    expect(checksMarkOf("failing", { required: true }).detail).toBe("Required checks failing");
    expect(checksMarkOf("none", { required: true }).detail).toBe("No checks");
  });
});

describe("review marks", () => {
  it.each([
    ["waiting", UserRoundSearch, "text-muted-foreground"],
    ["approved", UserRoundCheck, "text-success"],
    ["changes", MessageSquareWarning, "text-warning"],
    ["threads", MessageSquare, "text-warning"],
  ] as const satisfies readonly (readonly [ReviewMarkKind, unknown, string])[])(
    "%s",
    (kind, icon, tone) => {
      expect(REVIEW_DISPLAY[kind]).toEqual({ icon, tone });
    },
  );

  it("reads GitHub's decision and who is asked", () => {
    expect(reviewMarkOf({ reviewDecision: "APPROVED" })).toMatchObject({ kind: "approved" });
    expect(
      reviewMarkOf({ reviewDecision: "CHANGES_REQUESTED", changesRequestedBy: ["ada"] }),
    ).toMatchObject({ kind: "changes", detail: "Changes requested by ada" });
    expect(reviewMarkOf({ reviewDecision: "REVIEW_REQUIRED" })).toMatchObject({
      kind: "waiting",
      detail: "Waiting on an approving review",
    });
    expect(
      reviewMarkOf({ reviewRequests: [{ name: "ada" }, { name: "acme/api-team" }] }),
    ).toMatchObject({ kind: "waiting", detail: "Waiting on ada, acme/api-team" });
    expect(reviewMarkOf({})).toBeUndefined();
  });

  it("counts people's open threads", () => {
    expect(reviewThreadsMarkOf(0)).toBeUndefined();
    expect(reviewThreadsMarkOf(2)).toMatchObject({ kind: "threads", word: "2 threads" });
  });

  it.each([
    ["quiet", Bot, "text-muted-foreground"],
    ["inFlight", RingSpinner, "text-muted-foreground"],
    ["blockers", Bot, "text-destructive"],
    ["approved", BotMessageSquare, "text-success"],
    ["changesRequested", Bot, "text-destructive"],
    ["findings", Bot, "text-warning"],
    ["reviewerThreads", MessageSquare, "text-warning"],
  ] as const satisfies readonly (readonly [BotMarkKind, unknown, string])[])(
    "the review bot's %s",
    (kind, icon, tone) => {
      expect(BOT_DISPLAY[kind]).toEqual({ icon, tone });
    },
  );
});

describe("merge marks", () => {
  const open: MergeSource = { state: "OPEN", baseRef: "main" };

  it.each([
    ["conflicts", GitMergeConflict, "text-destructive"],
    ["refused", OctagonX, "text-destructive"],
    ["held", CirclePause, "text-muted-foreground"],
    ["waiting", Link2, "text-muted-foreground"],
    ["behind", ArrowDown, "text-warning"],
    ["blocked", Ban, "text-warning"],
    ["unstable", CircleAlert, "text-warning"],
    ["armed", Timer, "text-merged"],
    ["mergeable", GitMerge, "text-success"],
  ] as const satisfies readonly (readonly [MergeMarkKind, unknown, string])[])(
    "%s",
    (kind, icon, tone) => {
      expect(MERGE_DISPLAY[kind]).toEqual({ icon, tone });
    },
  );

  it.each([
    [{ mergeState: "DIRTY" }, "conflicts", "Conflicts with main"],
    [{ intent: { refused: true } }, "refused", "GitHub refused the merge of this head"],
    [
      { intent: { hold: "after the release", heldBy: "orchestrator" } },
      "held",
      "Merge held by the orchestrator: after the release",
    ],
    [{ intent: { hold: "until Monday" } }, "held", "Merge held: until Monday"],
    [
      { intent: { after: [{ repo: "acme/api", number: 9 }] } },
      "waiting",
      "Merges after acme/api#9",
    ],
    [
      { dependsOn: [{ repo: "acme/api", number: 9, state: "open" }] },
      "waiting",
      "Depends on acme/api#9",
    ],
    [{ mergeState: "BEHIND" }, "behind", "Behind main"],
    [{ mergeState: "BLOCKED" }, "blocked", "Required reviews or checks are missing"],
    [{ mergeState: "UNSTABLE" }, "unstable", "Checks that aren't required are failing"],
    [{ intent: {} }, "armed", "Merges when ready"],
    [{ mergeState: "CLEAN" }, "mergeable", "Can merge into main"],
    [{ mergeState: "HAS_HOOKS" }, "mergeable", "Can merge into main"],
  ] as const)("%o is %s", (more, kind, detail) => {
    const mark = mergeMarkOf({ ...open, ...more });
    expect(mark?.kind).toBe(kind);
    expect(mark?.detail.split("\n")[0]).toContain(detail);
  });

  it("says nothing for a settled or draft PR, or an open one with nothing to say", () => {
    const intent = { hold: "x" };
    expect(mergeMarkOf({ state: "MERGED", intent })).toBeUndefined();
    expect(mergeMarkOf({ state: "CLOSED", intent })).toBeUndefined();
    expect(mergeMarkOf({ state: "OPEN", isDraft: true, intent })).toBeUndefined();
    expect(mergeMarkOf({ state: "OPEN", mergeState: "UNKNOWN" })).toBeUndefined();
  });

  it("shows the worst and tells every fact in its detail", () => {
    const pr: MergeSource = {
      ...open,
      mergeState: "DIRTY",
      intent: { hold: "after the release", after: [{ repo: "acme/api", number: 9 }] },
      dependsOn: [{ repo: "acme/api", number: 9 }],
    };
    expect(mergeMarksOf(pr).map((mark) => mark.kind)).toEqual([
      "conflicts",
      "held",
      "waiting",
      "armed",
    ]);
    expect(mergeMarkOf(pr)).toEqual({
      kind: "conflicts",
      word: "Conflicts",
      detail:
        "Conflicts with main\nMerge held: after the release\nMerges after acme/api#9\nMerges when ready",
    });
  });

  it("an armed merge isn't called blocked: it waits that out", () => {
    expect(mergeMarksOf({ ...open, mergeState: "BLOCKED", intent: {} }).map((m) => m.kind)).toEqual(
      ["armed"],
    );
  });

  it("waits on dependencies not known settled, each once, and only those a merge waits for", () => {
    const pr: MergeSource = {
      ...open,
      intent: { after: [{ repo: "Acme/API", number: 9 }] },
      dependsOn: [
        { repo: "acme/api", number: 9 },
        { repo: "acme/api", number: 10, state: "merged" },
        { repo: "acme/api", number: 11, mergeAfter: false },
        { repo: "acme/web", number: 12, state: "open" },
      ],
    };
    expect(mergeWaitsOn(pr)).toEqual([
      { repo: "Acme/API", number: 9 },
      { repo: "acme/web", number: 12 },
    ]);
    // Without an armed merge, any open dependency still holds the work.
    expect(
      mergeWaitsOn({ ...open, dependsOn: [{ repo: "acme/api", number: 11, mergeAfter: false }] }),
    ).toEqual([{ repo: "acme/api", number: 11 }]);
  });
});

describe("a whole PR", () => {
  it("names it as owner/repo#N, or compact", () => {
    expect(prRefText({ repo: "acme/api", number: 214 })).toBe("acme/api#214");
    expect(prRefText({ repo: "acme/api", number: 214 }, { compact: true })).toBe("api#214");
  });

  it("measures its diff in what is known", () => {
    expect(diffText({ additions: 1200, deletions: 14, changedFiles: 6 })).toBe(
      "+1,200 −14 · 6 files",
    );
    expect(diffText({ changedFiles: 1 })).toBe("1 file");
    expect(diffText({})).toBeUndefined();
  });

  it("an open PR shows its checks, people, bot and merge; a settled one its state only", () => {
    const pr = {
      repo: "acme/api",
      number: 214,
      title: "Retry the queue",
      branch: "feat/queue-retry",
      state: "OPEN",
      checks: "failing",
      requiredChecks: "failing",
      ciFixing: true,
      reviewDecision: "APPROVED",
      peopleThreads: 1,
      bot: { kind: "findings", label: "Review bot: 2 open findings", text: "2 findings" },
      intent: {},
      additions: 3,
      deletions: 1,
    } as const;
    const marks = prMarksOf(pr);
    expect(marks.state.kind).toBe("open");
    expect(marks.checks).toMatchObject({
      kind: "fixing",
      detail: expect.stringMatching(/^Required/),
    });
    expect(marks.review?.kind).toBe("approved");
    expect(marks.threads?.kind).toBe("threads");
    expect(marks.bot?.kind).toBe("findings");
    expect(marks.merge?.kind).toBe("armed");
    expect(prTooltipOf(pr)).toBe(
      [
        "acme/api#214 Retry the queue",
        "Branch feat/queue-retry",
        "Open",
        "Required checks failing; its worker is fixing them",
        "Approved",
        "Reviewers: 1 open thread",
        "Review bot: 2 open findings",
        "Merges when ready",
        "+3 −1",
      ].join("\n"),
    );
    const merged = prMarksOf({ ...pr, state: "MERGED" });
    expect(merged.state.kind).toBe("merged");
    expect([merged.checks, merged.review, merged.threads, merged.bot, merged.merge]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("leaves unknown checks unmarked rather than guessing", () => {
    expect(prMarksOf({ repo: "acme/api", number: 1, state: "OPEN" }).checks).toBeUndefined();
  });
});

const worst = (pr: Parameters<typeof prMarksOf>[0]) => {
  const { group, mark } = worstPrMark(prMarksOf(pr));
  return `${group}:${mark.kind}`;
};

describe("worstPrMark", () => {
  const open = { repo: "acme/api", number: 1, state: "OPEN" } as const;
  it("takes failing over changes requested, over a review, over ok", () => {
    const review = { reviewDecision: "REVIEW_REQUIRED" } as const;
    const changes = { reviewDecision: "CHANGES_REQUESTED" } as const;
    expect(worst({ ...open, ...changes, checks: "failing" })).toBe("checks:failing");
    expect(worst({ ...open, ...changes, checks: "passing" })).toBe("review:changes");
    expect(worst({ ...open, ...review, checks: "passing" })).toBe("review:waiting");
    expect(worst({ ...open, checks: "passing" })).toBe("state:open");
    expect(worst({ ...open, reviewDecision: "APPROVED", checks: "passing" })).toBe("state:open");
  });

  it("counts conflicts as failing, the bot's asks as changes and threads as a review", () => {
    expect(worst({ ...open, mergeState: "DIRTY", reviewDecision: "CHANGES_REQUESTED" })).toBe(
      "merge:conflicts",
    );
    const blockers = { kind: "blockers", label: "1 blocker", text: "1 blocker" } as const;
    expect(worst({ ...open, bot: blockers, reviewDecision: "REVIEW_REQUIRED" })).toBe(
      "bot:blockers",
    );
    expect(worst({ ...open, peopleThreads: 2 })).toBe("threads:threads");
  });

  it("leaves checks still running to the tooltip, and a draft to its state", () => {
    expect(worst({ ...open, checks: "pending" })).toBe("state:open");
    expect(worst({ ...open, isDraft: true })).toBe("state:draft");
  });
});
