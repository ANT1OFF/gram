import type { ProjectId, Thread, ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { checksOutcome, resumeBrief, threadDidWork } from "./empty-thread";

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

describe("resumeBrief", () => {
  it("names the thread, quotes its last report and points at its PR", () => {
    const at = new Date(2026, 10, 5, 8, 33).getTime();
    const brief = resumeBrief(
      "Release notes for 0.9",
      { at, summary: "0.9 notes cover undo.\n" },
      { number: 61, repo: "example/docs", state: "merged" },
    );
    expect(brief).toBe(
      [
        'Pick up where "Release notes for 0.9" left off.',
        "",
        `Its last report (${brief.match(/\((.+)\):/)?.[1]}):`,
        "0.9 notes cover undo.",
        "",
        "Its pull request: #61 in example/docs (merged).",
      ].join("\n"),
    );
    expect(brief).toContain("08:33");
  });

  it("says only what it has", () => {
    expect(resumeBrief("Docs", undefined, undefined)).toBe('Pick up where "Docs" left off.');
  });
});

describe("checksOutcome", () => {
  it("says how a saved PR's checks last read, in words", () => {
    expect(checksOutcome("passing")?.word).toBe("Passed");
    expect(checksOutcome("failing")?.word).toBe("Failed");
    expect(checksOutcome("pending")?.word).toBe("Still running when it was saved");
    expect(checksOutcome("none")?.word).toBe("None ran");
    expect(checksOutcome(undefined)).toBeUndefined();
  });
});
