import { describe, expect, it } from "vitest";
import type { ThreadId } from "./ids.ts";
import {
  OwnPrs,
  prOwner,
  prOwnerCandidate,
  ReviewRequests,
  type PrOwnerCandidate,
} from "./review-requests.ts";
import { expectRoundTrip } from "./test-utils.ts";

const t = (id: string) => id as ThreadId;

describe("review request contracts", () => {
  it("round-trip a review request list and an open PR list", () => {
    expectRoundTrip(ReviewRequests, {
      requests: [
        {
          repo: "acme/web",
          number: 12,
          title: "Fix the flake",
          url: "https://github.com/acme/web/pull/12",
          author: "jordan",
          updatedAt: "2026-09-17T08:00:00Z",
          checks: "failing",
          bot: { verdict: "changesRequested", onHead: false },
        },
      ],
      checkedAt: 1,
    });
    expectRoundTrip(OwnPrs, {
      prs: [
        {
          repo: "acme/web",
          number: 14,
          title: "Paginate the audit log",
          url: "https://github.com/acme/web/pull/14",
          isDraft: true,
          updatedAt: "2026-09-17T08:00:00Z",
          detailsAt: "2026-09-17T07:30:00Z",
          createdAt: "2026-09-15T08:00:00Z",
          headRef: "feat/paginate",
          mergeState: "DIRTY",
          checks: "passing",
          reviewDecision: "REVIEW_REQUIRED",
          bot: { verdict: "approved", onHead: true },
          projectRoot: "/code/web",
        },
        {
          repo: "acme/api",
          number: 3,
          title: "",
          url: "",
          isDraft: false,
          updatedAt: "",
        },
      ],
    });
  });
});

describe("prOwner", () => {
  const pr = { repo: "Acme/Web", number: 14, headRef: "feat/paginate" };

  it("is the thread bound to the PR or carrying its badge, in any case of owner/name", () => {
    const candidates: PrOwnerCandidate[] = [
      { threadId: t("other"), prs: [{ repo: "acme/web", number: 15 }] },
      { threadId: t("bound"), prs: [{ repo: "acme/WEB", number: 14 }] },
    ];
    expect(prOwner(pr, candidates)).toBe("bound");
  });

  it("prefers a binding over a thread merely on the head branch, whatever the order", () => {
    const candidates: PrOwnerCandidate[] = [
      { threadId: t("branch"), prs: [], branch: "feat/paginate", origin: "acme/web" },
      { threadId: t("bound"), prs: [{ repo: "acme/web", number: 14 }] },
    ];
    expect(prOwner(pr, candidates)).toBe("bound");
  });

  it("falls back to the first thread on the head branch in the PR's repository", () => {
    const candidates: PrOwnerCandidate[] = [
      { threadId: t("fork"), prs: [], branch: "feat/paginate", origin: "someone/web" },
      { threadId: t("case"), prs: [], branch: "Feat/Paginate", origin: "acme/web" },
      { threadId: t("first"), prs: [], branch: "feat/paginate", origin: "ACME/web" },
      { threadId: t("second"), prs: [], branch: "feat/paginate", origin: "acme/web" },
    ];
    expect(prOwner(pr, candidates)).toBe("first");
  });

  it("is undefined with no binding, and no head branch to match on", () => {
    const candidates: PrOwnerCandidate[] = [
      { threadId: t("branch"), prs: [], branch: "feat/paginate", origin: "acme/web" },
    ];
    expect(prOwner({ repo: "acme/web", number: 14 }, candidates)).toBeUndefined();
    expect(prOwner(pr, [])).toBeUndefined();
  });
});

describe("prOwnerCandidate", () => {
  const thread = {
    id: t("t"),
    checkout: { kind: "worktree" as const, path: "/w/t", branch: "main" },
    boundPr: { repo: "acme/web", number: 1, monitor: false },
  };

  it("goes by the live branch and badges, and the checkout's branch only without a state", () => {
    expect(
      prOwnerCandidate(
        thread,
        {
          branch: "feat/x",
          origin: "acme/web",
          pr: {
            number: 2,
            state: "OPEN",
            url: "https://github.com/acme/web/pull/2",
            title: "",
            isDraft: false,
            checks: "none",
            headMatches: true,
            aheadOfPr: false,
          },
        },
        "acme/stale",
      ),
    ).toEqual({
      threadId: "t",
      prs: [
        { repo: "acme/web", number: 1, monitor: false },
        { repo: "acme/web", number: 2 },
      ],
      branch: "feat/x",
      origin: "acme/web",
    });
    expect(prOwnerCandidate(thread, undefined, "acme/web")).toMatchObject({
      branch: "main",
      origin: "acme/web",
    });
    // Detached in its live state: no branch, whatever the checkout was made on.
    expect(prOwnerCandidate(thread, {})?.branch).toBeUndefined();
  });

  it("is undefined for an orchestrator or a dream", () => {
    expect(prOwnerCandidate({ ...thread, role: "orchestrator" }, undefined)).toBeUndefined();
    expect(prOwnerCandidate({ ...thread, role: "dream" }, undefined)).toBeUndefined();
  });
});

it("round-trips optional information, including zero, and payloads that omit it", () => {
  expectRoundTrip(OwnPrs, {
    prs: [
      {
        repo: "example/tools",
        number: 1,
        title: "Cache",
        url: "https://github.com/example/tools/pull/1",
        isDraft: true,
        updatedAt: "",
        author: "helper[bot]",
        isBot: true,
        labels: ["offline"],
        additions: 0,
        deletions: 8,
        informationAt: "2026-10-01T12:00:00Z",
        informationStale: true,
        detailsStale: true,
      },
    ],
  });
  expectRoundTrip(ReviewRequests, {
    requests: [
      {
        repo: "example/tools",
        number: 2,
        title: "Routes",
        url: "https://github.com/example/tools/pull/2",
        author: "ada",
        updatedAt: "",
        isDraft: false,
        labels: [],
        additions: 0,
        deletions: 0,
      },
    ],
  });
});
