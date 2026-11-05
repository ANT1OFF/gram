import type { PrDetail, ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { mockPrDetail } from "@/api/mock-git";

import {
  blockedLineOf,
  fixConflictsMessage,
  mergeBlockersOf,
  primaryBlockerAction,
  type BotSource,
} from "./pr-blockers";

const T = "t-flaky" as ThreadId;
const detail = (): PrDetail => mockPrDetail(T).detail!;

const run = (
  name: string,
  overrides: Partial<PrDetail["checkRuns"][number]> = {},
): PrDetail["checkRuns"][number] => ({
  name,
  status: "failing",
  conclusion: "FAILURE",
  link: "",
  ...overrides,
});

const BOT_BLOCKERS: BotSource = {
  kind: "blockers",
  label: "Review bot: 2 blockers\nReviewers: 1 open thread",
  text: "2 blockers",
};

describe("mergeBlockersOf", () => {
  it("lists the seeded PR's blockers worst first, each naming what it counts", () => {
    const blockers = mergeBlockersOf(detail(), "blocked", BOT_BLOCKERS);
    expect(blockers.map((b) => [b.kind, b.word, b.detail])).toEqual([
      ["checks", "1 failing check", "test (windows) failing"],
      ["changes", "changes requested", "Changes requested by reviewer"],
      ["bot", "review bot: 2 blockers", "Review bot: 2 blockers"],
    ]);
    expect(blockedLineOf(blockers)).toBe(
      "Blocked: 1 failing check, changes requested, review bot: 2 blockers",
    );
  });

  it("leads with inspecting a failing Actions job, whose evidence the panel can show", () => {
    expect(primaryBlockerAction(mergeBlockersOf(detail(), "blocked"))).toEqual({
      kind: "inspectCheck",
      label: "Inspect test (windows) job",
      check: "test (windows)",
    });
  });

  it("opens another provider's failing check on its page, and offers nothing without a link", () => {
    const base = { ...detail(), reviewDecision: "APPROVED" };
    const elsewhere = run("buildkite", { link: "https://buildkite.com/example/api/builds/7" });
    expect(
      primaryBlockerAction(mergeBlockersOf({ ...base, checkRuns: [elsewhere] }, "blocked")),
    ).toEqual({ kind: "openCheck", label: "Open buildkite", url: elsewhere.link });
    const unlinked = mergeBlockersOf({ ...base, checkRuns: [run("local")] }, "blocked");
    expect(unlinked.map((b) => b.kind)).toEqual(["checks"]);
    expect(primaryBlockerAction(unlinked)).toBeUndefined();
  });

  it("points at a required failing check before one GitHub merges past, and counts the rest", () => {
    const blockers = mergeBlockersOf(
      {
        reviewDecision: "",
        checkRuns: [run("optional", { required: false }), run("unit"), run("e2e")],
      },
      "blocked",
    );
    expect(blockers[0]!.detail).toBe("unit and 2 more failing");
    expect(blockers[0]!.word).toBe("3 failing checks");
    expect(
      mergeBlockersOf({ reviewDecision: "", checkRuns: [run("unit"), run("e2e")] }, undefined)[0]!
        .detail,
    ).toBe("unit and e2e failing");
  });

  it("ranks conflicts after failing checks and before requested changes, asking the agent to fix them", () => {
    const blockers = mergeBlockersOf(
      { ...detail(), checkRuns: [], reviewDecision: "CHANGES_REQUESTED" },
      "conflicts",
    );
    expect(blockers.map((b) => b.kind)).toEqual(["conflicts", "changes"]);
    expect(blockers[0]!.detail).toBe("Conflicts with main");
    expect(primaryBlockerAction(blockers)).toEqual({
      kind: "fixConflicts",
      label: "Ask agent to fix conflicts",
    });
  });

  it("reads requested changes in the conversation, or on the Review tab when it has none", () => {
    const changes = { ...detail(), checkRuns: [] };
    expect(primaryBlockerAction(mergeBlockersOf(changes, "blocked"))).toEqual({
      kind: "readChanges",
      label: "Read requested changes",
      where: "conversation",
    });
    const silent = { ...changes, conversation: [], latestReviews: [] };
    const blockers = mergeBlockersOf(silent, "blocked");
    expect(blockers[0]!.detail).toBe("Changes requested");
    expect(primaryBlockerAction(blockers)).toMatchObject({ where: "review" });
  });

  it("sends the review bot's blockers to the Review tab", () => {
    const clean = { ...detail(), checkRuns: [], reviewDecision: "APPROVED" };
    const blockers = mergeBlockersOf(clean, "mergeable", BOT_BLOCKERS);
    expect(blockers.map((b) => b.kind)).toEqual(["bot"]);
    expect(primaryBlockerAction(blockers)).toEqual({
      kind: "openReview",
      label: "Read review findings",
    });
    const changes = {
      kind: "changesRequested",
      label: "Review bot: changes requested",
      text: "changes requested",
    } as const;
    expect(blockedLineOf(mergeBlockersOf(clean, "mergeable", changes))).toBe(
      "Blocked: review bot: changes requested",
    );
    const findings = {
      kind: "findings",
      label: "Review bot: 1 open finding",
      text: "1 finding",
    } as const;
    expect(mergeBlockersOf(clean, "mergeable", findings)).toEqual([]);
  });

  it("names a missing review only when GitHub blocks for nothing else, offering a request when nobody was asked", () => {
    const waiting = { ...detail(), checkRuns: [], reviewDecision: "REVIEW_REQUIRED" };
    const asked = mergeBlockersOf(waiting, "blocked");
    expect(asked.map((b) => [b.word, b.detail])).toEqual([
      ["review required", "Waiting on maria, example/platform"],
    ]);
    expect(primaryBlockerAction(asked)).toBeUndefined();

    const nobody = mergeBlockersOf({ ...waiting, reviewRequests: [] }, "blocked");
    expect(nobody[0]!.detail).toBe("Waiting on an approving review");
    expect(primaryBlockerAction(nobody)).toEqual({
      kind: "requestReview",
      label: "Ask for a review…",
    });

    const unknown = mergeBlockersOf({ reviewDecision: "", checkRuns: [] }, "blocked");
    expect(unknown.map((b) => b.kind)).toEqual(["required"]);
    expect(primaryBlockerAction(unknown)).toBeUndefined();
  });

  it("finds nothing for a mergeable PR, a cancelled check or a pending one", () => {
    const clean = { reviewDecision: "APPROVED", checkRuns: [] };
    expect(mergeBlockersOf(clean, "mergeable")).toEqual([]);
    expect(
      mergeBlockersOf(
        {
          ...clean,
          checkRuns: [
            run("cancelled", { conclusion: "CANCELLED" }),
            run("e2e", { status: "pending" }),
          ],
        },
        undefined,
      ),
    ).toEqual([]);
    expect(blockedLineOf([])).toBeUndefined();
  });

  it("falls back to the next blocker's step when the worst has none", () => {
    const blockers = mergeBlockersOf({ ...detail(), checkRuns: [run("local")] }, "blocked");
    expect(blockers.map((b) => b.kind)).toEqual(["checks", "changes"]);
    expect(primaryBlockerAction(blockers)?.kind).toBe("readChanges");
  });
});

describe("fixConflictsMessage", () => {
  it("names the PR and its base", () => {
    expect(fixConflictsMessage(412, "main")).toBe(
      "PR #412 has merge conflicts with main. Fetch origin, merge origin/main into this branch and resolve the conflicts, keeping both sides' intent. Run the checks that cover the files you touched, then push.",
    );
  });
});
