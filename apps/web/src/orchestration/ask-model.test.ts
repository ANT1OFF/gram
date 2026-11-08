import type {
  ApprovalRequest,
  PendingRequest,
  RequestId,
  ThreadId,
  WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  answerRule,
  askOf,
  asksOf,
  choiceLayout,
  memoryAskOf,
  otherIndex,
  replyAction,
  replyChips,
  stepIndex,
  workerAskOf,
} from "./ask-model";
import { groupInbox, type InboxEntry } from "./inbox-model";

const push = (id: string, command = "git push -u origin feat/mail-trigger"): ApprovalRequest => ({
  kind: "approval",
  id: id as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input: { command },
  suggestions: [],
});

const entry = (id: string, feature: string | undefined, request: PendingRequest): InboxEntry => ({
  threadId: id as ThreadId,
  title: `Title of ${id}`,
  feature,
  request,
});

const question = (id: string, options: readonly string[], more = {}): PendingRequest => ({
  kind: "question",
  id: id as RequestId,
  questions: [
    {
      question: "Keep both, or uv only?",
      header: "Installer",
      multiSelect: false,
      options: options.map((label) => ({ label, description: "" })),
      ...more,
    },
  ],
});

const labels = (...all: string[]) =>
  all.map((label) => ({ label, done: label, action: { kind: "memory", answer: label } }) as const);

describe("the ask stack's asks", () => {
  it("says the orchestrator only for the orchestrator's own asks, not a solo thread's", () => {
    const [own] = groupInbox([{ ...entry("o", undefined, push("r-o")), orchestrator: true }]);
    const [solo] = groupInbox([entry("s", undefined, push("r-s"))]);
    expect(askOf(own!).context).toBe("orchestrator · Title of o");
    expect(askOf(solo!).context).toBe("Title of s");
  });

  it("makes equal pushes one ask that shows the exact command and answers them all", () => {
    const [group] = groupInbox([
      entry("a", "mail", push("r-a")),
      entry("b", "mail", push("r-b")),
      entry("c", "mail", push("r-c")),
    ]);
    const ask = askOf(group!);
    expect(ask.command).toBe("git push -u origin feat/mail-trigger");
    expect(ask.lead).toBe("Allow");
    expect(ask.count).toBe(3);
    expect(ask.key).toBe("r-a,r-b,r-c");
    expect(ask.context).toBe("mail · Title of a and 2 more");
    expect(ask.options.map((option) => option.label)).toEqual(["Allow 3 once", "Deny"]);
    expect(ask.options[0]!.action).toEqual({ kind: "group", decision: "allow" });
  });

  it("offers the thread card's verbs, Always allow this rule… for one ask with a rule to keep", () => {
    const rule = {
      ...push("r-a"),
      suggestions: [
        {
          type: "addRules" as const,
          rules: [{ toolName: "Bash", ruleContent: "git push:*" }],
          behavior: "allow" as const,
          destination: "localSettings" as const,
        },
      ],
    };
    const ask = askOf(groupInbox([entry("a", undefined, rule)])[0]!);
    expect(ask.options.map((option) => option.label)).toEqual([
      "Allow once",
      "Always allow this rule…",
      "Deny",
    ]);
    // It opens the card on what it would keep; it never saves from here.
    expect(ask.options[1]!.action).toEqual({ kind: "open", threadId: "a", always: true });
    expect(ask.options.map((option) => option.done)).toEqual(["Allowed once", "Opened", "Denied"]);
    // Still one row of verbs, however long the always label.
    expect(choiceLayout(ask.options)).toBe("row");
    // An agent that keeps no rule, or a card restricted to once, offers no always.
    expect(askOf(groupInbox([entry("a", undefined, push("r-b"))])[0]!).options).toHaveLength(2);
    const once = { ...rule, scopes: ["once" as const] };
    expect(askOf(groupInbox([entry("a", undefined, once)])[0]!).options).toHaveLength(2);
  });

  it("names a tool that isn't a command beside its exact subject", () => {
    const write: ApprovalRequest = {
      ...push("r-w"),
      toolName: "Write",
      displayName: "Write",
      input: { file_path: "docs/setup.md", content: "…" },
    };
    const ask = askOf(groupInbox([entry("a", "docs", write)])[0]!);
    expect(ask.lead).toBe("Allow Write");
    expect(ask.command).toBe("docs/setup.md");
    expect(ask.options.map((option) => option.label)).toEqual(["Allow once", "Deny"]);
  });

  it("shows a question's own options, and answers in words when it has none", () => {
    const choice = askOf(
      groupInbox([entry("a", "docs", question("q", ["uv only", "Keep both"]))])[0]!,
    );
    expect(choice.options.map((option) => option.label)).toEqual(["uv only", "Keep both"]);
    expect(choice.options[1]!.action).toEqual({
      kind: "answer",
      answer: { kind: "question", answers: { "Keep both, or uv only?": ["Keep both"] } },
    });
    const free = askOf(groupInbox([entry("a", "docs", question("q", []))])[0]!);
    expect(free.options).toEqual([]);
    expect(free.freeForm).toEqual({
      question: "Keep both, or uv only?",
      request: { threadId: "a", requestId: "q" },
    });
  });

  it("offers Other… after a question's choices, and sends its words as that question's answer", () => {
    const choice = askOf(
      groupInbox([entry("a", "docs", question("q", ["uv only", "Keep both"]))])[0]!,
    );
    expect(choice.other).toEqual({ question: "Keep both, or uv only?" });
    expect(otherIndex(choice)).toBe(2);
    expect(replyAction(choice, "pip, pinned")).toEqual({
      kind: "answer",
      answer: { kind: "question", answers: { "Keep both, or uv only?": ["pip, pinned"] } },
    });
    const memory = memoryAskOf("w" as WorkspaceId, {
      id: "Q1",
      text: "Retry or drop?",
      detail: undefined,
      open: true,
      options: [{ label: "Retry" }, { label: "Drop" }],
    });
    expect(otherIndex(memory)).toBe(2);
    expect(replyAction(memory, "Retry twice, then drop")).toEqual({
      kind: "memory",
      answer: "Retry twice, then drop",
    });
    const worker = workerAskOf("w" as WorkspaceId, {
      id: "WQ1",
      workspaceId: "w" as WorkspaceId,
      threadId: "t" as ThreadId,
      feature: "cart",
      title: "Cart API",
      question: "404 or 410?",
      askedAt: 1,
      triageUntil: 2,
      stage: "forwarded",
      options: [{ label: "404" }, { label: "410" }],
    });
    expect(replyAction(worker, "410, with a body")).toEqual({
      kind: "worker",
      answer: "410, with a body",
    });
    // An ask with no choices answers in its reply field; an approval takes no words at all.
    const free = askOf(groupInbox([entry("a", "docs", question("q", []))])[0]!);
    expect(otherIndex(free)).toBeUndefined();
    expect(replyAction(free, "uv")).toMatchObject({ kind: "answer" });
    const allow = askOf(groupInbox([entry("a", "docs", push("r1"))])[0]!);
    expect(otherIndex(allow)).toBeUndefined();
    expect(replyAction(allow, "yes")).toBeUndefined();
  });

  it("opens what needs more than a pick, and never approves a plan in one key", () => {
    const multi = askOf(
      groupInbox([entry("a", "docs", question("q", ["a", "b"], { multiSelect: true }))])[0]!,
    );
    expect(multi.options.map((option) => option.action.kind)).toEqual(["open"]);
    const plan = askOf(
      groupInbox([entry("a", "auth", { kind: "plan", id: "p" as RequestId, plan: "1. a" })])[0]!,
    );
    expect(plan.options.map((option) => option.label)).toEqual(["Review"]);
    expect(plan.options.map((option) => option.action.kind)).toEqual(["open"]);
  });

  it("picks a question's choices before Send answer, and acts on an approval's verbs", () => {
    const choice = askOf(
      groupInbox([entry("a", "docs", question("q", ["uv only", "Keep both"]))])[0]!,
    );
    expect(answerRule(choice.options)).toBe("pick");
    const memory = memoryAskOf("w" as WorkspaceId, {
      id: "Q1",
      text: "Retry or drop?",
      detail: undefined,
      open: true,
      options: [{ label: "Retry" }, { label: "Drop" }],
      recommended: "Drop",
    });
    expect(answerRule(memory.options)).toBe("pick");
    const allow = askOf(groupInbox([entry("a", "docs", push("r1"))])[0]!);
    expect(answerRule(allow.options)).toBe("act");
    const plan = askOf(
      groupInbox([entry("a", "auth", { kind: "plan", id: "p" as RequestId, plan: "1. a" })])[0]!,
    );
    expect(answerRule(plan.options)).toBe("act");
    expect(answerRule([])).toBe("act");
  });

  it("shows what else an Allow covers: other arguments, the description, each member's checkout", () => {
    const timed: ApprovalRequest = {
      ...push("r-t"),
      input: { command: "git push -u origin feat/mail-trigger", timeout: 600_000 },
      description: "Publish the branch.",
    };
    const [group] = groupInbox([
      { ...entry("a", "mail", timed), checkout: { path: "/w/a", branch: "feat/a" } },
    ]);
    const ask = askOf(group!);
    expect(ask.extras).toEqual([{ label: "timeout", value: "600000" }]);
    expect(ask.description).toBe("Publish the branch.");
    expect(ask.members).toEqual([
      { title: "Title of a", project: undefined, checkout: { path: "/w/a", branch: "feat/a" } },
    ]);
    // Nothing in the input beyond what the lines show: no Details for it.
    expect(ask.details).toBeUndefined();
    const long: ApprovalRequest = { ...push("r-l"), input: { command: "x", env: "y".repeat(200) } };
    expect(askOf(groupInbox([entry("a", "mail", long)])[0]!).details?.kind).toBe("json");
  });

  it("puts the orchestrator's own asks first, keeps what needs reading in its cards", () => {
    const groups = groupInbox([
      entry("o", undefined, push("r-o")),
      entry("o", undefined, { kind: "plan", id: "p-o" as RequestId, plan: "1. a" }),
      entry("a", "mail", push("r-a")),
    ]);
    const asks = asksOf({
      groups,
      workspaceId: "w" as WorkspaceId,
      orchestratorId: "o" as ThreadId,
      questions: [
        { id: "Q1", text: "Ship today?", detail: undefined, open: true, options: [] },
        {
          id: "Q2",
          text: "Retry or drop?",
          detail: undefined,
          open: true,
          options: [{ label: "Drop" }, { label: "Retry" }],
          recommended: "Retry",
        },
      ],
    });
    expect(asks.map((ask) => ask.key)).toEqual(["r-o", "memory:w:Q1", "memory:w:Q2", "r-a"]);
    expect(asks[1]!.freeForm).toEqual({ question: "Ship today?" });
    // The orchestrator's pick first, read first.
    expect(asks[2]!.options.map((option) => option.label)).toEqual(["Retry", "Drop"]);
    expect(asks[2]!.options[0]!.action).toEqual({ kind: "memory", answer: "Retry" });
    expect(asks[2]!.options.map((option) => option.recommended)).toEqual([true, undefined]);
  });

  it("keeps each choice's description, and lists choices that wouldn't fit a row", () => {
    const ask = memoryAskOf("w" as WorkspaceId, {
      id: "Q5",
      text: "Where do workers go?",
      detail: undefined,
      open: true,
      options: [
        { label: "Docked", description: "Beside the orchestrator." },
        { label: "Tabs", description: " " },
      ],
    });
    expect(ask.options.map((option) => option.description)).toEqual([
      "Beside the orchestrator.",
      undefined,
    ]);
    expect(choiceLayout(ask.options)).toBe("list");
    expect(choiceLayout(labels("Allow", "Deny"))).toBe("row");
    expect(choiceLayout(labels("a", "b", "c"))).toBe("row");
    expect(choiceLayout(labels("a", "b", "c", "d"))).toBe("list");
    expect(choiceLayout(labels("Yes", "Docked workers panel on the right"))).toBe("list");
  });

  it("takes answered requests out of a group before it becomes an ask", () => {
    const groups = groupInbox([
      entry("a", "mail", push("r-a")),
      entry("b", "mail", push("r-b")),
      entry("c", "mail", push("r-c")),
    ]);
    const [ask] = asksOf({ groups, hidden: new Set(["r-a", "r-b"]) });
    expect(ask!.ids).toEqual(["r-c"]);
    expect(ask!.options[0]!.label).toBe("Allow once");
    expect(asksOf({ groups, hidden: new Set(["r-a", "r-b", "r-c"]) })).toEqual([]);
  });

  it("keeps a suggested reply only at six words or fewer, three at most", () => {
    expect(
      replyChips([
        "Say no packages yet",
        "This one is far too long to be a chip",
        " ",
        "Leave it blank",
        "Link it",
        "One more",
      ]),
    ).toEqual(["Say no packages yet", "Leave it blank", "Link it"]);
  });

  it("steps around the asks", () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});

describe("an ask's pictures", () => {
  const options = [
    {
      label: "A Inbox",
      image: "/repo/mock/shots/a-inbox-dark.png",
      preview: "/repo/mock/v1.html#a-inbox",
    },
    { label: "C Hybrid" },
  ];

  it("carries an orchestrator question's screenshots and mock, read through the orchestrator", () => {
    const ask = memoryAskOf(
      "w" as WorkspaceId,
      {
        id: "Q1",
        text: "Which?",
        detail: undefined,
        open: true,
        options,
        mock: "/repo/mock/mock.json",
      },
      "t-orc" as ThreadId,
    );
    expect(ask.visuals).toEqual({
      threadId: "t-orc",
      options,
      recommended: undefined,
      mock: "/repo/mock/mock.json",
    });
  });

  it("has none without pictures, or without a thread to read them through", () => {
    const plain = {
      id: "Q2",
      text: "Which?",
      detail: undefined,
      open: true,
      options: [{ label: "A" }, { label: "B" }],
    };
    expect(memoryAskOf("w" as WorkspaceId, plain, "t-orc" as ThreadId).visuals).toBeUndefined();
    expect(
      memoryAskOf("w" as WorkspaceId, { ...plain, options }, undefined).visuals,
    ).toBeUndefined();
  });
});
