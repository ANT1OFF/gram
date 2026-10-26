import type {
  MemoryQuestion,
  MessageId,
  PendingRequest,
  RequestId,
  GramUIMessage,
  ThreadId,
  WaitId,
  WaitItem,
  WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  byThread,
  copyTextOf,
  keptWaits,
  linkHost,
  noteShown,
  primaryAction,
  recentlyResolved,
  RESOLVED_SHOWN_MS,
  trayLabel,
  trayNames,
  trayViews,
  undoableHelperResolves,
  waitBreakdown,
  waitCount,
  waitingViews,
} from "./waiting-model";

const item = (id: string, kind: WaitItem["kind"], title: string, extra: Partial<WaitItem> = {}) =>
  ({
    id: id as WaitId,
    kind,
    title,
    source: "agent",
    createdAt: 1,
    ...extra,
  }) satisfies WaitItem;

const summary = (waits: WaitItem[] | undefined) => ({
  thread: { id: "t-1" as ThreadId },
  ...(waits === undefined ? {} : { waits }),
});

const message = (...texts: string[]): GramUIMessage => ({
  id: "m-1" as MessageId,
  role: "assistant",
  parts: texts.map((text) => ({ type: "text", text })),
});

describe("the tray's rows", () => {
  const views = trayViews(
    summary([
      item("w-1", "draft", "Teams message to Kari: rollout", { body: "Ask her\nfor a date" }),
      item("w-2", "draft", "Release note"),
      item("w-3", "review", "example/api#431", { link: "https://github.com/example/api/pull/431" }),
      item("w-4", "action", "Run assume example-prod"),
    ]),
  );

  it("lists the thread's open items with a one-line preview", () => {
    expect(trayViews(summary(undefined))).toEqual([]);
    expect(views.map((v) => v.key)).toEqual(["w:t-1:w-1", "w:t-1:w-2", "w:t-1:w-3", "w:t-1:w-4"]);
    expect(views[0]?.preview).toBe("Ask her for a date");
  });

  it("counts and breaks them down in words, leaving suggestions out", () => {
    expect(waitCount(views)).toBe(4);
    expect(waitBreakdown(views)).toBe("4 waiting on you: 2 drafts, 1 review, 1 step to take");
    expect(waitBreakdown([{ ...views[0]!, suggested: true }])).toBe("0 waiting on you");
    expect(waitCount([{ ...views[0]!, suggested: true }])).toBe(0);
  });

  it("names each on the collapsed line up to its colon, and reads them all aloud", () => {
    expect(trayNames(views)).toEqual([
      "Teams message to Kari",
      "Release note",
      "example/api#431",
      "Run assume example-prod",
    ]);
    expect(trayLabel(views.slice(0, 2))).toBe(
      "2 waiting on you: 2 drafts. Teams message to Kari: rollout; Release note",
    );
  });

  it("lists a helper's suggestion as one, names it apart, and keeps Undo for ten minutes", () => {
    const suggested = trayViews(
      summary([
        item("w-1", "draft", "Release note"),
        item("w-5", "review", "Design doc", { source: "helper", suggested: true }),
      ]),
    );
    expect(suggested.map((v) => v.suggested)).toEqual([undefined, true]);
    expect(waitCount(suggested)).toBe(1);
    expect(trayLabel(suggested)).toBe(
      "1 waiting on you: 1 draft. Release note Suggested: Design doc",
    );
    const resolved = (at: number) =>
      item(`w-${at}`, "draft", "Sent", { resolvedAt: at, resolvedBy: "helper" });
    const now = 20 * 60_000;
    expect(
      undoableHelperResolves(
        { ...summary(undefined), helperResolved: [resolved(now - 60_000), resolved(1)] },
        now,
      ).map((i) => i.id),
    ).toEqual([`w-${now - 60_000}`]);
  });

  it("offers Copy, Open or Answer by kind", () => {
    expect(primaryAction("draft")).toBe("copy");
    expect(primaryAction("review")).toBe("open");
    expect(primaryAction("decision")).toBe("answer");
    expect(primaryAction("action")).toBeUndefined();
    expect(linkHost("https://github.com/example/api/pull/431")).toBe("github.com");
    expect(linkHost("nope")).toBeUndefined();
  });
});

describe("what Copy copies", () => {
  const draft = item("w-1", "draft", "Teams message");

  it("is the item's copy text when it has one", () => {
    expect(copyTextOf({ ...draft, copy: "exact" }, message("```\nother\n```"))).toBe("exact");
  });

  it("is the message's one fenced or quoted block", () => {
    expect(copyTextOf(draft, message("Here it is:\n\n```text\nHi Kari,\n\nThursday.\n```"))).toBe(
      "Hi Kari,\n\nThursday.",
    );
    expect(copyTextOf(draft, message("Send this:", "> Hi Kari,\n> Thursday.\n\nThat's all."))).toBe(
      "Hi Kari,\nThursday.",
    );
  });

  it("is the whole text when it has none or several, and the title without a message", () => {
    expect(copyTextOf(draft, message("Hi Kari, Thursday."))).toBe("Hi Kari, Thursday.");
    const two = "```\na\n```\n\n> b";
    expect(copyTextOf(draft, message(two))).toBe(two);
    expect(copyTextOf(draft, undefined)).toBe("Teams message");
    expect(copyTextOf({ ...draft, body: "why" }, message())).toBe("why");
  });
});

describe("the Resolved line and the told line", () => {
  it("lists the last day's resolved items, latest first", () => {
    const now = 10 * RESOLVED_SHOWN_MS;
    const done = (id: string, ago: number): WaitItem => ({
      ...item(id, "draft", id),
      resolvedAt: now - ago,
      resolvedBy: "user",
    });
    const items = [done("w-1", 5_000), item("w-2", "draft", "open"), done("w-3", 1_000)];
    expect(
      recentlyResolved([...items, done("w-4", RESOLVED_SHOWN_MS)], now).map((i) => i.id),
    ).toEqual(["w-3", "w-1"]);
  });

  it("shows the note without its fence", () => {
    expect(noteShown('<gram-note>The user marked done: "A" (w-1).</gram-note>')).toBe(
      'The user marked done: "A" (w-1).',
    );
  });
});

const question = (id: string, text: string, extra: Partial<MemoryQuestion> = {}) =>
  ({ id, text, detail: undefined, open: true, ...extra }) satisfies MemoryQuestion;

const thread = (
  id: string,
  waits: WaitItem[],
  pendingRequests: PendingRequest[] = [],
  lastActivityAt = 50,
) => ({
  thread: { id: id as ThreadId, title: `Thread ${id}`, lastActivityAt },
  waits,
  pendingRequests,
});

describe("one view across sources and threads", () => {
  const workspaceId = "w-1" as WorkspaceId;
  const asked = {
    workspaceId,
    questions: [
      question("Q1", "Merge api first?", { detail: "Both\nare green", date: "2026-10-08" }),
    ],
  };
  const approval: PendingRequest = {
    kind: "approval",
    id: "r-1" as RequestId,
    toolName: "Bash",
    displayName: "Bash",
    input: { command: "git push\n--force" },
    suggestions: [],
  };
  const plan: PendingRequest = { kind: "plan", id: "r-2" as RequestId, plan: "1. Do it" };

  it("folds an orchestrator's open questions in after its own items", () => {
    const views = trayViews(summary([item("w-1", "draft", "Release note")]), asked);
    expect(views.map((view) => [view.key, view.kind, view.source])).toEqual([
      ["w:t-1:w-1", "draft", "agent"],
      ["q:w-1:Q1", "question", "question"],
    ]);
    expect(views[1]).toMatchObject({
      threadId: "t-1",
      title: "Merge api first?",
      preview: "Both are green",
      createdAt: Date.parse("2026-10-08"),
    });
    expect(waitBreakdown(views)).toBe("2 waiting on you: 1 draft, 1 question");
  });

  it("lists every thread's items, requests and questions, oldest first", () => {
    const views = waitingViews(
      [
        thread("t-1", [item("w-1", "draft", "Teams message", { createdAt: 100 })], [approval], 20),
        thread("t-2", [], [plan], 30),
      ],
      [
        { ...asked, orchestratorId: "t-orch" as ThreadId },
        { ...asked, workspaceId: "w-2" as WorkspaceId, orchestratorId: undefined },
      ],
    );
    expect(views.map((view) => view.key)).toEqual([
      "r:t-1:r-1",
      "r:t-2:r-2",
      "w:t-1:w-1",
      "q:w-1:Q1",
    ]);
    expect(views[0]).toMatchObject({
      kind: "approval",
      source: "request",
      title: "Bash: git push --force",
      preview: "Thread t-1",
    });
    expect(views[1]).toMatchObject({ kind: "plan", title: "Its plan, to approve" });
    expect(views[3]?.threadId).toBe("t-orch");
  });

  it("leaves a helper's suggestions to their own thread's tray", () => {
    const suggestion = item("w-4", "draft", "Suggested", { source: "helper", suggested: true });
    const kept = item("w-1", "draft", "Note");
    const views = waitingViews([thread("t-1", [kept, suggestion])]);
    expect(views.map((view) => view.key)).toEqual(["w:t-1:w-1"]);
    expect(keptWaits({ waits: [kept, suggestion] })).toEqual([kept]);
    expect(trayViews(thread("t-1", [kept, suggestion])).map((view) => view.suggested)).toEqual([
      undefined,
      true,
    ]);
  });

  it("groups rows by thread in the order given, unknown threads last", () => {
    const views = waitingViews([
      thread("t-2", [item("w-2", "review", "PR")]),
      thread("t-1", [item("w-1", "draft", "Note"), item("w-3", "action", "Run it")]),
      thread("t-9", [item("w-9", "action", "Elsewhere")]),
    ]);
    expect(
      byThread(views, ["t-1" as ThreadId, "t-2" as ThreadId]).map((group) => [
        group.threadId,
        group.views.length,
      ]),
    ).toEqual([
      ["t-1", 2],
      ["t-2", 1],
      ["t-9", 1],
    ]);
  });
});
