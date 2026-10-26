import { LIMIT_PAUSE_TOOL, type ApprovalRequest, type RequestId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { limitShareText } from "@/usage/limit-format";

import { limitPauseAsk } from "./request-model";

const pause = (input: Record<string, unknown>): ApprovalRequest => ({
  kind: "approval",
  id: "r-pause" as RequestId,
  toolName: LIMIT_PAUSE_TOOL,
  displayName: "limit_pause",
  input,
  suggestions: [],
});

describe("limitPauseAsk", () => {
  it("leads with the held brief's own sentence, the week by its one name", () => {
    const now = Date.UTC(2026, 9, 15, 14, 39);
    const ask = limitPauseAsk(
      pause({
        agent: "claude",
        window: "seven_day",
        usedPct: 90,
        pauseAtPct: 90,
        resetsAt: Date.UTC(2026, 9, 15, 18),
      }),
      now,
      { locale: "en-GB", timeZone: "UTC" },
    );
    expect(ask?.lead).toBe("Claude is at 90% of its weekly limit");
    expect(ask?.lead).toBe(limitShareText({ agent: "claude", usedPct: 90, window: "weekly" }));
    expect(ask?.pause).toBe("Pause until 18:00");
  });
});
