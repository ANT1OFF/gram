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
  briefTitle,
  kindsText,
  needsYouGroups,
  needsYouSections,
  newestAsk,
  type NeedsYouItem,
  scopeLines,
  sectionOf,
  sectionsIn,
  stepItem,
  THREADS_GROUP,
  type NeedsYouThread,
} from "./needs-you-items";
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
    // A jump opens the thread that asked, at its card: a worker's question in the worker.
    expect(jumpTarget(asked)).toEqual({
      kind: "card",
      selector: `[data-testid="worker-question-card"][data-question="${asked.ask!.worker!.question.id}"]`,
    });
    const approve = gram!.items.find((item) => item.kind === "approval")!;
    expect(approve).toMatchObject({ where: "Usage clocks", threadId: "t-clocks" });
    expect(jumpTarget(approve)).toMatchObject({ kind: "card", requestId: approve.ask!.ids[0] });
    // The orchestrator's own question opens the orchestrator.
    const own = byKind.get(memory.text)!;
    expect(own).toMatchObject({ where: "Orchestrator", threadId: ORCH });
    expect(jumpTarget(own)).toEqual({ kind: "thread" });
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
    expect(jumpTarget(approve)).toMatchObject({ kind: "card", requestId: "r-solo" });
    expect(threads.items[1]).toMatchObject({ owned: true, title: "Spending limit" });
    expect(groups.flatMap((group) => group.items)).toHaveLength(9);
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

describe("scopeLines", () => {
  it("says how much of the total is here and how much is in each other place", () => {
    const groups = needsYouGroups(sources());
    const lines = scopeLines(groups, { workspaceId: ARB, name: "Arb bot" });
    expect(lines[0]).toBe("Here (Arb bot): 1 error, 1 draft");
    expect(lines.slice(1)).toEqual([
      `Gram: ${kindsText(groups[0]!.items)}`,
      `Threads outside a workspace: ${kindsText(groups[2]!.items)}`,
    ]);
  });

  it("says nothing needs you here when the workspace has no share, and has no here off one", () => {
    const groups = needsYouGroups(sources());
    const quiet = "w-quiet" as WorkspaceId;
    expect(scopeLines(groups, { workspaceId: quiet, name: "Quiet" })[0]).toBe(
      "Here (Quiet): nothing needs you",
    );
    expect(scopeLines(groups, undefined)).toHaveLength(3);
    expect(scopeLines([], undefined)).toEqual([]);
  });
});

describe("sectionsIn", () => {
  it("shows one category, or every one for All or a category with nothing left", () => {
    const sections = needsYouSections(needsYouGroups(sources()));
    expect(sectionsIn(sections, "errors").map((section) => section.key)).toEqual(["errors"]);
    expect(sectionsIn(sections, "all")).toBe(sections);
    // Nothing to take: the list falls back to all rather than standing empty.
    expect(sectionsIn(sections, "steps")).toBe(sections);
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

/** The section a wait of `kind` is listed in. */
const sectionOfWait = (kind: WaitItem["kind"]) =>
  sectionOf({ kind: "wait", wait: { item: wait("w", 1, { kind }), view: { kind } as never } });

describe("needsYouSections", () => {
  it("lists by kind across workspaces, each item saying its workspace", () => {
    const sections = needsYouSections(needsYouGroups(sources()));
    // What stops work first, drafts last.
    expect(sections.map((section) => section.key)).toEqual([
      "errors",
      "approvals",
      "questions",
      "reviews",
      "drafts",
    ]);
    const [errors, approvals, questions, reviews, drafts] = sections;
    expect(approvals!.items.map((item) => [item.title, item.workspace])).toEqual([
      [expect.any(String), "Gram"],
    ]);
    // The worker's and the orchestrator's questions, both Gram's.
    expect(questions!.items.map((item) => item.workspace)).toEqual(["Gram", "Gram"]);
    expect(reviews!.items.map((item) => item.ids)).toEqual([[expect.stringContaining("w-1")]]);
    // Drafts from Arb's worker and from the thread outside any workspace, which names none.
    expect(drafts!.items.map((item) => item.workspace)).toEqual(
      expect.arrayContaining(["Arb bot", undefined]),
    );
    expect(errors!.items.map((item) => [item.kind, item.workspaceId])).toEqual([["failure", ARB]]);
    // Every item is in one section, and none is lost.
    expect(sections.flatMap((section) => section.items)).toHaveLength(
      needsYouGroups(sources()).flatMap((group) => group.items).length,
    );
  });

  it("puts a decision with the questions and a step to take apart", () => {
    expect(sectionOfWait("decision")).toBe("questions");
    expect(sectionOfWait("action")).toBe("steps");
    expect(sectionOfWait("review")).toBe("reviews");
    expect(sectionOfWait("draft")).toBe("drafts");
  });
});

/** A bare item of `kind`, asked at `when`. */
const at = (key: string, kind: NeedsYouItem["kind"], when?: number): NeedsYouItem => ({
  key,
  ids: [key],
  kind,
  title: key,
  where: "Worker",
  threadId: undefined,
  owned: true,
  at: when,
});

describe("newestAsk and kindsText", () => {
  it("opens on the newest request, then other waits, then errors", () => {
    const error = at("e", "failure", 9);
    const waiting = at("w", "wait", 8);
    expect(newestAsk([error, at("q", "question", 1), at("a", "approval", 4)])?.key).toBe("a");
    expect(newestAsk([error, waiting])?.key).toBe("w");
    expect(newestAsk([at("e1", "failure", 1), error])?.key).toBe("e");
    expect(newestAsk([])).toBeUndefined();
    // What keeps no time is oldest.
    expect(newestAsk([at("x", "question"), at("y", "question", 1)])?.key).toBe("y");
  });

  it("says what items ask by kind, errors apart", () => {
    expect(kindsText([at("q", "question", 1), at("e", "failure", 2), at("e2", "failure")])).toBe(
      "2 errors, 1 question",
    );
    expect(kindsText([])).toBe("");
  });
});

describe("briefTitle", () => {
  const question = (title: string) => ({ title, kind: "question" as const });

  it("keeps a short title whole", () => {
    expect(briefTitle(question("Retry for 24 hours or 72?"))).toBe("Retry for 24 hours or 72?");
    expect(briefTitle({ title: "Allow", kind: "approval" })).toBe("Allow");
  });

  it("calls a long question by what it is about, when it says that first", () => {
    expect(
      briefTitle(
        question(
          "A refund webhook that keeps failing: retry for 24 hours, or 72 hours like charges do?",
        ),
      ),
    ).toBe("A refund webhook that keeps failing");
    expect(
      briefTitle(
        question(
          'The docs repo has no preview deploy. Is a merged PR enough for "preview deployed" there?',
        ),
      ),
    ).toBe("The docs repo has no preview deploy");
  });

  it("cuts a long one at a word, never mid-word", () => {
    const brief = briefTitle(
      question(
        "Should the mail trigger retry when the provider answers 429, or drop the mail and report it?",
      ),
    );
    expect(brief).toBe("Should the mail trigger retry when the provider answers…");
    expect(brief.length).toBeLessThanOrEqual(57);
  });

  it("doesn't split on a lead too short to name anything", () => {
    expect(
      briefTitle(question("Q: which of the three retry policies should refunds use from now on?")),
    ).toBe("Q: which of the three retry policies should refunds use…");
  });

  it("doesn't split what isn't a question", () => {
    const title = "Review the release notes for 0.9: wording, order and the links to each PR";
    expect(briefTitle({ title, kind: "wait" })).toBe(
      "Review the release notes for 0.9: wording, order and the…",
    );
  });
});
