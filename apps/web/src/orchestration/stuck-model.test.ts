import type { Thread, ThreadId, WorkerLedgerEntry } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { NOW_LINE_WORDS } from "./workers-model";
import { factLines, idleFor, nudgesFor, stalledSince, STUCK_AFTER_MS } from "./stuck-model";

const NOW = new Date(2026, 9, 15, 14, 40).getTime();
const HOUR = 60 * 60_000;

const entry = (patch: Partial<WorkerLedgerEntry> = {}) =>
  ({
    state: "working",
    pendingRequests: [],
    userIntervened: false,
    ...patch,
  }) as WorkerLedgerEntry;
const thread = (patch: Partial<Thread> = {}) =>
  ({
    id: "t1" as ThreadId,
    title: "Page the list",
    lastActivityAt: NOW - 2 * HOUR,
    ...patch,
  }) as Thread;

describe("why is it stuck", () => {
  it("offers itself once a worker has sat STUCK_AFTER_MS without a turn, tool call or report", () => {
    expect(STUCK_AFTER_MS).toBe(45 * 60_000);
    expect(stalledSince(entry(), thread(), "idle", NOW)).toBe(NOW - 2 * HOUR);
    expect(
      stalledSince(entry(), thread({ lastActivityAt: NOW - STUCK_AFTER_MS + 1 }), "idle", NOW),
    ).toBeUndefined();
    // A report since counts as moving.
    const reported = entry({
      lastReport: {
        threadId: "t1" as ThreadId,
        state: "progress",
        summary: "x",
        at: NOW - 10 * 60_000,
      },
    });
    expect(stalledSince(reported, thread(), "idle", NOW)).toBeUndefined();
  });

  it("stays out of the way of a finished worker, an ask, and a worker the user holds", () => {
    for (const state of ["merged", "delivered", "archived"] as const) {
      expect(stalledSince(entry({ state }), thread(), "idle", NOW)).toBeUndefined();
    }
    expect(stalledSince(entry(), thread(), "needsApproval", NOW)).toBeUndefined();
    expect(stalledSince(entry(), thread(), "needsInput", NOW)).toBeUndefined();
    expect(stalledSince(entry({ userIntervened: true }), thread(), "idle", NOW)).toBeUndefined();
    // Work still running under a resting thread is working, as its tone says.
    expect(stalledSince(entry(), thread(), "idle", NOW, true)).toBeUndefined();
    expect(
      stalledSince(
        entry({
          pendingRequests: [
            { kind: "question", ageMin: 3 },
          ] as WorkerLedgerEntry["pendingRequests"],
        }),
        thread(),
        "idle",
        NOW,
      ),
    ).toBeUndefined();
    expect(
      stalledSince(entry(), thread({ completedReason: "agent" }), "idle", NOW),
    ).toBeUndefined();
  });

  it("says how long in one unit, and the plain facts without a helper", () => {
    expect(idleFor(NOW - 50 * 60_000, NOW)).toBe("idle 50 min");
    expect(idleFor(NOW - 2 * HOUR - 5 * 60_000, NOW)).toBe("idle 2 h");
    expect(idleFor(NOW - 3 * 24 * HOUR, NOW)).toBe("idle 3 d");
    expect(
      factLines({
        idleSince: 0,
        lastError: "rate limited",
        lastReport: {
          threadId: "t1" as ThreadId,
          state: "progress",
          summary: "Waiting on paging.",
          at: 0,
        },
        lastTool: "Bash gh pr list",
        prs: ["web#91 open, checks failing"],
      }),
    ).toEqual([
      "Failed: rate limited",
      "Reported progress: Waiting on paging.",
      "Last ran Bash gh pr list",
      "web#91 open, checks failing",
    ]);
  });

  it("offers short nudges that only carry words, Check CI only with a PR", () => {
    const withPr = nudgesFor(thread(), { idleSince: NOW - 2 * HOUR, prs: ["web#91 open"] }, NOW);
    expect(withPr.map((nudge) => nudge.label)).toEqual([
      "Continue",
      "Check CI",
      "Rebase",
      "Ask orchestrator",
    ]);
    for (const nudge of withPr)
      expect(nudge.label.split(" ").length).toBeLessThanOrEqual(NOW_LINE_WORDS);
    expect(nudgesFor(thread(), { idleSince: 0, prs: [] }, NOW).map((n) => n.id)).not.toContain(
      "checkCi",
    );
    const ask = withPr.find((nudge) => nudge.id === "askOrchestrator")!;
    expect(ask.to).toBe("orchestrator");
    expect(ask.text).toContain("[thread t1]");
    expect(ask.text).toContain("idle 2 h");
  });
});
