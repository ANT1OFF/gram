import {
  initialBabysitState,
  type ProjectId,
  type ThreadId,
  type ThreadStatus,
  type ThreadSummary,
} from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAttentionStore } from "@/sidebar/attention";
import { needsYou, sectionOf } from "@/sidebar/grouping";
import { useThreadsStore } from "@/stores/threads";

import { needsYouCount, resetDerivedAsks, useDerivedAsks } from "./needs-you-store";

// The window title, the dock badge and the sidebar's pill all show `needsYouCount`: Needs you's
// items. Every thread the sidebar puts under Needs you must have one, or the pill says less than
// the title used to.

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

/** An idle solo thread whose open PR's required checks fail, which nobody has looked at yet. */
const redPr = (id: string): ThreadSummary =>
  ({
    ...summary(id, "idle"),
    git: {
      repo: true,
      branch: "fix",
      pr: {
        number: 412,
        state: "OPEN",
        url: "https://github.com/o/r/pull/412",
        title: "Fix",
        isDraft: false,
        checks: "failing",
        headMatches: true,
        aheadOfPr: false,
        headRefOid: "abc",
      },
    },
  }) as ThreadSummary;

const showing = (...summaries: ThreadSummary[]) =>
  useThreadsStore.setState({
    byId: Object.fromEntries(summaries.map((s) => [s.thread.id, s])) as never,
  });

beforeEach(() => {
  useAttentionStore.getState().hydrate([]);
  useDerivedAsks.getState().setQueried({
    workspaces: [],
    questions: new Map(),
    ledgers: new Map(),
    projects: [],
  });
});

afterEach(() => {
  resetDerivedAsks();
  useThreadsStore.setState({ byId: {} as never });
  useAttentionStore.setState({ loaded: false, acknowledged: {} });
});

describe("needsYouCount", () => {
  it("counts approvals, questions and errors, but not parked threads", () => {
    showing(
      summary("a", "needsApproval"),
      summary("b", "needsInput"),
      summary("c", "error"),
      summary("d", "running"),
      summary("e", "needsApproval", true),
    );
    expect(needsYouCount()).toBe(3);
  });

  it("counts what the sidebar puts under Needs you: a babysit stopped at rest too", () => {
    const stopped = { ...initialBabysitState(0), phase: "stopped" as const };
    const quiet = summary("f", "idle");
    const babysat = { ...quiet, thread: { ...quiet.thread, babysit: stopped } };
    expect(sectionOf(babysat)).toBe("needsYou");
    showing(babysat, summary("g", "idle"));
    expect(needsYouCount()).toBe(1);
    expect(useDerivedAsks.getState().needsYou.items[0]?.title).toBe("Babysit stopped");
  });

  it("lists a solo thread whose PR's red build is unseen, so the pill says what the title says", () => {
    const red = redPr("t-flaky");
    showing(red, summary("idle", "idle"));
    expect(needsYou(red)).toBe(true);
    expect(needsYouCount()).toBe(1);
    const [item] = useDerivedAsks.getState().needsYou.items;
    expect(item?.threadId).toBe("t-flaky");
    expect(item?.title).toBe("#412 checks failing");

    // Seen: the thread leaves the sidebar's Needs you, and the count with it.
    useAttentionStore.getState().acknowledge("t-flaky" as ThreadId, "ci:412:abc");
    expect(needsYou(red)).toBe(false);
    expect(needsYouCount()).toBe(0);
  });

  it("adds nothing for a thread its error already shows", () => {
    showing(summary("c", "error"));
    expect(useDerivedAsks.getState().needsYou.items.map((item) => item.kind)).toEqual(["failure"]);
    expect(needsYouCount()).toBe(1);
  });
});
