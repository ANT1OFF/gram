import type { PrReviewState } from "@gram/contracts";
import {
  CircleX,
  GitMerge,
  GitMergeConflict,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquareWarning,
} from "lucide-react";
import { describe, expect, it } from "vitest";

import {
  PR_GLYPH_DISPLAY,
  prGlyphLabel,
  prGlyphOf,
  prGlyphWords,
  worstPrGlyph,
  type PrGlyphKind,
  type PrGlyphSource,
} from "./pr-glyph-model";
import { botAsksChanges, CHECKS_DISPLAY } from "./pr-marks-model";
import { reviewStatusOf } from "./review-glyph";

const open: PrGlyphSource = {
  state: "OPEN",
  isDraft: false,
  headMatches: true,
  checks: "passing",
  mergeState: "CLEAN",
};

describe("prGlyphOf", () => {
  it.each<[string, PrGlyphSource | undefined, PrGlyphKind, string]>([
    ["checks passing and nothing in the way", open, "ready", "Ready"],
    ["no checks at all", { ...open, checks: "none" }, "ready", "Ready"],
    ["checks still running", { ...open, checks: "pending" }, "pending", "Checks running"],
    [
      "a review still needed",
      { ...open, reviewDecision: "REVIEW_REQUIRED" },
      "open",
      "Review required",
    ],
    [
      "behind a base that requires up-to-date",
      { ...open, mergeState: "BEHIND" },
      "open",
      "Out of date",
    ],
    ["blocked by branch protection", { ...open, mergeState: "BLOCKED" }, "open", "Blocked"],
    ["checks not looked up yet", { ...open, checks: undefined }, "open", "Open"],
    ["checks failing", { ...open, checks: "failing" }, "failing", "Checks failing"],
    [
      "a person's change request",
      { ...open, reviewDecision: "CHANGES_REQUESTED" },
      "changes",
      "Changes requested",
    ],
    [
      "a review bot's change request",
      { ...open, bot: { kind: "changesRequested" } },
      "changes",
      "Changes requested",
    ],
    ["conflicts with its base", { ...open, mergeState: "DIRTY" }, "conflicts", "Conflicts"],
    ["a draft", { ...open, isDraft: true, checks: "failing" }, "draft", "Draft"],
    ["merged", { ...open, state: "MERGED" }, "merged", "Merged"],
    ["closed", { ...open, state: "CLOSED" }, "closed", "Closed"],
    ["no badge yet", undefined, "unknown", "Status unknown"],
  ])("%s", (_, pr, kind, word) => {
    expect(prGlyphOf(pr)).toEqual({ kind, word });
  });

  it("puts failing checks before a change request, and that before conflicts", () => {
    const everything: PrGlyphSource = {
      ...open,
      checks: "failing",
      reviewDecision: "CHANGES_REQUESTED",
      mergeState: "DIRTY",
    };
    expect(prGlyphOf(everything).kind).toBe("failing");
    expect(prGlyphOf({ ...everything, checks: "passing" }).kind).toBe("changes");
    expect(prGlyphOf({ ...everything, checks: "passing", reviewDecision: undefined }).kind).toBe(
      "conflicts",
    );
  });

  it("goes by the required checks where GitHub marks any", () => {
    expect(prGlyphOf({ ...open, checks: "failing", requiredChecks: "passing" }).kind).toBe("ready");
    expect(prGlyphOf({ ...open, checks: "passing", requiredChecks: "failing" }).kind).toBe(
      "failing",
    );
  });

  it("paints no merge or close on a branch whose name a PR merely shares", () => {
    expect(prGlyphOf({ ...open, state: "MERGED", headMatches: false }).kind).toBe("ready");
    expect(prGlyphOf({ ...open, state: "CLOSED", headMatches: false }).kind).toBe("ready");
  });

  it("reads a ledger card's lower-case state as a badge's", () => {
    expect(prGlyphOf({ state: "merged", checks: "passing" }).kind).toBe("merged");
    expect(prGlyphOf({ state: "open", checks: "failing" }).kind).toBe("failing");
  });

  it("says what an armed or held merge waits on, as its merge marks do", () => {
    const armed = { ...open, mergeState: "BLOCKED", intent: {} };
    expect(prGlyphOf(armed)).toEqual({ kind: "open", word: "Merges when ready" });
    expect(prGlyphOf({ ...armed, intent: { hold: "release" } }).word).toBe("Held");
  });
});

describe("one glyph everywhere", () => {
  // A check nobody requires is failing: GitHub would merge, so the badge, the PR strip, the
  // sidebar and the lists all say ready, where the strip used to draw it red.
  const windowsRed: PrGlyphSource = { ...open, checks: "failing", requiredChecks: "passing" };

  it("goes by the required checks in its kind and its words alike", () => {
    expect(prGlyphOf(windowsRed)).toEqual({ kind: "ready", word: "Ready" });
    expect(prGlyphWords(windowsRed)).toBe("Ready, checks passing");
    expect(prGlyphLabel(7, windowsRed)).toBe("PR #7 ready, checks passing");
    expect(prGlyphWords({ ...windowsRed, requiredChecks: "pending" })).toBe("Checks running");
  });

  it("says failing CI its worker fixes in place of the plain words", () => {
    const red: PrGlyphSource = { ...open, checks: "failing" };
    expect(prGlyphWords(red)).toBe("Checks failing");
    expect(prGlyphLabel(7, red, { fixing: true })).toBe(
      "PR #7 checks failing; its worker is fixing them",
    );
    expect(prGlyphLabel(7, { ...red, isDraft: true }, { fixing: true })).toBe(
      "PR #7 draft, checks failing; its worker is fixing them",
    );
  });
});

describe("PR_GLYPH_DISPLAY", () => {
  it.each<[PrGlyphKind, unknown, string]>([
    ["ready", GitPullRequest, "text-success"],
    ["open", GitPullRequest, "text-success"],
    // Trouble shows as its own mark from the PR vocabulary, so a closed PR keeps its shape alone.
    ["failing", CircleX, "text-destructive"],
    ["changes", MessageSquareWarning, "text-warning"],
    ["conflicts", GitMergeConflict, "text-destructive"],
    ["draft", GitPullRequestDraft, "text-muted-foreground"],
    ["merged", GitMerge, "text-merged"],
    ["closed", GitPullRequestClosed, "text-destructive"],
    ["unknown", GitPullRequest, "text-muted-foreground"],
  ])("draws %s", (kind, icon, tone) => {
    expect(PR_GLYPH_DISPLAY[kind]).toEqual({ icon, tone });
  });

  it("draws checks still running with the checks' running mark, everywhere a glyph is drawn", () => {
    expect(PR_GLYPH_DISPLAY.pending).toEqual(CHECKS_DISPLAY.pending);
  });
});

const of = (kind: PrGlyphKind) => ({ glyph: { kind, word: kind } });

describe("worstPrGlyph", () => {
  it("shows the PR most in need of the user", () => {
    expect(worstPrGlyph([of("merged"), of("failing"), of("ready")])?.glyph.kind).toBe("failing");
    expect(worstPrGlyph([of("closed"), of("draft"), of("merged")])?.glyph.kind).toBe("draft");
    expect(worstPrGlyph([of("ready"), of("open")])?.glyph.kind).toBe("open");
    expect(worstPrGlyph([])).toBeUndefined();
  });
});

describe("prGlyphLabel", () => {
  it("names the checks unless the state already says them", () => {
    expect(prGlyphLabel(120, open)).toBe("PR #120 ready, checks passing");
    expect(prGlyphLabel(120, { ...open, checks: "failing" })).toBe("PR #120 checks failing");
    expect(prGlyphLabel(120, { ...open, checks: "pending" })).toBe("PR #120 checks running");
    expect(prGlyphLabel(120, { ...open, reviewDecision: "CHANGES_REQUESTED" })).toBe(
      "PR #120 changes requested, checks passing",
    );
    expect(prGlyphLabel(120, { ...open, checks: "none" })).toBe("PR #120 ready");
    expect(prGlyphLabel(120, { ...open, state: "MERGED" })).toBe("PR #120 merged");
    expect(prGlyphLabel(120, undefined)).toBe("PR #120 status unknown");
  });
});

const review = (patch: Partial<PrReviewState> = {}): PrReviewState => ({
  bots: ["review-bot"],
  reviewedHead: true,
  roundInFlight: false,
  threads: { blockers: 0, unresolved: 0, suggestions: 0, outdatedUnresolved: 0 },
  ...patch,
});

/** The predicate as a badge's review reaches it: through the review bot's mark. */
const asks = (state: PrReviewState | undefined) => botAsksChanges(reviewStatusOf(state));

describe("botAsksChanges", () => {
  it("counts open blockers and a change request on the head, not a round under way", () => {
    expect(asks(undefined)).toBe(false);
    expect(asks(review())).toBe(false);
    expect(asks(review({ verdictOnHead: "changesRequested" }))).toBe(true);
    const blockers = review({
      threads: { blockers: 2, unresolved: 2, suggestions: 0, outdatedUnresolved: 0 },
    });
    expect(asks(blockers)).toBe(true);
    expect(asks({ ...blockers, roundInFlight: true })).toBe(false);
  });
});
