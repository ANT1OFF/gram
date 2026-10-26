// @vitest-environment happy-dom
import type { ProjectId, ThreadId, ThreadStatus, ThreadSummary } from "@gram/contracts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useAttentionStore } from "@/sidebar/attention";
import { useThreadsStore } from "@/stores/threads";

import { titleFor, useNeedsYouTitle } from "./use-needs-you-title";

const summary = (id: string, status: ThreadStatus, parked = false): ThreadSummary => ({
  status,
  pendingRequests: [],
  queue: [],
  thread: {
    id: id as ThreadId,
    projectId: "p" as ProjectId,
    title: id,
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: "/" },
    labels: [],
    pinned: false,
    parked,
    unread: false,
    createdAt: 0,
    lastActivityAt: 0,
  },
});

const byId = (...summaries: ThreadSummary[]) =>
  Object.fromEntries(summaries.map((s) => [s.thread.id, s])) as never;

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} as never });
  useAttentionStore.setState({ loaded: false, acknowledged: {} });
});

describe("titleFor", () => {
  it("puts the count in front and drops it at zero", () => {
    expect(titleFor(2)).toBe("(2) Gram");
    expect(titleFor(0)).toBe("Gram");
  });
});

describe("useNeedsYouTitle", () => {
  it("follows the needs-you count, ignoring parked threads, and clears at zero", () => {
    useThreadsStore.setState({
      byId: byId(summary("a", "needsApproval"), summary("b", "running")),
    });
    renderHook(() => useNeedsYouTitle());
    expect(document.title).toBe("(1) Gram");

    act(() =>
      useThreadsStore.setState({
        byId: byId(
          summary("a", "needsApproval"),
          summary("c", "error"),
          summary("d", "needsInput", true),
        ),
      }),
    );
    expect(document.title).toBe("(2) Gram");

    act(() => useThreadsStore.setState({ byId: byId(summary("b", "running")) }));
    expect(document.title).toBe("Gram");
  });

  it("counts PR attention once acknowledgements load, and drops it once seen", () => {
    const failing = {
      ...summary("a", "idle"),
      git: {
        repo: true,
        branch: "fix",
        pr: {
          number: 7,
          state: "OPEN",
          url: "https://github.com/o/r/pull/7",
          title: "Fix",
          isDraft: false,
          checks: "failing",
          headMatches: true,
          aheadOfPr: false,
          headRefOid: "abc",
        },
      },
    } as ThreadSummary;
    useThreadsStore.setState({ byId: byId(failing) });
    renderHook(() => useNeedsYouTitle());
    expect(document.title).toBe("Gram");

    act(() => useAttentionStore.getState().hydrate([]));
    expect(document.title).toBe("(1) Gram");

    act(() => void useAttentionStore.getState().acknowledge("a" as ThreadId, "ci:7:abc"));
    expect(document.title).toBe("Gram");
  });
});
