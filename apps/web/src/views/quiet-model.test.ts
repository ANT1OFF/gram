import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import type { Ask } from "@/orchestration/ask-model";
import type { WorkerRow } from "@/orchestration/workers-model";

import {
  dotTone,
  QUIET_IDLE_MS,
  quietDeck,
  quietSummary,
  sendLater,
  shouldEnterQuiet,
  type DeckSource,
  type StripWorkspace,
} from "./quiet-model";

const ask = (key: string, threadId?: string): Ask =>
  ({
    key,
    ids: [key],
    icon: "approval",
    lead: key,
    extras: [],
    members: [],
    count: 1,
    context: "",
    options: [],
    ...(threadId === undefined
      ? {}
      : { group: { entries: [{ threadId: threadId as ThreadId }] } as never }),
  }) as Ask;

const source = (id: string, asks: readonly Ask[], orchestrator?: string): DeckSource => ({
  workspaceId: id as WorkspaceId,
  name: id,
  orchestratorThreadId: orchestrator as ThreadId | undefined,
  asks,
});

const keys = (cards: readonly { ask: Ask }[]) => cards.map((card) => card.ask.key);

describe("the deck", () => {
  const sources = [
    source("billing", [ask("merge-91", "t-billing")], "o-billing"),
    source("platform", [ask("push", "t-form"), ask("question")], "o-platform"),
  ];

  it("leads with the window's workspace, keeping each stack's order", () => {
    expect(keys(quietDeck(sources, "platform" as WorkspaceId, []))).toEqual([
      "push",
      "question",
      "merge-91",
    ]);
    expect(keys(quietDeck(sources, undefined, []))).toEqual(["merge-91", "push", "question"]);
  });

  it("opens the asker's thread, else the orchestrator's", () => {
    const deck = quietDeck(sources, "platform" as WorkspaceId, []);
    expect(deck.map((card) => card.threadId)).toEqual(["t-form", "o-platform", "t-billing"]);
    expect(deck[2]!.workspace).toBe("billing");
  });

  it("sends Later cards to the back, in the order they were sent", () => {
    const first = "platform" as WorkspaceId;
    const live = new Set(["push", "question", "merge-91"]);
    let later = sendLater([], "push", live);
    expect(keys(quietDeck(sources, first, later))).toEqual(["question", "merge-91", "push"]);
    later = sendLater(later, "question", live);
    expect(keys(quietDeck(sources, first, later))).toEqual(["merge-91", "push", "question"]);
    // Sent back again, it goes behind the others; answered ones drop out of the list.
    later = sendLater(later, "push", new Set(["push", "merge-91"]));
    expect(later).toEqual(["push"]);
  });
});

const row = (activity: WorkerRow["activity"], index: number): WorkerRow =>
  ({ threadId: `${activity}-${index}` as ThreadId, glyph: "idle", activity }) as WorkerRow;

const strip = (activities: WorkerRow["activity"][], mergedToday = 0): StripWorkspace => ({
  workspaceId: "w" as WorkspaceId,
  name: "w",
  orchestratorThreadId: undefined,
  workers: activities.map(row),
  asks: 0,
  mergedToday,
});

describe("the empty field", () => {
  it("counts busy workers and today's merges across workspaces", () => {
    expect(quietSummary([strip(["working", "working", "idle"], 1), strip(["working"], 1)])).toBe(
      "3 workers are busy. 2 PRs merged today.",
    );
    expect(quietSummary([strip(["working"])])).toBe("1 worker is busy.");
    expect(quietSummary([strip(["idle", "done"], 1)])).toBe(
      "No workers are busy. 1 PR merged today.",
    );
    expect(quietSummary([])).toBe("No workers are busy.");
  });

  it("counts work waiting on automation as busy, and says how much waits", () => {
    expect(
      quietSummary([
        strip(["working", "automation", "automation"]),
        strip(["working", "working", "automation"]),
      ]),
    ).toBe("6 workers are busy: 3 working, 3 waiting on checks.");
    expect(quietSummary([strip(["automation"])])).toBe("1 worker is busy, waiting on checks.");
    expect(quietSummary([strip(["automation", "automation"])])).toBe(
      "2 workers are busy, waiting on checks.",
    );
  });

  it("leaves work that needs attention out of busy and says it apart", () => {
    expect(quietSummary([strip(["working", "attention", "idle"])])).toBe(
      "1 worker is busy. 1 needs attention.",
    );
    expect(quietSummary([strip(["attention", "attention"], 2)])).toBe(
      "No workers are busy. 2 need attention. 2 PRs merged today.",
    );
  });

  it("draws a wait on automation hollow, apart from a live turn and from attention", () => {
    expect(dotTone({ tone: "working" })).toBe("working");
    expect(dotTone({ tone: "waiting" })).toBe("waiting");
    expect(dotTone({ tone: "attention" })).toBe("needs");
    expect(dotTone({ tone: "needs" })).toBe("needs");
    expect(dotTone({ tone: "error" })).toBe("error");
    expect(dotTone({ tone: "idle" })).toBe("idle");
    expect(dotTone({ tone: "merged" })).toBe("idle");
  });
});

describe("Quiet when idle", () => {
  const base = { enabled: true, available: true, quiet: false, asks: 0, idleFor: QUIET_IDLE_MS };

  it("enters only when on, idle long enough and nothing is asked", () => {
    expect(shouldEnterQuiet(base)).toBe(true);
    expect(shouldEnterQuiet({ ...base, enabled: false })).toBe(false);
    expect(shouldEnterQuiet({ ...base, available: false })).toBe(false);
    expect(shouldEnterQuiet({ ...base, quiet: true })).toBe(false);
    expect(shouldEnterQuiet({ ...base, asks: 1 })).toBe(false);
    expect(shouldEnterQuiet({ ...base, idleFor: QUIET_IDLE_MS - 1 })).toBe(false);
  });
});
