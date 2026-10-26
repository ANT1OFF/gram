const REVIEW_BOT_FIXTURE = [
  { loginPattern: "example-code-review[bot]", rereviewCommand: "/agent review", canApprove: true },
];
import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";

import {
  buildLatestReview,
  buildReviewState,
  buildReviewThreads,
  extractSuggestion,
  isRoundInFlight,
  matchesBotLogin,
  parseMeta,
  parseSeverity,
  stripMeta,
} from "./review.ts";

const bots = REVIEW_BOT_FIXTURE;

const bot = (body: string) => ({ author: { login: "example-code-review" }, body });

const person = (body: string) => ({ author: { login: "octocat" }, body });

const reviewThread = (
  isResolved: boolean,
  first: { author: { login: string; __typename?: string }; body: string },
) => ({
  isResolved,
  isOutdated: false,
  comments: { nodes: [first] },
});

const review = (id: string, login: string, state: string, body = "", typename = "User") => ({
  id,
  author: { login, __typename: typename },
  state,
  submittedAt: `2026-09-25T10:0${id.slice(-1)}:00Z`,
  commit: { oid: "h1" },
  body,
});

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/review-bot/${name}.json`, import.meta.url), "utf8"))
    .data.repository.pullRequest;

describe("bot logins", () => {
  it("match GraphQL and REST spellings, case-insensitively, with wildcards", () => {
    expect(matchesBotLogin("example-code-review[bot]", "example-code-review")).toBe(true);
    expect(matchesBotLogin("example-code-review[bot]", "example-code-review[bot]")).toBe(true);
    expect(matchesBotLogin("EXAMPLE-Code-Review", "example-code-review[bot]")).toBe(true);
    expect(matchesBotLogin("*-code-review[bot]", "acme-code-review")).toBe(true);
    expect(matchesBotLogin("example-code-review[bot]", "example-code-reviewer")).toBe(false);
    expect(matchesBotLogin("", "example-code-review")).toBe(false);
  });
});

describe("severity tags", () => {
  it("parse the tag forms the bot uses and tolerate untagged comments", () => {
    expect(parseSeverity("[blocker] These irreversible posting tools execute")).toBe("blocker");
    expect(parseSeverity("`[blocker]` backticked")).toBe("blocker");
    expect(parseSeverity("**[Suggestion]** bold")).toBe("suggestion");
    expect(parseSeverity("[Still outstanding] The retry still")).toBe("outstanding");
    expect(parseSeverity("Still outstanding: the uid lookup")).toBe("outstanding");
    expect(parseSeverity("Malformed two-part tokens can escape")).toBeUndefined();
    expect(parseSeverity("See [blocker] later in the text")).toBeUndefined();
  });
});

describe("meta and suggestions", () => {
  it("parse the meta comment, ignore unknown keys, and strip it from the body", () => {
    const body =
      "Re-reviewed; fine.\n\n<!-- code-review-meta: model=openai/gpt-5.6-sol effort=medium strictness=rigorous scope=interdiff round=3 -->";
    expect(parseMeta(body)).toEqual({
      model: "openai/gpt-5.6-sol",
      effort: "medium",
      strictness: "rigorous",
      scope: "interdiff",
    });
    expect(stripMeta(body)).toBe("Re-reviewed; fine.");
    expect(parseMeta("no meta")).toBeUndefined();
    expect(parseMeta("<!-- code-review-meta: garbage -->")).toEqual({});
  });

  it("strips every meta comment, and leaves an unclosed one alone", () => {
    expect(stripMeta("a <!-- code-review-meta: x=1 --> b <!--code-review-meta: y=2--> c")).toBe(
      "a  b  c",
    );
    expect(stripMeta("a <!-- code-review-meta: x=1")).toBe("a <!-- code-review-meta: x=1");
    expect(parseMeta("a <!-- code-review-meta: x=1")).toBeUndefined();
  });

  it("stays linear on a body that opens the meta comment many times and never closes it", () => {
    const body = "<!--code-review-meta:a".repeat(200_000);
    const started = performance.now();
    expect(parseMeta(body)).toBeUndefined();
    expect(stripMeta(body)).toBe(body);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("scans repeated suggestion openers with no newline or closing fence", () => {
    const repeated = "```suggestion".repeat(100_000);
    const started = performance.now();
    expect(extractSuggestion(repeated)).toBeUndefined();
    expect(extractSuggestion(`${repeated}\nunclosed`)).toBeUndefined();
    expect(extractSuggestion(`${repeated}\nline\n\n\`\`\``)).toBe("line\n");
    expect(extractSuggestion("```suggestion:-1+2\r\ncode\r\n``` trailing")).toBe("code\r");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("extract suggestion blocks, including deletions", () => {
    expect(
      extractSuggestion('[suggestion] Hint.\n\n```suggestion\n    "openWorldHint": True,\n```'),
    ).toBe('    "openWorldHint": True,');
    expect(extractSuggestion("Delete it.\n```suggestion\n```")).toBe("");
    expect(extractSuggestion("no block")).toBeUndefined();
  });

  it("detect an in-flight round from the latest bot progress comment", () => {
    const running = bot(
      '### Code review <img src="x" alt="Reviewing..." width="16"/>\n\nReviewing this PR...',
    );
    const done = bot("### Code review :white_check_mark:\n\nDone in 1 min 26 s");
    expect(isRoundInFlight([done, running], bots)).toBe(true);
    expect(isRoundInFlight([running, done], bots)).toBe(false);
    expect(
      isRoundInFlight([bot('<img alt="Reviewing..."/> _Responding to comment..._')], bots),
    ).toBe(true);
    expect(isRoundInFlight([{ author: { login: "human-1" }, body: running.body }], bots)).toBe(
      false,
    );
    expect(isRoundInFlight([], bots)).toBe(false);
  });
});

describe("review state from synthetic bot scenarios", () => {
  it("blockers: changes requested on head, outstanding blockers and suggestions counted", () => {
    const node = fixture("changes-requested");
    const state = buildReviewState(node, bots);
    expect(state).toMatchObject({
      bots: ["example-code-review"],
      verdictOnHead: "changesRequested",
      latestVerdict: "changesRequested",
      reviewedHead: true,
      roundInFlight: false,
    });
    expect(state?.threads).toEqual({
      unresolved: 7,
      blockers: 2,
      suggestions: 4,
      outdatedUnresolved: 5,
    });
    expect(state?.latestReviewId).toBeTruthy();

    const latest = buildLatestReview(node, bots);
    expect(latest).toMatchObject({
      verdict: "changesRequested",
      onHead: true,
      meta: { scope: "interdiff" },
    });
    expect(latest?.body).not.toContain("code-review-meta");

    const threads = buildReviewThreads(node, bots);
    expect(threads).toHaveLength(8);
    expect(threads.every((t) => t.byBot)).toBe(true);
    expect(threads.filter((t) => t.severity === "finding")).toHaveLength(1);
    expect(threads.some((t) => t.comments.some((c) => c.suggestion !== undefined))).toBe(true);
  });

  it("counts people's unresolved threads apart from the bot's, even with no bot on the PR", () => {
    const node = {
      headRefOid: "abc",
      reviews: { nodes: [] },
      comments: { nodes: [] },
      reviewThreads: {
        nodes: [
          reviewThread(false, bot("[blocker] Rethrow the last error.")),
          reviewThread(false, person("Why a fake clock here?")),
          reviewThread(false, person("Rename this.")),
          reviewThread(true, person("Typo.")),
          reviewThread(false, {
            author: { login: "dependabot", __typename: "Bot" },
            body: "Bump.",
          }),
        ],
      },
    };
    expect(buildReviewState(node, bots)?.threads).toEqual({
      unresolved: 1,
      blockers: 1,
      suggestions: 0,
      outdatedUnresolved: 0,
      humanUnresolved: 2,
    });

    const peopleOnly = { ...node, reviewThreads: { nodes: node.reviewThreads.nodes.slice(1) } };
    expect(buildReviewState(peopleOnly, bots)).toEqual({
      bots: [],
      reviewedHead: false,
      roundInFlight: false,
      threads: {
        unresolved: 0,
        blockers: 0,
        suggestions: 0,
        outdatedUnresolved: 0,
        humanUnresolved: 2,
      },
    });
    const allResolved = {
      ...node,
      reviewThreads: { nodes: [reviewThread(true, person("Typo."))] },
    };
    expect(buildReviewState(allResolved, bots)).toBeUndefined();
  });

  it("carries each person's standing verdict: not a bot's, an App's, the author's or a comment", () => {
    const node = {
      headRefOid: "h1",
      reviews: {
        nodes: [
          review("r1", "alice", "CHANGES_REQUESTED", "Needs a test."),
          review("r2", "alice", "APPROVED", ` ${"x".repeat(1200)} `),
          review("r3", "alice", "COMMENTED", "One more thought."),
          review("r4", "bob", "APPROVED"),
          review("r5", "bob", "DISMISSED"),
          review("r6", "carol", "COMMENTED", "Just a comment."),
          review("r7", "me", "APPROVED"),
          review("r8", "example-code-review", "APPROVED", "LGTM"),
          review("r9", "copilot-reviewer", "CHANGES_REQUESTED", "Hm.", "Bot"),
        ],
      },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
    };
    const state = buildReviewState(node, bots, "me");
    expect(state?.humanReviews).toEqual([
      {
        id: "r2",
        author: "alice",
        verdict: "approved",
        commitOid: "h1",
        submittedAt: "2026-09-25T10:02:00Z",
        body: `${"x".repeat(1000)}…`,
      },
    ]);
    // The bot's verdict is the bot's alone.
    expect(state).toMatchObject({ verdictOnHead: "approved", latestReviewId: "r8" });

    const peopleOnly = { ...node, reviews: { nodes: node.reviews.nodes.slice(0, 1) } };
    expect(buildReviewState(peopleOnly, bots, "me")).toMatchObject({
      bots: [],
      humanReviews: [{ id: "r1", verdict: "changesRequested", body: "Needs a test." }],
    });
    const authorOnly = { ...node, reviews: { nodes: node.reviews.nodes.slice(6, 7) } };
    expect(buildReviewState(authorOnly, bots, "me")).toBeUndefined();
  });

  it("suggestions only: a COMMENTED bot review gives no verdict on head", () => {
    const state = buildReviewState(fixture("commented"), bots);
    expect(state).toMatchObject({ latestVerdict: "commented", reviewedHead: true });
    expect(state?.verdictOnHead).toBeUndefined();
    expect(state?.threads).toEqual({
      unresolved: 0,
      blockers: 0,
      suggestions: 0,
      outdatedUnresolved: 0,
    });
  });

  it("approved on head after a re-review", () => {
    const node = fixture("approved");
    expect(buildReviewState(node, bots)).toMatchObject({
      verdictOnHead: "approved",
      latestVerdict: "approved",
      reviewedHead: true,
    });
    expect(buildLatestReview(node, bots)).toMatchObject({
      verdict: "approved",
      meta: { effort: "high" },
    });
  });

  it("a comment-only bot leaves untagged findings and no verdict", () => {
    const node = fixture("findings");
    const state = buildReviewState(node, bots);
    expect(state?.verdictOnHead).toBeUndefined();
    expect(state?.latestVerdict).toBe("commented");
    expect(state?.threads.unresolved).toBe(3);
    expect(state?.threads.blockers).toBe(0);
    const threads = buildReviewThreads(node, bots);
    expect(
      threads.filter((t) => t.comments.some((c) => c.suggestion !== undefined)).length,
    ).toBeGreaterThan(0);
  });

  it("reports no bot state when no configured bot is involved, only open threads as reviewers'", () => {
    const node = fixture("findings");
    const state = buildReviewState(node, [
      { loginPattern: "other-bot", rereviewCommand: "/review", canApprove: false },
    ]);
    expect(state).toMatchObject({ bots: [], reviewedHead: false, roundInFlight: false });
    expect(state?.verdictOnHead).toBeUndefined();
    expect(state?.latestReviewId).toBeUndefined();
    expect(state?.threads).toMatchObject({ unresolved: 0, blockers: 0, suggestions: 0 });
    expect(state?.threads.humanUnresolved).toBeGreaterThan(0);
  });
});

describe("configured bot approval eligibility", () => {
  it("tracks comment-only bot rounds without granting approval", () => {
    const node = {
      headRefOid: "h1",
      reviews: { nodes: [review("R1", "example-code-review", "APPROVED", "Reviewed this head.")] },
    };
    expect(buildReviewState(node, [{ ...bots[0]!, canApprove: false }])).toMatchObject({
      reviewedHead: true,
      latestVerdict: "approved",
    });
    expect(
      buildReviewState(node, [{ ...bots[0]!, canApprove: false }])?.verdictOnHead,
    ).toBeUndefined();
    expect(buildReviewState(node, bots)).toMatchObject({
      verdictOnHead: "approved",
      verdictOnHeadBy: "example-code-review",
    });
  });
  it("retains the decisive approver when another eligible bot only comments", () => {
    const node = {
      headRefOid: "h1",
      reviews: {
        nodes: [
          review("R1", "example-code-review", "APPROVED", "Reviewed."),
          review("R2", "comment-bot", "COMMENTED", "Suggestion."),
        ],
      },
    };
    const state = buildReviewState(node, [...bots, { ...bots[0]!, loginPattern: "comment-bot" }]);
    expect(state).toMatchObject({
      bots: ["example-code-review", "comment-bot"],
      verdictOnHead: "approved",
      verdictOnHeadBy: "example-code-review",
      latestVerdict: "commented",
    });
  });
});
