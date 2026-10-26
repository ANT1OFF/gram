import type { ProjectId, Thread, ThreadId, ThreadSummary } from "@gram/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { switchOrder, useThreadHistory } from "./thread-history";
import { useThreadsStore } from "./threads";

const thread = (id: string, lastActivityAt = 0): Thread => ({
  id: id as ThreadId,
  projectId: "p" as ProjectId,
  title: id,
  userNamed: false,
  model: { agent: "claude", model: "opus" },
  mode: "default",
  checkout: { kind: "main", path: "/repo" },
  labels: [],
  pinned: false,
  parked: false,
  unread: false,
  createdAt: 0,
  lastActivityAt,
});

const summary = (id: string, lastActivityAt: number): ThreadSummary => ({
  thread: thread(id, lastActivityAt),
  status: "idle",
  pendingRequests: [],
  queue: [],
});

afterEach(() => {
  useThreadHistory.setState({ recent: [] });
});

describe("useThreadHistory", () => {
  it("keeps the most recently focused thread first", () => {
    const { touch } = useThreadHistory.getState();
    touch("a" as ThreadId);
    touch("b" as ThreadId);
    touch("a" as ThreadId);
    expect(useThreadHistory.getState().recent).toEqual(["a", "b"]);
  });

  it("drops a thread the server removes from the focus order", () => {
    const closing = thread("t-close");
    useThreadsStore.getState().applyEvent({ type: "thread.upsert", thread: closing });
    useThreadHistory.getState().touch(closing.id);
    useThreadsStore.getState().applyEvent({ type: "thread.removed", threadId: closing.id });
    expect(useThreadHistory.getState().recent).not.toContain("t-close");
  });
});

describe("switchOrder", () => {
  it("puts focused threads first, then the rest by activity, skipping closed ones", () => {
    const summaries = [summary("old", 1), summary("new", 3), summary("mid", 2), summary("seen", 0)];
    expect(switchOrder(["seen", "gone"] as ThreadId[], summaries)).toEqual([
      "seen",
      "new",
      "mid",
      "old",
    ]);
  });
});
