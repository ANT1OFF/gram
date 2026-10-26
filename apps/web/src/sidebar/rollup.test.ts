import type { ProjectId, Thread, ThreadId, ThreadStatus, ThreadSummary } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { rollupOf } from "./grouping";

const summary = (
  id: string,
  status: ThreadStatus,
  thread: Partial<Thread> = {},
): ThreadSummary => ({
  status,
  pendingRequests: [],
  queue: [],
  thread: {
    id: id as ThreadId,
    projectId: "p-api" as ProjectId,
    title: id,
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
    ...thread,
  } as Thread,
});

describe("rollupOf", () => {
  it("picks the most urgent status", () => {
    expect(
      rollupOf([summary("a", "idle"), summary("b", "needsApproval"), summary("c", "running")]),
    ).toBe("needsYou");
    expect(rollupOf([summary("a", "idle"), summary("b", "running")])).toBe("working");
    expect(rollupOf([summary("a", "idle", { completedAt: 5 }), summary("b", "cold")])).toBe("idle");
    expect(rollupOf([summary("a", "idle", { completedAt: 5 })])).toBe("settled");
  });

  it("ignores pinned and parked flags, and is undefined for no threads", () => {
    expect(rollupOf([summary("a", "running", { pinned: true, parked: true })])).toBe("working");
    expect(rollupOf([])).toBeUndefined();
  });
});
