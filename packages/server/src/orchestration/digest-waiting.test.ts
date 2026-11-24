import { describe, expect, it } from "vitest";
import type { ThreadId, WaitId, WaitItem } from "@gram/contracts";
import { digestWaiting } from "./digest-waiting.ts";

const MIN = 60_000;
const ORCH = "orch" as ThreadId;
const WORKER = "worker" as ThreadId;

const ended = (id: string, at: number, rest: Partial<WaitItem>): WaitItem => ({
  id: id as WaitId,
  kind: "action",
  title: `Item ${id}`,
  source: "agent",
  createdAt: 0,
  resolvedAt: at,
  ...rest,
});

describe("digestWaiting's endings", () => {
  it("tells the orchestrator what the user dismissed and a worker withdrew apart from done", () => {
    const digest = digestWaiting({
      variant: "digest",
      orchestrator: ORCH,
      now: 200 * MIN,
      since: 120 * MIN,
      threads: [
        {
          threadId: ORCH,
          items: [ended("w-1", 150 * MIN, { resolvedBy: "agent", ending: "withdrawn" })],
        },
        {
          threadId: WORKER,
          items: [
            ended("w-2", 150 * MIN, { resolvedBy: "user" }),
            ended("w-3", 151 * MIN, { resolvedBy: "user", ending: "dismissed", note: "moot" }),
            ended("w-4", 152 * MIN, { resolvedBy: "agent", ending: "withdrawn" }),
            ended("w-5", 153 * MIN, {
              resolvedBy: "agent",
              ending: "withdrawn",
              resolverThread: ORCH,
            }),
            ended("w-6", 100 * MIN, { resolvedBy: "user", ending: "dismissed" }),
          ],
        },
      ],
    });
    // The orchestrator's own withdrawals, of its items or its workers', it made knowingly.
    expect(digest).toEqual({
      open: 0,
      kinds: [],
      resolved: ["Item w-2"],
      dismissed: [{ threadId: WORKER, id: "w-3", title: "Item w-3", note: "moot" }],
      withdrawn: [{ threadId: WORKER, id: "w-4", title: "Item w-4" }],
    });
  });
});

const open = (id: string, createdAt: number): WaitItem => ({
  id: id as WaitId,
  kind: "action",
  title: `Item ${id}`,
  source: "agent",
  createdAt,
});

describe("digestWaiting's stale items", () => {
  it("counts every thread's open items and names the archived or merged threads' between boots", () => {
    const threads = [
      { threadId: ORCH, items: [open("w-1", 10 * MIN)], title: "Orchestrator" },
      { threadId: WORKER, items: [open("w-2", 20 * MIN)], title: "Live", stale: undefined },
      {
        threadId: "gone" as ThreadId,
        items: [open("w-3", 30 * MIN)],
        title: "Gone",
        stale: "archived" as const,
      },
    ];
    const digest = digestWaiting({ variant: "digest", now: 60 * MIN, since: 0, threads });
    expect(digest).toMatchObject({
      open: 3,
      stale: 1,
      items: [{ threadId: "gone", thread: "Gone", id: "w-3", stale: "archived", ageMin: 30 }],
    });
    // A boot names them all, the stale one still flagged.
    const boot = digestWaiting({ variant: "boot", now: 60 * MIN, since: undefined, threads });
    expect(boot?.items?.map((item) => [item.id, item.stale])).toEqual([
      ["w-1", undefined],
      ["w-2", undefined],
      ["w-3", "archived"],
    ]);
  });
});
