import { describe, expect, it } from "vitest";
import type { ThreadId } from "./ids.ts";
import { prOwner, prOwnerCandidate, type PrOwnerCandidate } from "./review-requests.ts";

const t = (id: string) => id as ThreadId;

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
