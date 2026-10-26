import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { DEFAULT_CHARTER, OrchestratorCharter } from "./workspaces.ts";
import type { PrStatus } from "./git.ts";
import { DEFAULT_REVIEW_BOTS } from "./review.ts";
import { mergeReviewPolicyOf, mergePolicyReady } from "./merge-policy.ts";

const configured = [
  { loginPattern: "real-reviewer[bot]", rereviewCommand: "/review", canApprove: true },
];
describe("workspace merge review policy", () => {
  it("starts personal workspaces without a mandatory external bot, preserving configured bots", () => {
    expect(DEFAULT_REVIEW_BOTS).toEqual([]);
    expect(mergeReviewPolicyOf(DEFAULT_CHARTER, "a/b", [])).toBe("solo");
    expect(mergeReviewPolicyOf(DEFAULT_CHARTER, "a/b", configured)).toBe("bot");
    expect(
      mergeReviewPolicyOf(DEFAULT_CHARTER, "a/b", [{ ...configured[0]!, canApprove: false }]),
    ).toBe("solo");
  });
  it("retains migrated and nonworkspace bot requirements even with no configured bot", () => {
    expect(mergeReviewPolicyOf(undefined, "a/b", [])).toBe("bot");
    expect(mergeReviewPolicyOf({}, "a/b", [])).toBe("bot");
    expect(mergeReviewPolicyOf({ mergeReviewPolicy: "bot" }, "a/b", configured)).toBe("bot");
  });
  it("matches exact case-insensitive repository scopes only in this workspace", () => {
    const scoped = { repoMergeReviewPolicies: [{ repo: "ANT1OFF/gram", policy: "solo" }] } as const;
    expect(mergeReviewPolicyOf(scoped, "ant1off/GRAM", configured)).toBe("solo");
    for (const repo of [
      "ANT1OFF/gram-fork",
      "different/gram",
      "ANT1OFF/other",
      "https://github.com/ANT1OFF/gram",
      " ANT1OFF/gram ",
    ])
      expect(mergeReviewPolicyOf(scoped, repo, configured)).toBe("bot");
    expect(mergeReviewPolicyOf({}, "ANT1OFF/gram", configured)).toBe("bot");
    const workspace = {
      mergeReviewPolicy: "solo",
      repoMergeReviewPolicies: [{ repo: "a/b", policy: "bot" }],
    } as const;
    expect(mergeReviewPolicyOf(workspace, "A/B", configured)).toBe("bot");
  });
  it("persists valid policies and refuses invalid, duplicate or unknown scopes", () => {
    const decode = Schema.decodeUnknownSync(OrchestratorCharter);
    const charter = {
      ...DEFAULT_CHARTER,
      repoMergeReviewPolicies: [{ repo: "ANT1OFF/gram", policy: "solo" }],
    };
    expect(decode(charter)).toEqual(charter);
    for (const repo of [
      "",
      "a",
      "a/b/c",
      "a/*",
      "a/..",
      "a/.",
      " a/b",
      "a/b ",
      "https://github.com/a/b",
      "-a/b",
      "a-/b",
    ])
      expect(() =>
        decode({ ...charter, repoMergeReviewPolicies: [{ repo, policy: "solo" }] }),
      ).toThrow();
    expect(() => decode({ ...charter, mergeReviewPolicy: "none" })).toThrow();
    expect(() =>
      decode({
        ...charter,
        repoMergeReviewPolicies: [
          { repo: "a/b", policy: "solo" },
          { repo: "A/B", policy: "bot" },
        ],
      }),
    ).toThrow();
  });
  it("attributes a mixed bot badge to its actual approver, never another commenter", () => {
    const first = { loginPattern: "approver-a", rereviewCommand: "/review", canApprove: true };
    const second = { ...first, loginPattern: "commenter-b" };
    const badge: PrStatus = {
      number: 1,
      url: "https://github.com/a/b/pull/1",
      title: "t",
      state: "OPEN",
      isDraft: false,
      checks: "passing",
      headRefOid: "h1",
      headMatches: true,
      aheadOfPr: false,
      mergeState: "CLEAN",
      review: {
        bots: ["approver-a", "commenter-b"],
        verdictOnHead: "approved",
        verdictOnHeadBy: "approver-a",
        reviewedHead: true,
        roundInFlight: false,
        threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
      },
    };
    expect(mergePolicyReady(badge, "bot", [first, second])).toBe(true);
    expect(mergePolicyReady(badge, "bot", [second])).toBe(false);
    expect(mergePolicyReady(badge, "bot", [{ ...second, canApprove: false }])).toBe(false);
    expect(mergePolicyReady(badge, "bot", [{ ...first, canApprove: false }, second])).toBe(false);
    const { verdictOnHeadBy: _, ...unattributed } = badge.review!;
    expect(mergePolicyReady({ ...badge, review: unattributed }, "bot", [first, second])).toBe(
      false,
    );
  });
});
