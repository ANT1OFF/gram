import type { FeatureCardPr } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import type { PrGlyphEntry } from "@/components/pr-glyph";
import { prGlyphOf, type PrGlyphSource } from "@/components/pr-glyph-model";
import type { ReviewGlyphState } from "@/components/review-glyph";

import { prChipsOf, prChipTone } from "./overview-pr-chips-model";

const entry = (
  number: number,
  source: Omit<PrGlyphSource, "bot">,
  review?: ReviewGlyphState,
  own = true,
  people = 0,
): PrGlyphEntry => ({
  key: `acme/api#${number}`,
  number,
  repo: "acme/api",
  title: `PR ${number}`,
  url: `https://github.com/acme/api/pull/${number}`,
  glyph: prGlyphOf(source),
  label: `PR #${number} ${prGlyphOf(source).word.toLowerCase()}`,
  additions: undefined,
  deletions: undefined,
  notes: [],
  stale: false,
  own,
  checks: source.requiredChecks ?? source.checks,
  review,
  peopleThreads: people,
  facts: {
    repo: "acme/api",
    number,
    ...source,
    checks: source.checks ?? undefined,
  },
});

describe("prChipTone", () => {
  it("is red for what blocks the merge, amber for what someone has to look at, else plain", () => {
    expect(prChipTone("failing", undefined)).toBe("danger");
    expect(prChipTone("ready", "blockers")).toBe("danger");
    expect(prChipTone("changes", "changesRequested")).toBe("danger");
    expect(prChipTone("changes", undefined)).toBe("warning");
    expect(prChipTone("conflicts", undefined)).toBe("warning");
    expect(prChipTone("ready", "findings")).toBe("warning");
    // People's threads count even when the bot approved.
    expect(prChipTone("ready", "approved", 2)).toBe("warning");
    expect(prChipTone("ready", "approved")).toBe("plain");
    expect(prChipTone("draft", "inFlight")).toBe("plain");
    expect(prChipTone("merged", "blockers")).toBe("merged");
  });
});

/** A worker's ledger row for #214, failing, its worker in `status`. */
const ledgerOf = (status: "running" | "needsInput") => ({
  prs: [
    {
      repo: "acme/api",
      number: 214,
      state: "open" as const,
      checks: "failing",
      monitored: true as const,
    },
  ],
  worker: { state: "inReview" as const, status, pendingRequests: [] },
});

describe("prChipsOf", () => {
  it("keeps the thread's order, its checks and review, and leaves a closed PR out", () => {
    const chips = prChipsOf(
      [
        entry(
          214,
          { state: "OPEN", checks: "failing" },
          { kind: "blockers", label: "Review bot: 2 blockers" },
        ),
        entry(
          48,
          { state: "OPEN", isDraft: true, checks: "pending" },
          { kind: "inFlight", label: "Review bot: round in progress" },
          false,
        ),
        entry(12, { state: "CLOSED" }),
        entry(
          229,
          { state: "MERGED", checks: "passing" },
          { kind: "approved", label: "Review bot: approved" },
        ),
      ],
      [],
    );
    expect(
      chips.map((chip) => [chip.entry.number, chip.kind, chip.checks, chip.bot, chip.tone]),
    ).toEqual([
      [214, "failing", "failing", "blockers", "danger"],
      [48, "draft", "pending", "inFlight", "plain"],
      // Merged, its checks and review no longer matter.
      [229, "merged", undefined, undefined, "merged"],
    ]);
    expect(chips[0]!.label).toBe("PR #214 checks failing, Review bot: 2 blockers");
    expect(chips[2]!.label).toBe("PR #229 merged");
  });

  it("falls back to the card's PRs while the thread hasn't been read", () => {
    const card: FeatureCardPr[] = [
      { repo: "acme/api", number: 7, state: "open", checks: "passing" },
      { repo: "acme/web", number: 9, state: "merged" },
    ];
    const chips = prChipsOf([], card);
    expect(chips.map((chip) => [chip.entry.key, chip.kind, chip.checks, chip.bot])).toEqual([
      ["acme/api#7", "ready", "passing", undefined],
      ["acme/web#9", "merged", undefined, undefined],
    ]);
    expect(chips[0]!.entry.url).toBe("https://github.com/acme/api/pull/7");
    // The card lists the worker's own PR first.
    expect(chips.map((chip) => chip.entry.own)).toEqual([true, false]);
  });

  it("marks people's threads beside the bot's approval, and names the checks it shows", () => {
    const [chip] = prChipsOf(
      [
        entry(
          212,
          { state: "OPEN", checks: "failing", requiredChecks: "passing" },
          { kind: "approved", label: "Review bot: approved\nReviewers: 2 open threads" },
          true,
          2,
        ),
      ],
      [],
    );
    expect(chip).toMatchObject({ checks: "passing", bot: "approved", people: 2, tone: "warning" });
    expect(chip!.label).toBe(
      "PR #212 ready, checks passing, Review bot: approved, Reviewers: 2 open threads",
    );
  });

  it("is empty with no PRs", () => {
    expect(prChipsOf([], [])).toEqual([]);
  });

  it("reads failing CI its worker owns as being fixed: informational, not red", () => {
    const failing = entry(214, { state: "OPEN", checks: "failing" });
    const [fixing] = prChipsOf([failing], [], ledgerOf("running"));
    expect(fixing).toMatchObject({ tone: "plain", marks: { checks: { kind: "fixing" } } });
    expect(fixing!.label).toBe("PR #214 checks failing; its worker is fixing them");
    // A worker waiting on the user owns nothing: the failure is red again.
    const [owned] = prChipsOf([failing], [], ledgerOf("needsInput"));
    expect(owned).toMatchObject({ tone: "danger", marks: { checks: { kind: "failing" } } });
    // Without the ledger, as before.
    expect(prChipsOf([failing], [])[0]).toMatchObject({ tone: "danger" });
  });

  it("adds the ledger's merge intent, hold and dependencies to a PR's marks and name", () => {
    const ready = entry(215, { state: "OPEN", checks: "passing", mergeState: "CLEAN" });
    const [held] = prChipsOf([ready], [], {
      prs: [
        {
          repo: "acme/api",
          number: 215,
          state: "open",
          checks: "passing",
          mergeWhenReady: { hold: "after the release", heldBy: "orchestrator" },
          dependsOn: [{ repo: "acme/api", number: 214, state: "open", setBy: "orchestrator" }],
        },
      ],
      worker: undefined,
    });
    expect(held!.marks.merge).toEqual({
      kind: "held",
      word: "Held",
      detail:
        "Merge held by the orchestrator: after the release\nMerges after acme/api#214\nMerges when ready",
    });
    expect(held!.label).toBe(
      "PR #215 ready, checks passing, merge held by the orchestrator: after the release, merges after acme/api#214, merges when ready",
    );
    // A merged PR's merge is done with.
    const [merged] = prChipsOf([entry(215, { state: "MERGED" })], [], {
      prs: [{ repo: "acme/api", number: 215, state: "merged", mergeWhenReady: {} }],
      worker: undefined,
    });
    expect(merged!.marks.merge).toBeUndefined();
  });

  it("draws a card-only PR's state and checks", () => {
    const [chip] = prChipsOf(
      [],
      [{ repo: "acme/api", number: 7, state: "open", checks: "pending" }],
    );
    expect(chip!.marks.state.kind).toBe("open");
    expect(chip!.marks.checks?.kind).toBe("pending");
  });
});
