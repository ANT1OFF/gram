import {
  initialBabysitState,
  type ProjectId,
  type ThreadId,
  type ThreadStatus,
  type ThreadSummary,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { sectionOf } from "@/sidebar/grouping";

import { needsYouCount } from "./use-desktop-bridge";

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

describe("needsYouCount", () => {
  it("counts approvals, questions and errors, but not parked threads", () => {
    expect(
      needsYouCount([
        summary("a", "needsApproval"),
        summary("b", "needsInput"),
        summary("c", "error"),
        summary("d", "running"),
        summary("e", "needsApproval", true),
      ]),
    ).toBe(3);
  });

  it("counts what the sidebar puts under Needs you: a babysit stopped at rest too", () => {
    const stopped = { ...initialBabysitState(0), phase: "stopped" as const };
    const quiet = summary("f", "idle");
    const babysat = { ...quiet, thread: { ...quiet.thread, babysit: stopped } };
    expect(sectionOf(babysat)).toBe("needsYou");
    expect(needsYouCount([babysat, summary("g", "idle")])).toBe(1);
  });
});
