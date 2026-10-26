import type {
  MemoryQuestion,
  PendingRequest,
  RequestId,
  ThreadId,
  WaitId,
  WaitItem,
  WorkerQuestion,
  WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { askOf, memoryAskOf, workerAskOf } from "./ask-model";
import type { FailureItem } from "./needs-you-model";
import {
  filterCounts,
  filterGroups,
  needsYouGroups,
  stepItem,
  THREADS_GROUP,
  type NeedsYouThread,
} from "./needs-you-items";
import { firstRows } from "./needs-you-popover";
import { optionThumbs } from "./needs-you-row";
import { jumpTarget } from "./use-needs-you";

const GRAM = "w-gram" as WorkspaceId;
const ARB = "w-arb" as WorkspaceId;
const ORCH = "t-orch" as ThreadId;

const approval = (id: string): PendingRequest => ({
  kind: "approval",
  id: id as RequestId,
  toolUseId: `tu-${id}`,
  toolName: "Bash",
  displayName: "Bash",
  input: { command: "bun run check" },
  suggestions: [],
});

const approvalAsk = (threadId: string, title: string, id: string) =>
  askOf({
    key: id,
    entries: [
      { threadId: threadId as ThreadId, title, feature: "usage-clocks", request: approval(id) },
    ],
  });

const workerQuestion: WorkerQuestion = {
  id: "WQ1",
  workspaceId: GRAM,
  threadId: "t-collapse" as ThreadId,
  feature: "collapse",
  title: "Orchestrator rows collapse",
  question: "Should a collapsed orchestrator row keep its needs-you count?",
  options: [
    { label: "Keep the count", description: "" },
    { label: "Dot only", description: "" },
  ],
  askedAt: 1_000,
  forwardedAt: 5_000,
  stage: "forwarded",
  triageUntil: 2_000,
};

const memory: MemoryQuestion = {
  id: "Q3",
  text: "Cut 0.2.1 now, or wait for the Usage clocks fix?",
  detail: undefined,
  open: true,
};

const wait = (id: string, createdAt: number, extra: Partial<WaitItem> = {}): WaitItem => ({
  id: id as WaitId,
  kind: "draft",
  title: `Draft ${id}`,
  source: "agent",
  createdAt,
  ...extra,
});

const thread = (
  id: string,
  title: string,
  workspaceId: WorkspaceId | undefined,
  waits: WaitItem[] = [],
  parked = false,
): NeedsYouThread => ({
  thread: { id: id as ThreadId, title, workspaceId, parked },
  waits,
});

const failure = (threadId: string): FailureItem => ({
  kind: "failure",
  key: `failure:checks:example/arb#7:abc`,
  ids: [`failure:checks:example/arb#7:abc`],
  workspaceId: ARB,
  feature: "deploy",
  failure: {
    kind: "checks",
    threadId: threadId as ThreadId,
    title: "Deploy fix",
    project: "arb",
    tag: "#7 checks failing",
  },
});

const sources = () => ({
  workspaces: [
    {
      workspaceId: GRAM,
      name: "Gram",
      orchestratorThreadId: ORCH,
      asks: [
        approvalAsk("t-clocks", "Usage clocks", "r-1"),
        memoryAskOf(GRAM, memory),
        workerAskOf(GRAM, workerQuestion),
      ],
    },
    { workspaceId: ARB, name: "Arb bot", orchestratorThreadId: undefined, asks: [] },
  ],
  failures: new Map([[ARB, [failure("t-gone")]]]),
  threads: [
    thread("t-clocks", "Usage clocks", GRAM, [wait("w-1", 3_000, { kind: "review" })]),
    thread("t-solo", "Solo", undefined, [wait("w-2", 9_000)]),
    thread("t-arb", "Arb worker", ARB, [
      wait("w-3", 4_000),
      wait("w-4", 8_000, { suggested: true }),
      wait("w-5", 7_000, { resolvedAt: 7_500 }),
    ]),
  ],
});

describe("needsYouGroups", () => {
  it("groups every workspace's asks, failures and kept waits, then threads outside any", () => {
    const groups = needsYouGroups(sources());
    expect(groups.map((group) => group.name)).toEqual(["Gram", "Arb bot", "Threads"]);
    expect(groups.at(-1)?.key).toBe(THREADS_GROUP);
    const gram = groups[0]!.items;
    // Newest first; what keeps no time last, in the order it came.
    expect(gram.map((item) => item.kind)).toEqual(["question", "wait", "approval", "question"]);
    // A suggestion and a resolved wait stay out.
    expect(groups[1]!.items.map((item) => item.key)).toEqual([
      "w:t-arb:w-3",
      "failure:checks:example/arb#7:abc",
    ]);
  });

  it("names each item's thread and where its jump lands", () => {
    const [gram] = needsYouGroups(sources());
    const byKind = new Map(gram!.items.map((item) => [item.title, item]));
    const asked = byKind.get(workerQuestion.question)!;
    expect(asked).toMatchObject({ where: "Orchestrator rows collapse", threadId: "t-collapse" });
    expect(jumpTarget(asked)).toEqual({
      kind: "card",
      selector: '[data-testid="worker-question-card"][data-question="WQ1"]',
    });
    const approve = gram!.items.find((item) => item.kind === "approval")!;
    expect(approve).toMatchObject({ where: "Usage clocks", threadId: "t-clocks" });
    expect(jumpTarget(approve)).toMatchObject({ kind: "card", requestId: "r-1" });
    const own = byKind.get(memory.text)!;
    expect(own).toMatchObject({ where: "Orchestrator", threadId: ORCH, inStack: true });
    expect(jumpTarget(own)).toEqual({ kind: "stack", key: own.ask!.key });
  });

  it("opens a wait at the message that added it, or its tray without one", () => {
    const groups = needsYouGroups({
      ...sources(),
      threads: [thread("t-a", "A", GRAM, [wait("w-9", 1, { messageId: "m-9" as never })])],
    });
    const [item] = groups[0]!.items.filter((each) => each.kind === "wait");
    expect(jumpTarget(item!)).toEqual({ kind: "message", messageId: "m-9" });
    const [solo] = needsYouGroups(sources()).at(-1)!.items;
    expect(jumpTarget(solo!)).toEqual({ kind: "tray" });
  });

  it("marks a failure whose worker is gone as owned by no live thread", () => {
    const arb = needsYouGroups(sources())[1]!;
    expect(arb.items.find((item) => item.kind === "failure")?.owned).toBe(false);
    const live = needsYouGroups({
      ...sources(),
      failures: new Map([[ARB, [failure("t-arb")]]]),
    })[1]!;
    expect(live.items.find((item) => item.kind === "failure")?.owned).toBe(true);
  });

  it("lists a solo thread's requests and error with its waits under Threads", () => {
    const stopped: FailureItem = {
      kind: "failure",
      key: "failure:error:t-solo:6000",
      ids: ["failure:error:t-solo:6000"],
      workspaceId: undefined,
      feature: undefined,
      failure: {
        kind: "error",
        threadId: "t-solo" as ThreadId,
        title: "Solo",
        project: "api",
        tag: "Spending limit",
        at: 6_000,
      },
    };
    const asked = askOf({
      key: "r-solo",
      entries: [{ threadId: "t-solo" as ThreadId, title: "Solo", request: approval("r-solo") }],
    });
    const groups = needsYouGroups({ ...sources(), solo: { asks: [asked], failures: [stopped] } });
    const threads = groups.at(-1)!;
    expect(threads.key).toBe(THREADS_GROUP);
    // Newest first, the request, which keeps no time, last.
    expect(threads.items.map((item) => [item.kind, item.threadId])).toEqual([
      ["wait", "t-solo"],
      ["failure", "t-solo"],
      ["approval", "t-solo"],
    ]);
    const approve = threads.items.at(-1)!;
    expect(approve).toMatchObject({ where: "Solo", command: "bun run check" });
    expect(approve.inStack).toBeUndefined();
    expect(jumpTarget(approve)).toMatchObject({ kind: "card", requestId: "r-solo" });
    expect(threads.items[1]).toMatchObject({ owned: true, title: "Spending limit" });
    expect(filterCounts(groups)).toEqual({ all: 9, asks: 4, waits: 3, failing: 2 });
    // Later and a dismiss put them away as any other.
    const away = needsYouGroups({
      ...sources(),
      solo: { asks: [asked], failures: [stopped] },
      away: new Set(["r-solo", "failure:error:t-solo:6000"]),
    });
    expect(away.at(-1)!.items.map((item) => item.kind)).toEqual(["wait"]);
  });

  it("leaves out what is put away and drops groups left empty", () => {
    const groups = needsYouGroups({
      ...sources(),
      away: new Set(["w:t-solo:w-2", "w:t-arb:w-3", "failure:checks:example/arb#7:abc"]),
    });
    expect(groups.map((group) => group.name)).toEqual(["Gram"]);
  });
});

describe("filters", () => {
  it("count each family and show only one", () => {
    const groups = needsYouGroups(sources());
    expect(filterCounts(groups)).toEqual({ all: 7, asks: 3, waits: 3, failing: 1 });
    const failing = filterGroups(groups, "failing");
    expect(failing.map((group) => group.name)).toEqual(["Arb bot"]);
    expect(filterGroups(groups, "all")).toEqual(groups);
  });
});

describe("stepItem", () => {
  const items = needsYouGroups(sources()).flatMap((group) => group.items);

  it("starts at the first going forward and the last going back", () => {
    expect(stepItem(items, undefined, 1)).toBe(items[0]);
    expect(stepItem(items, undefined, -1)).toBe(items.at(-1));
  });

  it("moves on from the current item and wraps", () => {
    expect(stepItem(items, items[0]!.key, 1)).toBe(items[1]);
    expect(stepItem(items, items.at(-1)!.key, 1)).toBe(items[0]);
    expect(stepItem(items, items[0]!.key, -1)).toBe(items.at(-1));
    expect(stepItem([], undefined, 1)).toBeUndefined();
  });
});

describe("firstRows", () => {
  it("shares the rows out across the groups and counts the rest", () => {
    const groups = needsYouGroups(sources());
    // Every group gets a row before any gets a second.
    const three = firstRows(groups, 3);
    expect(three.groups.map((group) => group.items.length)).toEqual([1, 1, 1]);
    expect(three.more).toBe(4);
    const five = firstRows(groups, 5);
    expect(five.groups.map((group) => group.items.length)).toEqual([2, 2, 1]);
    expect(five.groups[0]!.items).toEqual(groups[0]!.items.slice(0, 2));
    expect(firstRows(groups, 20).more).toBe(0);
  });
});

describe("optionThumbs", () => {
  it("numbers each pictured quick option as its answer button, the pick first", () => {
    const pictured = workerAskOf(GRAM, {
      ...workerQuestion,
      recommended: "Dot only",
      options: [
        { label: "Keep the count", description: "", image: "shots/keep.png" },
        { label: "Dot only", description: "", image: "shots/dot.png" },
        { label: "Neither", description: "" },
      ],
    });
    const [item] = needsYouGroups({
      workspaces: [
        { workspaceId: GRAM, name: "Gram", orchestratorThreadId: ORCH, asks: [pictured] },
      ],
      failures: new Map(),
      threads: [],
    })[0]!.items;
    expect(optionThumbs(item!)).toEqual([
      { number: 1, label: "Dot only", image: "shots/dot.png" },
      { number: 2, label: "Keep the count", image: "shots/keep.png" },
    ]);
    // Without pictures, none.
    const plain = needsYouGroups(sources())[0]!.items.find((each) => each.ask?.worker);
    expect(optionThumbs(plain!)).toEqual([]);
  });
});
