import type { ProjectId, Thread, ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { threadDidWork } from "./empty-thread";

const thread = (fields: Partial<Thread> = {}): Thread =>
  ({
    id: "t1" as ThreadId,
    projectId: "p" as ProjectId,
    title: "t1",
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: "/repo" },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 1,
    lastActivityAt: 1,
    ...fields,
  }) as Thread;

describe("threadDidWork", () => {
  it("is false for a thread that hasn't started, its session unused", () => {
    expect(threadDidWork(thread(), undefined)).toBe(false);
    expect(
      threadDidWork(thread({ agentSessionId: "s", agentSessionUnused: true }), undefined),
    ).toBe(false);
  });

  it("is true once it has a used session, a completion, a PR, a merge or a report", () => {
    expect(threadDidWork(thread({ agentSessionId: "s" }), undefined)).toBe(true);
    expect(threadDidWork(thread({ completedAt: 5 }), undefined)).toBe(true);
    expect(
      threadDidWork(thread({ boundPr: { repo: "o/r", number: 1, monitor: false } }), undefined),
    ).toBe(true);
    expect(
      threadDidWork(thread({ settledMerge: { merged: [{ number: 1, url: "u" }] } }), undefined),
    ).toBe(true);
    expect(
      threadDidWork(thread(), {
        lastReport: { threadId: "t1" as ThreadId, state: "done", summary: "Done.", at: 5 },
      } as never),
    ).toBe(true);
  });
});
