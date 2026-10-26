import type { ReviewRequest } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { prFactsOfListPr } from "@/components/pr-facts";
import { prMarksOf } from "@/components/pr-marks-model";

import {
  displayAuthor,
  groupByRepo,
  reviewRequestAge,
  reviewRequestWaitingOn,
} from "./review-request-model";

const request = (repo: string, number: number, extra: Partial<ReviewRequest> = {}) => ({
  repo,
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  author: "jordan",
  updatedAt: "2026-09-17T08:00:00Z",
  ...extra,
});

const botChangeRequest = (onHead: boolean) =>
  request("example/api", 1, { bot: { verdict: "changesRequested", onHead } });

describe("groupByRepo", () => {
  it("keeps arrival order for groups and rows, and ignores a repo's letter case", () => {
    const groups = groupByRepo([
      request("example/api", 3),
      request("example/web", 9),
      request("EXAMPLE/api", 1),
    ]);
    expect(groups.map((g) => [g.repo, g.requests.map((r) => r.number)])).toEqual([
      ["example/api", [3, 1]],
      ["example/web", [9]],
    ]);
  });
});

const marks = (extra: Partial<ReviewRequest> = {}) =>
  prMarksOf(prFactsOfListPr(request("example/api", 1, extra)));

describe("a review request's marks", () => {
  it("are the PR vocabulary's, as the overview's rows have them", () => {
    // Unknown checks are left out, as everywhere else; none at all is a mark of its own.
    expect(marks().checks).toBeUndefined();
    const none = marks({ checks: "none", reviewDecision: "REVIEW_REQUIRED" });
    expect(none.checks?.detail).toBe("No checks");
    expect(none.review).toMatchObject({ kind: "waiting", word: "Review required" });
    const red = marks({
      checks: "failing",
      bot: { verdict: "changesRequested", onHead: true },
      reviewDecision: "CHANGES_REQUESTED",
    });
    expect([red.checks?.kind, red.bot?.kind, red.review?.kind]).toEqual([
      "failing",
      "changesRequested",
      "changes",
    ]);
    expect(red.review?.word).toBe("Changes requested");
  });

  it("says a bot review of an earlier commit in the overview's words", () => {
    expect(marks({ bot: { verdict: "approved", onHead: false } }).bot).toEqual({
      kind: "quiet",
      word: "earlier review",
      detail: "Review bot: reviewed an earlier commit",
    });
  });
});

describe("reviewRequestAge", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");

  it("counts from when the PR was opened", () => {
    expect(
      reviewRequestAge(request("example/api", 1, { createdAt: "2026-09-18T11:00:00Z" }), now),
    ).toBe("3d");
    expect(
      reviewRequestAge(request("example/api", 1, { createdAt: "2026-08-01T11:00:00Z" }), now),
    ).toBe("7w");
  });

  it("is absent without a usable date", () => {
    expect(reviewRequestAge(request("example/api", 1), now)).toBeUndefined();
    expect(reviewRequestAge(request("example/api", 1, { createdAt: "soon" }), now)).toBeUndefined();
  });
});

describe("displayAuthor", () => {
  it("drops an enterprise login's shortcode and leaves every other login alone", () => {
    expect(displayAuthor("magnus-vaa-lillehaug_exampleprod")).toBe("magnus-vaa-lillehaug");
    expect(displayAuthor("jordan")).toBe("jordan");
    expect(displayAuthor("dependabot[bot]")).toBe("dependabot[bot]");
    expect(displayAuthor("_exampleprod")).toBe("_exampleprod");
    expect(displayAuthor("")).toBe("");
  });
});

describe("reviewRequestWaitingOn", () => {
  it("names what the author has to fix first, and nothing for a PR ready to review", () => {
    expect(
      reviewRequestWaitingOn(request("example/api", 1, { checks: "passing" })),
    ).toBeUndefined();
    expect(
      reviewRequestWaitingOn(request("example/api", 1, { checks: "pending" })),
    ).toBeUndefined();
    expect(reviewRequestWaitingOn(request("example/api", 1, { checks: "failing" }))).toBe(
      "Checks are failing",
    );
    expect(
      reviewRequestWaitingOn(request("example/api", 1, { reviewDecision: "CHANGES_REQUESTED" })),
    ).toBe("A reviewer requested changes");
  });

  it("ignores a bot's change request on an earlier commit", () => {
    expect(reviewRequestWaitingOn(botChangeRequest(true))).toBe("The review bot requested changes");
    expect(reviewRequestWaitingOn(botChangeRequest(false))).toBeUndefined();
  });
});
