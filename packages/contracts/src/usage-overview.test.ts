import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { UsageSummary } from "./domain.ts";
import { AgentEvent } from "./agent.ts";
import { UsageOverview, UsageOverviewQuery } from "./usage-overview.ts";
const minimal = {
  from: 1,
  to: 2,
  timezone: "UTC",
  provider: null,
  totals: {
    totalTokens: 3,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unclassifiedInputTokens: 1,
    outputTokens: 2,
  },
  recordedTurns: 1,
  recordedConversations: 1,
  missingUsageTurns: 0,
  invalidUsageTurns: 0,
  unattributedTurns: 0,
  unknownModelTurns: 1,
  incompleteCacheTurns: 1,
  interruptedTurns: 0,
  openTurns: 0,
  rows: [],
};
describe("optional usage history fields", () => {
  it("decodes responses, snapshots and events that omit them without adding provenance", () => {
    expect(Schema.decodeUnknownSync(UsageOverview)(minimal)).toEqual(minimal);
    const usage = { tokens: { inputTokens: 1, outputTokens: 2 } };
    expect(Schema.decodeUnknownSync(UsageSummary)(usage)).toEqual(usage);
    expect(Schema.decodeUnknownSync(AgentEvent)({ ...usage, type: "usage" })).toEqual({
      ...usage,
      type: "usage",
    });
    expect(Schema.decodeUnknownSync(UsageOverviewQuery)({ days: 7 })).toEqual({ days: 7 });
  });
  it("round trips additive historical quota samples and skipped metadata coverage", () => {
    const data = {
      ...minimal,
      localLimitHistory: {
        observations: [
          { provider: "codex", window: "five_hour", at: 1, utilization: 0.42, resetsAt: 2 },
        ],
        invalidReadings: 1,
        truncated: true,
      },
    };
    expect(Schema.decodeUnknownSync(UsageOverview)(data)).toEqual(data);
  });
  it.each(["codex-request-delta-v1", "codex-last-request-v1"])(
    "round trips %s through event and snapshot contracts",
    (telemetryVersion) => {
      const usage = {
        tokens: { inputTokens: 1, outputTokens: 2 },
        partial: true,
        telemetryVersion,
      };
      expect(Schema.decodeUnknownSync(UsageSummary)(usage)).toEqual(usage);
      expect(Schema.decodeUnknownSync(AgentEvent)({ ...usage, type: "usage" })).toEqual({
        ...usage,
        type: "usage",
      });
    },
  );
  it("refuses unsupported markers, while old missing provenance stays absent", () => {
    expect(() =>
      Schema.decodeUnknownSync(UsageSummary)({
        tokens: { inputTokens: 1, outputTokens: 2 },
        telemetryVersion: "session-total-v1",
      }),
    ).toThrow();
  });
});
