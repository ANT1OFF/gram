import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { ReopenedClosedThread, ReopenedMembership } from "./closed-threads.ts";
import { Thread } from "./domain.ts";
import { expectRoundTrip } from "./test-utils.ts";

const thread = Schema.decodeUnknownSync(Thread)({
  id: "t-1",
  projectId: "p-1",
  title: "Address feedback",
  userNamed: true,
  model: { agent: "claude", model: "default" },
  mode: "auto",
  checkout: { kind: "worktree", path: "/repo/.worktrees/x", repoRoot: "/repo", branch: "x" },
  labels: [],
  pinned: false,
  parked: false,
  unread: false,
  workspaceId: "w-1",
  spawnedBy: { threadId: "t-0", feature: "x" },
  createdAt: 1,
  lastActivityAt: 2,
});

describe("ReopenedClosedThread", () => {
  it("round-trips a reopen, a session shown elsewhere, and every membership", () => {
    for (const membership of ReopenedMembership.literals) {
      expectRoundTrip(ReopenedClosedThread, {
        closed: { thread, closedAt: 3, problem: "folderMissing" },
        thread,
        membership,
      });
    }
    expectRoundTrip(ReopenedClosedThread, {
      closed: { thread, closedAt: 3, problem: "sessionOpen", openThreadId: thread.id },
    });
  });

  it("refuses a membership it doesn't know", () => {
    expect(() =>
      Schema.decodeUnknownSync(ReopenedClosedThread)({
        closed: { thread, closedAt: 3 },
        thread,
        membership: "lost",
      }),
    ).toThrow();
  });
});
