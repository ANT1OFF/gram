import type { ThreadId, ThreadStatus, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { notInDeck, restLine, deckPosition } from "@/views/quiet-model";
import type { RowStatus } from "@/sidebar/status";

import type { Ask } from "./ask-model";
import {
  needsYouCounts,
  needsYouIn,
  needsYouThreads,
  threadNeed,
  THREADS_GROUP,
  type NeedsYouGroup,
  type NeedsYouItem,
} from "./needs-you-items";
import { soloDisplay } from "./overview-model";
import { workerStarting, workerTone } from "./rail-model";

// One derivation for what needs you and for a worker that has just started, read by every surface:
// the sidebar's pill and badges, the Workers panel, the Inbox and Quiet (round 11's "Needs you 0"
// beside "2 need you" beside "1 of 1", and a just-started worker reading "Stopped").

const GRAM = "ws-gram" as WorkspaceId;
const BILLING = "ws-billing" as WorkspaceId;

const item = (
  key: string,
  kind: NeedsYouItem["kind"],
  threadId: string | undefined,
  workspaceId?: WorkspaceId,
): NeedsYouItem => ({
  key,
  ids: [key],
  kind,
  title: kind === "failure" ? "#412 checks failing" : `Item ${key}`,
  where: "",
  workspaceId,
  threadId: threadId as ThreadId | undefined,
  owned: true,
});

const group = (
  workspaceId: WorkspaceId | undefined,
  items: readonly NeedsYouItem[],
): NeedsYouGroup => ({
  key: workspaceId ?? THREADS_GROUP,
  workspaceId,
  name: workspaceId ?? "Threads",
  orchestratorThreadId: undefined,
  items,
});

/** Round 11's moment: Gram has nothing, billing-api one question, a solo thread a red PR. */
const question = item("ask:q1", "question", "t-refunds", BILLING);
const redPr = item("failure:checks:t-flaky:1", "failure", "t-flaky");
const groups = [group(BILLING, [question]), group(undefined, [redPr])];

describe("the one needs-you selector", () => {
  it("counts the whole list everywhere, and each scope as its share of it", () => {
    expect(needsYouIn(groups, "all")).toEqual([question, redPr]);
    expect(needsYouIn(groups, { workspaceId: BILLING })).toEqual([question]);
    expect(needsYouIn(groups, { workspaceId: GRAM })).toEqual([]);
    expect(needsYouIn(groups, "solo")).toEqual([redPr]);
    const scoped =
      needsYouIn(groups, { workspaceId: BILLING }).length +
      needsYouIn(groups, { workspaceId: GRAM }).length +
      needsYouIn(groups, "solo").length;
    expect(scoped).toBe(needsYouIn(groups, "all").length);
  });

  it("is what the pill and the workspace badges count", () => {
    const counts = needsYouCounts(groups);
    expect(counts.total).toBe(needsYouIn(groups, "all").length);
    expect(counts.byWorkspace.get(BILLING)).toBe(1);
    expect(counts.byWorkspace.get(GRAM) ?? 0).toBe(0);
  });

  it("names the threads its items are on, which the Workers panel lists under Needs you", () => {
    expect([...needsYouThreads(needsYouIn(groups, { workspaceId: BILLING }))]).toEqual([
      "t-refunds",
    ]);
    expect(needsYouThreads(needsYouIn(groups, { workspaceId: GRAM })).size).toBe(0);
    // One approval two workers wait on with equal input is one item on both.
    const shared = {
      ...item("ask:push", "approval", "t-form", GRAM),
      ask: {
        group: { entries: [{ threadId: "t-form" }, { threadId: "t-docs" }] },
      } as unknown as Ask,
    };
    expect([...needsYouThreads([shared])].toSorted()).toEqual(["t-docs", "t-form"]);
    // An orchestrator's own question with no thread to open adds no worker.
    expect(needsYouThreads([item("ask:m", "question", undefined, GRAM)]).size).toBe(0);
  });

  it("gives a thread's row the item the Inbox lists it for, errors first", () => {
    const both = [group(undefined, [item("ask:a", "approval", "t-flaky"), redPr])];
    expect(threadNeed(both, "t-flaky" as ThreadId)?.kind).toBe("failure");
    expect(threadNeed(groups, "t-other" as ThreadId)).toBeUndefined();
  });
});

describe("Quiet beside the selector", () => {
  const card = { ask: { key: "q1" } as Ask };

  it("says what needs you that it has no card for, so its count and the pill's add up", () => {
    const rest = notInDeck(needsYouIn(groups, "all"), [card]);
    expect(rest).toEqual([redPr]);
    expect(deckPosition(1)).toBe("1 of 1 to answer");
    expect(restLine(rest)).toBe("1 error waits in the Inbox");
    expect(1 + rest.length).toBe(needsYouCounts(groups).total);
  });

  it("says nothing more when the deck holds everything", () => {
    expect(restLine(notInDeck([question], [card]))).toBeUndefined();
  });
});

describe("a solo row beside the Inbox", () => {
  const stopped: RowStatus = {
    icon: (() => null) as unknown as RowStatus["icon"],
    tone: "text-muted-foreground",
    label: "Stopped",
    title: "Stopped",
    working: false,
  };

  it("says what the Inbox lists it for, in red for a failure, never Stopped", () => {
    expect(soloDisplay(stopped, redPr)).toMatchObject({
      label: "#412 checks failing",
      tone: "text-destructive",
    });
    expect(soloDisplay(stopped, item("w", "wait", "t-flaky"))).toMatchObject({
      tone: "text-status-needs",
    });
  });

  it("keeps its own words with nothing listed, or while it works", () => {
    expect(soloDisplay(stopped, undefined)).toBe(stopped);
    const running = { ...stopped, label: "Running", working: true };
    expect(soloDisplay(running, redPr)).toBe(running);
  });
});

/** A worker spawned and not begun, its session in `status`. */
const facts = (status: ThreadStatus) => ({
  asking: false,
  failed: false,
  state: "briefed" as const,
  status,
});

describe("a worker that has just started", () => {
  it("is starting from spawn to its first turn, whatever its session says meanwhile", () => {
    for (const status of ["cold", "idle", "starting"] as const) {
      expect(workerStarting(facts(status)), status).toBe(true);
      expect(workerTone(facts(status)), status).toBe("working");
    }
  });

  it("is never stopped: briefed at rest is not idle or attention", () => {
    expect(workerTone({ ...facts("idle"), activity: "idle" })).toBe("working");
    expect(workerTone({ ...facts("cold"), activity: "attention" })).toBe("working");
  });

  it("says a wait already armed rather than starting", () => {
    expect(workerTone({ ...facts("idle"), activity: "automation" })).toBe("waiting");
  });

  it("says an ask or a failure instead of starting", () => {
    expect(workerStarting({ ...facts("idle"), asking: true })).toBe(false);
    expect(workerTone({ ...facts("idle"), asking: true })).toBe("needs");
    expect(workerStarting({ ...facts("idle"), failed: true })).toBe(false);
    expect(workerTone({ ...facts("idle"), failed: true })).toBe("error");
    expect(workerStarting(facts("needsApproval"))).toBe(false);
  });

  it("stops being starting once a turn has begun", () => {
    expect(workerStarting({ ...facts("idle"), state: "working" })).toBe(false);
    expect(workerTone({ ...facts("idle"), state: "working", activity: "idle" })).toBe("idle");
  });
});
