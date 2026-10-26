import type { BoundPr, PrStatus } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { ledgerPrFacts, prFactsOfBadge, prFactsOfListPr } from "./pr-facts";
import { prMarksOf } from "./pr-marks-model";

const badge: PrStatus = {
  number: 214,
  state: "OPEN",
  url: "https://github.com/acme/api/pull/214",
  title: "Retry the queue",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  headRef: "feat/queue-retry",
  headRefOid: "abc",
  mergeState: "CLEAN",
  baseRef: "main",
};

const bound: BoundPr = {
  repo: "acme/api",
  number: 214,
  monitor: true,
  mergeWhenReady: { method: "squash", allowedBy: "user", setAt: 0, hold: "until Monday" },
  dependsOn: [
    { repo: "acme/api", number: 9, setBy: "thread", setAt: 0, seen: { state: "open" } },
    { repo: "acme/api", number: 8, setBy: "thread", setAt: 0, seen: { state: "merged" } },
  ],
};

/** The merge mark of the badge's PR with an intent GitHub refused on `head`. */
const refusedOn = (head: string) =>
  prMarksOf(
    prFactsOfBadge("acme/api", 214, badge, {
      number: 214,
      mergeWhenReady: { method: "squash", allowedBy: "user", setAt: 0, failedOn: head },
    }),
  ).merge?.kind;

describe("prFactsOfBadge", () => {
  it("adds the binding's intent and open dependencies, for that very PR only", () => {
    const marks = prMarksOf(prFactsOfBadge("acme/api", 214, badge, bound));
    expect(marks.mergeAll.map((mark) => mark.kind)).toEqual(["held", "waiting", "armed"]);
    expect(marks.merge?.detail).toContain("Merges after acme/api#9");
    expect(marks.merge?.detail).not.toContain("#8");
    const other = prMarksOf(prFactsOfBadge("acme/api", 214, badge, { ...bound, number: 300 }));
    expect(other.merge?.kind).toBe("mergeable");
  });

  it("calls a merge refused only while the refused head is current", () => {
    expect(refusedOn("abc")).toBe("refused");
    expect(refusedOn("old")).toBe("armed");
  });
});

describe("ledgerPrFacts", () => {
  it("names CI its live worker will fix, and the server's refusal and dependencies", () => {
    const pr = {
      repo: "acme/api",
      number: 214,
      state: "open" as const,
      checks: "failing (not required: passing)",
      monitored: true as const,
      mergeWhenReady: { refused: true as const },
    };
    const live = { state: "inReview" as const, status: "running" as const, pendingRequests: [] };
    expect(ledgerPrFacts(pr, live)).toMatchObject({ ciFixing: true, intent: { refused: true } });
    expect(ledgerPrFacts(pr, undefined).ciFixing).toBe(false);
    expect(ledgerPrFacts({ ...pr, checks: "passing" }, live).ciFixing).toBe(false);
  });
});

describe("prFactsOfListPr", () => {
  it.each([
    [{ verdict: "approved", onHead: true }, "approved"],
    [{ verdict: "changesRequested", onHead: true }, "changesRequested"],
    [{ verdict: "commented", onHead: true }, "quiet"],
    [{ verdict: "approved", onHead: false }, "quiet"],
  ] as const)("reads the bot's %o as %s", (bot, kind) => {
    expect(prFactsOfListPr({ repo: "acme/api", number: 1, bot }).bot?.kind).toBe(kind);
  });
});
