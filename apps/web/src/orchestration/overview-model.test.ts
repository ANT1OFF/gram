import type { FeatureCard, FeatureCardWorker, ThreadId, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  ASKS_YOU,
  foldByKey,
  foldedSummaryText,
  orchestratorLine,
  overviewFeatures,
  overviewState,
  overviewSummary,
  rowTone,
  stageTicks,
  stationDotClass,
  tileLetters,
  tileWorking,
  workLineText,
  type OverviewWorkerRow,
} from "./overview-model";

const ws = "ws-1" as WorkspaceId;

const worker = (id: string, over: Partial<FeatureCardWorker> = {}): FeatureCardWorker => ({
  threadId: id as ThreadId,
  title: id,
  project: "api",
  state: "working",
  station: "working",
  now: "running tests",
  prs: [],
  overlapsWith: [],
  overlapFiles: [],
  ...over,
});

const card = (feature: string, workers: FeatureCardWorker[], updatedAt = 1): FeatureCard => ({
  workspaceId: ws,
  feature,
  station: "working",
  version: 1,
  workers,
  createdAt: updatedAt,
  updatedAt,
});

const pr = { repo: "acme/api", number: 212, state: "open" as const, checks: "passing" as const };

describe("overviewFeatures", () => {
  it("lists each card's live workers in the card's order, with the card's station, now line and PR", () => {
    const groups = overviewFeatures(
      [
        card("mail-trigger", [
          worker("endpoint", { station: "review", state: "inReview", now: "in review", prs: [pr] }),
          worker("queue"),
          worker("schema", { station: "merged", state: "merged", now: "merged 09:20" }),
        ]),
        card("tooling", [worker("uv", { station: "merged", state: "merged" })]),
        card("docs-refresh", [
          worker("guide", { flag: "error", now: "build failed" }),
          worker("old", { state: "archived" }),
          worker("sent", { state: "delivered" }),
        ]),
      ],
      new Map(),
    );
    // A feature with no live worker isn't listed; finished and parked workers leave it.
    expect(groups.map((group) => group.feature)).toEqual(["mail-trigger", "docs-refresh"]);
    expect(groups[0]?.rows.map((row) => row.threadId)).toEqual(["endpoint", "queue"]);
    expect(groups[0]?.rows[0]).toMatchObject({
      now: "in review",
      station: "review",
      stationLabel: "Review",
      failed: false,
      askKey: undefined,
      pr,
    });
    expect(groups[0]).toMatchObject({ station: "working", held: [] });
    expect(groups[1]?.rows).toEqual([
      expect.objectContaining({ threadId: "guide", now: "build failed", failed: true }),
    ]);
    expect(groups.flatMap((group) => group.rows)).toHaveLength(3);
  });

  it("says a worker asks you while an ask of its waits in the stack, keeping the ask's key", () => {
    const [group] = overviewFeatures(
      [card("mail-trigger", [worker("form", { now: "editing code" }), worker("queue")])],
      new Map([["form" as ThreadId, "ask-key-1"]]),
    );
    expect(group?.rows[0]).toMatchObject({ now: ASKS_YOU, askKey: "ask-key-1" });
    expect(group?.rows[1]).toMatchObject({ now: "running tests", askKey: undefined });
  });

  it("marks the workers the user holds", () => {
    const [group] = overviewFeatures(
      [card("mail-trigger", [worker("form"), worker("queue")])],
      new Map(),
      undefined,
      [],
      new Set(["queue" as ThreadId]),
    );
    expect(group?.rows.map((each) => each.held)).toEqual([false, true]);
  });

  it("is empty with no cards", () => {
    expect(overviewFeatures([], new Map())).toEqual([]);
  });

  it("leaves out a worker its ledger no longer has, so a merged and cleaned-up worker isn't working", () => {
    // Its PR merged and its worktree was cleaned up: closed, so the ledger has let go of it, but
    // its card keeps it as it last was, still inReview, with its stale now line.
    const cleaned = worker("usage", {
      state: "inReview",
      station: "review",
      now: "#211 head e7c7c0b3",
      prs: [{ ...pr, number: 211, state: "merged" }],
    });
    expect(overviewFeatures([card("usage-page-design", [cleaned])], new Map(), new Set())).toEqual(
      [],
    );

    // With a live sibling, the feature is that one's, at its station, not the closed worker's.
    const [group] = overviewFeatures(
      [
        card("usage-page-design", [
          worker("briefed", { state: "briefed", station: "briefed", now: "briefed" }),
          cleaned,
          worker("icons", { state: "inReview", station: "review", prs: [pr] }),
        ]),
      ],
      new Map(),
      new Set(["icons" as ThreadId]),
    );
    expect(group).toMatchObject({
      station: "review",
      rows: [expect.objectContaining({ threadId: "icons" })],
    });
    expect(group?.rows).toHaveLength(1);
  });

  it("draws every card worker when no ledger is read yet", () => {
    const [group] = overviewFeatures(
      [card("usage-page-design", [worker("usage", { state: "inReview", station: "review" })])],
      new Map(),
      undefined,
    );
    expect(group?.rows.map((row) => row.threadId)).toEqual(["usage"]);
  });

  it("keeps a running worker its card has as delivered, and one no card has yet, at work", () => {
    const running = [
      { threadId: "cut" as ThreadId, title: "Cut stable 0.1.0", feature: "stable-delivery" },
      { threadId: "fresh" as ThreadId, title: "Probe losses", feature: "arb-losses" },
    ];
    const groups = overviewFeatures(
      [
        card("stable-delivery", [
          worker("cut", { state: "delivered", station: "merged", now: "delivered" }),
          worker("done", { state: "delivered", station: "merged" }),
        ]),
      ],
      new Map(),
      // The ledger has neither: a running worker is live whatever the ledger and card say.
      new Set(),
      running,
    );
    expect(groups.map((group) => group.feature)).toEqual(["stable-delivery", "arb-losses"]);
    expect(groups[0]).toMatchObject({
      station: "working",
      rows: [expect.objectContaining({ threadId: "cut", station: "working", now: "working" })],
    });
    expect(groups[0]?.rows).toHaveLength(1);
    expect(groups[1]).toMatchObject({
      station: "working",
      rows: [expect.objectContaining({ threadId: "fresh", title: "Probe losses", now: "working" })],
    });
  });

  it("lists a running worker once, under its card's feature when the card has it live", () => {
    const groups = overviewFeatures(
      [card("mail-trigger", [worker("queue")])],
      new Map(),
      undefined,
      [
        { threadId: "queue" as ThreadId, title: "queue", feature: "mail-trigger" },
        { threadId: "form" as ThreadId, title: "form", feature: "mail-trigger" },
      ],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows.map((row) => row.threadId)).toEqual(["queue", "form"]);
  });

  it("keeps a feature whose only entry is a held brief, with the brief", () => {
    const held = {
      id: "h1",
      title: "Page the registry list",
      project: "web",
      agent: "claude",
      window: "fiveHour" as const,
      usedPct: 92,
      until: 2_000,
    };
    const groups = overviewFeatures(
      [{ ...card("registry-paging", [worker("old", { state: "archived" })]), held: [held] }],
      new Map(),
    );
    expect(groups).toEqual([expect.objectContaining({ feature: "registry-paging", rows: [] })]);
    expect(groups[0]?.held).toEqual([held]);
  });
});

const row = (over: Partial<OverviewWorkerRow> = {}): OverviewWorkerRow => ({
  threadId: "w" as ThreadId,
  title: "w",
  state: "working",
  now: "running tests",
  station: "working",
  stationLabel: "Working",
  failed: false,
  askKey: undefined,
  pr: undefined,
  prs: [],
  held: false,
  ...over,
});

describe("rowTone", () => {
  it("is working while its turn, or work under it, runs, whatever its card's station", () => {
    expect(rowTone(row(), { status: "running", working: true })).toBe("working");
    expect(rowTone(row(), { status: "starting", working: true })).toBe("working");
    // A background shell under a thread at rest.
    expect(rowTone(row({ activity: "idle" }), { status: "idle", working: true })).toBe("working");
    expect(rowTone(row({ station: "checks" }), { status: "running", working: true })).toBe(
      "working",
    );
  });

  it("says the ledger's activity at rest, and an ask or a failure over everything", () => {
    expect(rowTone(row(), { status: "idle", working: false })).toBe("idle");
    expect(rowTone(row({ activity: "automation" }), { status: "idle", working: false })).toBe(
      "waiting",
    );
    expect(rowTone(row({ activity: "attention" }), { status: "idle", working: false })).toBe(
      "attention",
    );
    expect(rowTone(row({ askKey: "ask-1" }), { status: "running", working: true })).toBe("needs");
    expect(rowTone(row(), { status: "needsInput", working: false })).toBe("needs");
    expect(rowTone(row({ failed: true }), { status: "running", working: true })).toBe("error");
  });

  it("gives a worker running again after its card had it merged the working tone", () => {
    const [feature] = overviewFeatures(
      [card("release", [worker("tag", { station: "merged", state: "merged" })])],
      new Map(),
      undefined,
      [{ threadId: "tag" as ThreadId, title: "tag", feature: "release" }],
    );
    expect(rowTone(feature!.rows[0]!, { status: "running", working: true })).toBe("working");
  });
});

describe("workLineText", () => {
  const next = { phase: "next", text: "Next: Prepare release PR #347" } as const;

  it("says the plan's headline, else what the thread runs", () => {
    expect(workLineText(next, 2_000, undefined, "Running bun test")).toBe(
      "Next: Prepare release PR #347",
    );
    expect(workLineText(undefined, undefined, undefined, "Running bun test")).toBe(
      "Running bun test",
    );
    expect(workLineText({ phase: "needsYou", text: "Approve: git push" }, 0, undefined, "x")).toBe(
      "x",
    );
  });

  it("takes a report newer than the plan's next step over it", () => {
    const report = { at: 3_000, nextStep: "Merge #347 once CI is green" };
    expect(workLineText(next, 2_000, report, undefined)).toBe("Next: Merge #347 once CI is green");
    const followUp = { phase: "followUp", text: "Follow-up after #340 · Prepare" } as const;
    expect(workLineText(followUp, 2_000, report, undefined)).toBe(
      "Next: Merge #347 once CI is green",
    );
    // Without a next step of its own, the report leaves what it runs.
    expect(workLineText(next, 2_000, { at: 3_000 }, "Running bun run check")).toBe(
      "Running bun run check",
    );
    // A plan written after the report stands.
    expect(workLineText(next, 4_000, report, undefined)).toBe("Next: Prepare release PR #347");
    // Other headlines are facts, not the plan's step.
    const ci = { phase: "waitingCi", text: "Waiting on CI · #347" } as const;
    expect(workLineText(ci, 2_000, report, undefined)).toBe("Waiting on CI · #347");
  });
});

describe("stageTicks", () => {
  it("marks the stations before the card's as passed, its own as current, the rest ahead", () => {
    expect(stageTicks("briefed")).toEqual(["current", "ahead", "ahead", "ahead", "ahead"]);
    expect(stageTicks("checks")).toEqual(["past", "past", "current", "ahead", "ahead"]);
    expect(stageTicks("merged")).toEqual(["past", "past", "past", "past", "current"]);
  });
});

describe("a workspace's line", () => {
  it("words its state: paused over all, then parked, working, in review, else idle", () => {
    expect(overviewState("working", true)).toBe("paused");
    expect(overviewState("parked", false)).toBe("parked");
    expect(overviewState("working", false)).toBe("working");
    expect(overviewState("inReview", false)).toBe("in review");
    expect(overviewState("needsYou", false)).toBe("idle");
    expect(overviewState("idle", false)).toBe("idle");
    expect(overviewState(undefined, false)).toBe("idle");
  });

  it("has one dot and phrase whatever its workers: the ask colour, held, working, else idle", () => {
    expect(orchestratorLine("working", { working: 2, asks: 1 })).toEqual({
      dot: "bg-status-needs",
      pulse: false,
      phrase: "2 working",
    });
    expect(orchestratorLine("working", { working: 2, asks: 0 })).toEqual({
      dot: "bg-status-working",
      pulse: true,
      phrase: "2 working",
    });
    // The orchestrator works itself, with no worker at work.
    expect(orchestratorLine("working", { working: 0, asks: 0 })).toMatchObject({
      pulse: true,
      phrase: "working",
    });
    // Workers at work while the state word still holds idle say so, dot and words alike.
    expect(orchestratorLine("idle", { working: 1, asks: 0 })).toMatchObject({
      dot: "bg-status-working",
      phrase: "1 working",
    });
    expect(orchestratorLine("idle", { working: 0, asks: 0 })).toEqual({
      dot: "bg-status-idle",
      pulse: false,
      phrase: "idle",
    });
    expect(orchestratorLine("in review", { working: 0, asks: 0 }).phrase).toBe("in review");
    expect(orchestratorLine("paused", { working: 1, asks: 0 })).toEqual({
      dot: "border border-muted-foreground bg-transparent",
      pulse: false,
      phrase: "paused · 1 working",
    });
  });

  it("sums a folded workspace up in what it has, else its state", () => {
    expect(overviewSummary("working", { working: 2, asks: 1 })).toBe("2 working · 1 ask");
    expect(overviewSummary("working", { working: 1, asks: 3 })).toBe("1 working · 3 asks");
    expect(overviewSummary("idle", { working: 0, asks: 2 })).toBe("2 asks");
    expect(overviewSummary("idle", { working: 0, asks: 0 })).toBe("idle");
    expect(overviewSummary("in review", { working: 0, asks: 0 })).toBe("in review");
    expect(overviewSummary("paused", { working: 1, asks: 0 })).toBe("paused · 1 working");
  });
});

/** A ledger with one feature of `workers`, each by its thread and state. */
/** A key press, with any modifiers in `mods`. */
const key = (
  k: string,
  mods: Partial<Record<"altKey" | "metaKey" | "ctrlKey" | "shiftKey", boolean>> = {},
) => ({ key: k, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...mods });

describe("an orchestrator's line", () => {
  it("says what it hides in words: its workers, how many work, what needs you", () => {
    expect(foldedSummaryText({ live: 3, working: 1, asks: 2 })).toBe(
      "3 workers · 1 working · 2 need you",
    );
    expect(foldedSummaryText({ live: 1, working: 0, asks: 1 })).toBe("1 worker · 1 needs you");
    expect(foldedSummaryText({ live: 0, working: 0, asks: 0 })).toBe("0 workers");
  });

  it("folds on ← while open and opens on → while folded, as a tree row does", () => {
    expect(foldByKey(key("ArrowLeft"), false)).toBe(true);
    expect(foldByKey(key("ArrowRight"), true)).toBe(false);
    // Already where the key would take it: the key is left to the overview.
    expect(foldByKey(key("ArrowLeft"), true)).toBeUndefined();
    expect(foldByKey(key("ArrowRight"), false)).toBeUndefined();
    expect(foldByKey(key("ArrowDown"), false)).toBeUndefined();
    expect(foldByKey(key("Enter"), true)).toBeUndefined();
    for (const mod of ["altKey", "metaKey", "ctrlKey", "shiftKey"] as const) {
      expect(foldByKey(key("ArrowLeft", { [mod]: true }), false)).toBeUndefined();
    }
  });
});

describe("stationDotClass", () => {
  it("draws the feature card's station colours", () => {
    expect(stationDotClass("working", false)).toBe("bg-status-working");
    expect(stationDotClass("briefed", false)).toBe("bg-muted-foreground/50");
    expect(stationDotClass("merged", false)).toBe("bg-merged");
    expect(stationDotClass("review", true)).toBe("bg-destructive");
  });
});

describe("tileLetters", () => {
  it("marks a tile with the first two letters or digits of the name", () => {
    expect(tileLetters("gram")).toBe("gr");
    expect(tileLetters("Billing API")).toBe("Bi");
    expect(tileLetters("a-b")).toBe("ab");
    expect(tileLetters("Ølstue")).toBe("Øl");
    expect(tileLetters("9 lives")).toBe("9l");
    expect(tileLetters("—")).toBe("?");
  });

  it("rings a tile while its orchestrator works, asks or not, and not while it rests", () => {
    expect(tileWorking("working", 0)).toBe(true);
    expect(tileWorking("idle", 2)).toBe(true);
    expect(tileWorking("idle", 0)).toBe(false);
    expect(tileWorking("paused", 2)).toBe(false);
    expect(tileWorking("parked", 1)).toBe(false);
    expect(tileWorking("in review", 0)).toBe(false);
  });
});
