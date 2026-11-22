import { describe, expect, it } from "vitest";

import { HANDOFF_GIVE_UP_MS, handoffRunning } from "./board-model";

const failedAt = (at: number) => ({
  agentSessionId: "s-1",
  lastError: { kind: "unknown" as const, retryable: true, text: "x", at },
});

describe("handoffRunning", () => {
  it("knows a handoff by the session it leaves", () => {
    const mark = { fromSession: "s-1", startedAt: 1_000 };
    expect(handoffRunning(undefined, { agentSessionId: "s-1" }, 2_000)).toBe(false);
    expect(handoffRunning(mark, undefined, 2_000)).toBe(false);
    expect(handoffRunning(mark, { agentSessionId: "s-1" }, 2_000)).toBe(true);
    expect(handoffRunning(mark, { agentSessionId: "s-2" }, 2_000)).toBe(false);
    expect(handoffRunning(mark, { agentSessionId: "s-1" }, 1_000 + HANDOFF_GIVE_UP_MS)).toBe(false);
    // A thread that had no session yet is handed off once it has one.
    expect(handoffRunning({ fromSession: undefined, startedAt: 0 }, {}, 1)).toBe(true);
    // A fresh session that didn't open stops claiming to run once the thread says why.
    expect(handoffRunning(mark, failedAt(1_500), 2_000)).toBe(false);
    expect(handoffRunning(mark, failedAt(500), 2_000)).toBe(true);
  });
});
