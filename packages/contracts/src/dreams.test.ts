import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  Dream,
  DreamMode,
  DREAM_BUDGET_TOKENS_MAX,
  DREAM_BUDGET_TOKENS_MIN,
  DREAM_INSTRUCTIONS_MAX,
  DreamBudgetTokens,
  DreamId,
  type DreamInputs,
  DreamMerge,
  DreamRead,
  DreamReport,
} from "./dreams.ts";
import { ThreadId, WorkspaceId } from "./ids.ts";

const inputs: DreamInputs = {
  memoryVersion: "0007",
  threadIds: [ThreadId.make("t1"), ThreadId.make("t2")],
  agentSessions: [{ agent: "claude", cwd: "/repo/.worktrees/a", agentSessionId: "s-1" }],
};

const dream: Dream = {
  id: DreamId.make("dream-0001"),
  workspaceId: WorkspaceId.make("ws1"),
  mode: "review",
  status: "completed",
  inputs,
  instructions: "Focus on how the three repos deploy.",
  model: { agent: "claude", model: "sonnet" },
  threadId: ThreadId.make("t-dream"),
  outputDir: "/data/orchestration/ws1/dreams/dream-0001",
  usage: { tokens: { inputTokens: 1200, outputTokens: 300 }, costUsd: 0.42 },
  createdAt: 1_700_000_000_000,
  filesClosedAt: 1_700_000_599_000,
  endedAt: 1_700_000_600_000,
  kind: "import",
  adoptedVersion: "0008",
  notes: ["12 older sessions were left out: a dream reads at most 100."],
};

describe("dream contracts", () => {
  it("refuses an unknown mode, a merge state with no meaning, and an over-long report excerpt", () => {
    expect(() => Schema.decodeUnknownSync(DreamMode)("fullAuto")).toThrow();
    const model = { agent: "claude", model: "opus" } as const;
    expect(() =>
      Schema.decodeUnknownSync(DreamMerge)({ status: "queued", model, startedAt: 1 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(DreamReport)({
        dreamId: dream.id,
        status: "completed",
        files: [],
        reportExcerpt: "x".repeat(2001),
      }),
    ).toThrow();
  });

  it("holds a dream's budget to the range", () => {
    for (const ok of [DREAM_BUDGET_TOKENS_MIN, DREAM_BUDGET_TOKENS_MAX]) {
      expect(Schema.decodeUnknownSync(DreamBudgetTokens)(ok)).toBe(ok);
    }
    for (const bad of [DREAM_BUDGET_TOKENS_MIN - 1, DREAM_BUDGET_TOKENS_MAX + 1, 20_000.5]) {
      expect(() => Schema.decodeUnknownSync(DreamBudgetTokens)(bad)).toThrow();
    }
  });

  it("reads only from a thread or the archive", () => {
    const read = {
      threadId: ThreadId.make("t1"),
      source: "session",
      fromSeq: 0,
      throughSeq: 0,
      messages: 0,
      estimatedTokens: 0,
    };
    expect(() => Schema.decodeUnknownSync(DreamRead)(read)).toThrow();
  });

  it("refuses an id that couldn't be a folder name, and over-long instructions", () => {
    const decodeId = Schema.decodeUnknownSync(DreamId);
    expect(() => decodeId("../escape")).toThrow();
    expect(() => decodeId("short")).toThrow();
    expect(decodeId("0b9f6c2e-1111-4222-8333-444455556666")).toBeTypeOf("string");
    const decode = Schema.decodeUnknownSync(Dream);
    const encoded = Schema.encodeSync(Dream)(dream);
    expect(() =>
      decode({ ...encoded, instructions: "x".repeat(DREAM_INSTRUCTIONS_MAX + 1) }),
    ).toThrow();
    expect(decode({ ...encoded, instructions: "x".repeat(DREAM_INSTRUCTIONS_MAX) }).id).toBe(
      dream.id,
    );
  });
});
