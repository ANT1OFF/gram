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
