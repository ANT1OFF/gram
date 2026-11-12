// @vitest-environment happy-dom
import type { ProjectId, ThreadId, ThreadStatus, ThreadSummary } from "@gram/contracts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_SHELL, useEmbedShell } from "@/embed/store";
import { resetDerivedAsks, useDerivedAsks } from "@/orchestration/needs-you-store";
import { useAttentionStore } from "@/sidebar/attention";
import { useThreadsStore } from "@/stores/threads";

import { titleFor, useNeedsYouTitle } from "./use-needs-you-title";

const at = vi.hoisted(() => ({ page: undefined as string | undefined }));

// The page's name as the title bar has it, which the embed slots' own tests cover.
vi.mock("@/embed/slots", () => ({ useEmbedPageTitle: () => at.page }));

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

beforeEach(() => {
  // What `NeedsYouSource` hands in for a window with no workspaces.
  useDerivedAsks.getState().setQueried({
    workspaces: [],
    questions: new Map(),
    ledgers: new Map(),
    projects: [],
  });
});

afterEach(() => {
  cleanup();
  resetDerivedAsks();
  useThreadsStore.setState({ byId: {} as never });
  useAttentionStore.setState({ loaded: false, acknowledged: {} });
  useEmbedShell.setState(EMPTY_SHELL);
  at.page = undefined;
});

// An embedding app's tab title, and one that fails.
const title = ({ name, needsYou }: { name: string | undefined; needsYou: number }) =>
  `${needsYou > 0 ? `(${needsYou}) ` : ""}${name ?? "Acme"} · Acme`;
const broken = (): string => {
  throw new Error("no");
};

describe("titleFor", () => {
  it("puts the count in front and drops it at zero", () => {
    expect(titleFor(2)).toBe("(2) Gram");
    expect(titleFor(0)).toBe("Gram");
  });

  it("is the embedding app's when it names the tab, and Gram's own if that throws", () => {
    expect(titleFor(1, { title }, "Policies")).toBe("(1) Policies · Acme");
    expect(titleFor(0, { title }, undefined)).toBe("Acme · Acme");
    expect(titleFor(2, {})).toBe("(2) Gram");
    expect(titleFor(2, { title: broken }, "Policies")).toBe("(2) Gram");
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

describe("useNeedsYouTitle in an app in front of Gram", () => {
  it("follows the page, the count and a replaced title", () => {
    useEmbedShell.setState({
      document: { title: ({ name, needsYou }) => `${needsYou}:${name ?? "-"}` },
    });
    at.page = "Policies";
    const { rerender } = renderHook(() => useNeedsYouTitle());
    expect(document.title).toBe("0:Policies");

    act(() => useThreadsStore.setState({ byId: byId(summary("a", "needsApproval")) }));
    expect(document.title).toBe("1:Policies");

    at.page = undefined;
    rerender();
    expect(document.title).toBe("1:-");

    act(() => useEmbedShell.setState({ document: {} }));
    expect(document.title).toBe("(1) Gram");
  });
});
