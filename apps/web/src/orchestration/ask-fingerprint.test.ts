import type {
  ApprovalRequest,
  MemoryQuestion,
  PendingRequest,
  RequestId,
  ThreadId,
  WorkerQuestion,
  WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { askFingerprint } from "./ask-actions";
import { askOf, memoryAskOf, workerAskOf, type Ask } from "./ask-model";
import { groupInbox } from "./inbox-model";

// An ask that keeps its key while what it asks changes must read as another ask: the Inbox and Quiet
// start it afresh, so a key pressed in the moment after never answers words nobody read.

const W = "w" as WorkspaceId;

const requestAsk = (request: PendingRequest): Ask => {
  const [group] = groupInbox([
    { threadId: "t-1" as ThreadId, title: "Thread", feature: undefined, request },
  ]);
  return askOf(group!);
};

const approval = (more: Partial<ApprovalRequest> = {}): PendingRequest => ({
  kind: "approval",
  id: "codex-s-0" as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input: { command: "git push" },
  suggestions: [],
  ...more,
});

const question = (text: string, description: string): PendingRequest => ({
  kind: "question",
  id: "codex-s-1" as RequestId,
  questions: [
    {
      question: text,
      header: "Pick",
      multiSelect: false,
      options: [
        { label: "A", description },
        { label: "B", description: "" },
      ],
    },
  ],
});

const memory = (more: Partial<MemoryQuestion> = {}): Ask =>
  memoryAskOf(W, {
    id: "Q1",
    text: "Ship the form first?",
    detail: "From the brief.",
    open: true,
    options: [{ label: "Yes", description: "Ship it" }, { label: "No" }],
    ...more,
  });

const worker = (more: Partial<WorkerQuestion> = {}): Ask =>
  workerAskOf(W, {
    id: "WQ1",
    workspaceId: W,
    threadId: "t-cart" as ThreadId,
    feature: "cart",
    title: "Cart API",
    question: "404 or 410?",
    context: "Clients cache 404s.",
    note: "Affects the client too.",
    options: [{ label: "404" }, { label: "410", description: "Gone" }],
    askedAt: 1_000,
    triageUntil: 601_000,
    stage: "forwarded",
    ...more,
  });

describe("an ask's fingerprint", () => {
  it.each([
    ["an approval's title", requestAsk(approval()), requestAsk(approval({ title: "Push main?" }))],
    [
      "an approval's description",
      requestAsk(approval()),
      requestAsk(approval({ description: "Pushes everything" })),
    ],
    ["a question's text", requestAsk(question("A or B?", "")), requestAsk(question("B or A?", ""))],
    [
      "a choice's description",
      requestAsk(question("A or B?", "")),
      requestAsk(question("A or B?", "Deletes the data")),
    ],
    ["a memory question's detail", memory(), memory({ detail: "Says the reviewer." })],
    [
      "a memory question's choice",
      memory(),
      memory({ options: [{ label: "Yes", description: "Drop the old form" }, { label: "No" }] }),
    ],
    ["a worker question's context", worker(), worker({ context: "Nobody caches." })],
    ["a worker question's note", worker(), worker({ note: "Only this worker." })],
    [
      "a worker question's choice",
      worker(),
      worker({ options: [{ label: "404" }, { label: "410", description: "Purges" }] }),
    ],
  ])("changes with %s, under the same key", (_what, before, after) => {
    expect(after.key).toBe(before.key);
    expect(askFingerprint(after)).not.toBe(askFingerprint(before));
  });

  it("is the same for the same ask read again", () => {
    expect(askFingerprint(worker())).toBe(askFingerprint(worker()));
    expect(askFingerprint(requestAsk(approval()))).toBe(askFingerprint(requestAsk(approval())));
  });
});
