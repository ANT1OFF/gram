import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  Dream,
  DreamMode,
  DREAM_BUDGET_TOKENS_MAX,
  DREAM_BUDGET_TOKENS_MIN,
  DREAM_INSTRUCTIONS_MAX,
  DreamBudgetTokens,
  DreamFailure,
  DreamFileDiff,
  DreamFileStatus,
  DreamId,
  DreamInputs,
  DreamMerge,
  DreamMergeStatus,
  DreamPlan,
  DreamRead,
  DreamReport,
  DreamResolution,
  DreamReview,
  DreamStatus,
  DreamWatermark,
  ImportPreview,
  MemoryFileInfo,
  MemoryVersionInfo,
  SessionTranscript,
} from "./dreams.ts";
import { ProjectId, ThreadId, WorkspaceId } from "./ids.ts";
import { expectRoundTrip } from "./test-utils.ts";

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
  it("persists explicit per-run modes and adoption outcomes", () => {
    expectRoundTrip(Dream, dream);
    expectRoundTrip(Dream, { ...dream, mode: "auto" });
    for (const adoptionFailure of ["refused", "persistence_error", "interrupted"] as const) {
      expectRoundTrip(Dream, { ...dream, mode: "auto", adoptionFailure });
      expectRoundTrip(DreamReport, {
        dreamId: dream.id,
        status: "completed",
        mode: "auto",
        adoptionFailure,
        files: [],
      });
    }
    expectRoundTrip(DreamReport, {
      dreamId: dream.id,
      status: "completed",
      mode: "auto",
      adoptedVersion: "0008",
      files: [],
    });
    expect(() => Schema.decodeUnknownSync(DreamMode)("fullAuto")).toThrow();
  });
  it("round-trips a dream at its fullest and at its barest", () => {
    expectRoundTrip(Dream, dream);
    expectRoundTrip(Dream, {
      id: DreamId.make("dream-0002"),
      workspaceId: WorkspaceId.make("ws1"),
      kind: "dream",
      mode: "review",
      status: "failed",
      failure: "input_tampered",
      inputs: { memoryVersion: "", threadIds: [], agentSessions: [] },
      model: { agent: "claude", model: "haiku" },
      outputDir: "/data/orchestration/ws1/dreams/dream-0002",
      createdAt: 1,
    });
    expectRoundTrip(DreamInputs, inputs);
  });

  it("round-trips a dream's plan and backlog, and holds its budget to the range", () => {
    const backlog = { threads: 12, messages: 340, estimatedTokens: 80_000 };
    const plan: DreamPlan = {
      memoryVersion: "0007",
      fromStart: false,
      threads: 5,
      messages: 172,
      estimatedTokens: 196_000,
      budgetTokens: 200_000,
      backlog,
    };
    expectRoundTrip(DreamPlan, plan);
    expectRoundTrip(Dream, { ...dream, budgetTokens: 200_000, backlog });
    for (const ok of [DREAM_BUDGET_TOKENS_MIN, DREAM_BUDGET_TOKENS_MAX]) {
      expect(Schema.decodeUnknownSync(DreamBudgetTokens)(ok)).toBe(ok);
    }
    for (const bad of [DREAM_BUDGET_TOKENS_MIN - 1, DREAM_BUDGET_TOKENS_MAX + 1, 20_000.5]) {
      expect(() => Schema.decodeUnknownSync(DreamBudgetTokens)(bad)).toThrow();
    }
  });

  it("round-trips how far a dream read, and a version's watermark", () => {
    const read: DreamRead = {
      threadId: ThreadId.make("t1"),
      source: "thread",
      fromSeq: 413,
      throughSeq: 460,
      throughId: "m-460",
      throughRev: 9001,
      messages: 48,
      estimatedTokens: 21_000,
      file: "001-orchestrator-shop.md",
    };
    expectRoundTrip(DreamRead, read);
    expectRoundTrip(DreamRead, {
      threadId: ThreadId.make("t2"),
      source: "archive",
      fromSeq: 0,
      throughSeq: 0,
      messages: 0,
      estimatedTokens: 300,
    });
    expectRoundTrip(DreamInputs, { ...inputs, reads: [read] });
    expectRoundTrip(DreamInputs, { ...inputs, reads: [] });
    expectRoundTrip(DreamWatermark, {
      threadId: ThreadId.make("t1"),
      throughSeq: 460,
      throughId: "m-460",
      throughRev: 9001,
      readAt: 1_700_000_000_000,
    });
    expectRoundTrip(DreamWatermark, {
      threadId: ThreadId.make("t2"),
      throughSeq: 0,
      readAt: 1,
    });
    expectRoundTrip(DreamWatermark, {
      threadId: ThreadId.make("t3"),
      throughSeq: 12,
      readAt: 2,
      digest: "The cart thread: shipped behind a flag, checkout next.",
    });
    expect(() => Schema.decodeUnknownSync(DreamRead)({ ...read, source: "session" })).toThrow();
  });

  it("round-trips every status, failure and file status", () => {
    for (const status of DreamStatus.literals) expectRoundTrip(DreamStatus, status);
    for (const failure of DreamFailure.literals) expectRoundTrip(DreamFailure, failure);
    for (const status of DreamFileStatus.literals) {
      expectRoundTrip(DreamFileDiff, { path: "decisions.md", status });
    }
  });

  it("round-trips a review with a conflict showing both sides", () => {
    expectRoundTrip(DreamReview, {
      dream,
      memoryVersion: "0007",
      outputDigest: "9f2c",
      files: [
        { path: "goals.md", status: "unchanged", before: "a", after: "a" },
        { path: "repos/web.md", status: "added", after: "new" },
        { path: "workers/w1.md", status: "removed", before: "old" },
        { path: "decisions.md", status: "conflict", before: "a", after: "b", current: "c" },
        {
          path: "goals.md",
          status: "conflict",
          before: "a",
          after: "b",
          current: "c",
          merge: {
            status: "done",
            model: { agent: "codex", model: "gpt-5-codex" },
            startedAt: 1,
            endedAt: 2,
            merged: "b\nc",
          },
        },
      ],
      report: "# Report\n\nMerged two entries.",
    });
    expectRoundTrip(DreamReview, { dream, files: [] });
  });

  it("round-trips a merge as it runs, ends and fails", () => {
    const model = { agent: "claude", model: "opus" } as const;
    for (const status of DreamMergeStatus.literals) {
      expectRoundTrip(DreamMerge, { status, model, startedAt: 1 });
    }
    expectRoundTrip(DreamMerge, {
      status: "failed",
      model,
      startedAt: 1,
      endedAt: 3,
      error: "The merged file would be 40 KB; the cap is 32 KB.",
    });
    expect(() =>
      Schema.decodeUnknownSync(DreamMerge)({ status: "queued", model, startedAt: 1 }),
    ).toThrow();
  });

  it("round-trips the dream thread's report card, a resolution and memory's listings", () => {
    expectRoundTrip(DreamReport, {
      dreamId: dream.id,
      status: "completed",
      files: [
        { path: "MEMORY.md", status: "changed" },
        { path: "decisions.md", status: "conflict" },
      ],
      reportExcerpt: "# Report",
    });
    expectRoundTrip(DreamReport, {
      dreamId: dream.id,
      status: "failed",
      failure: "over_caps",
      files: [],
    });
    expect(() =>
      Schema.decodeUnknownSync(DreamReport)({
        dreamId: dream.id,
        status: "completed",
        files: [],
        reportExcerpt: "x".repeat(2001),
      }),
    ).toThrow();
    for (const side of DreamResolution.literals) expectRoundTrip(DreamResolution, side);
    expectRoundTrip(MemoryVersionInfo, { version: "0007", adoptedAt: 1, files: 6, current: true });
    expectRoundTrip(MemoryFileInfo, { path: "repos/web.md", bytes: 120, modifiedAt: 2 });
  });

  it("round-trips an import preview", () => {
    expectRoundTrip(ImportPreview, {
      sources: [
        {
          projectId: ProjectId.make("p1"),
          project: "gram",
          agent: "claude",
          cwd: "/repo",
          sessions: 31,
          oldest: 1_690_000_000_000,
          newest: 1_700_000_000_000,
          estimatedTokens: 480_000,
        },
        {
          projectId: ProjectId.make("p1"),
          project: "gram",
          agent: "codex",
          cwd: "/repo",
          sessions: 0,
          estimatedTokens: 0,
        },
      ],
      worktreesCovered: 3,
      worktreesTotal: 5,
      closedThreadsKept: 20,
      archivedThreads: 4,
      seedFiles: 7,
      notes: ["Two worktrees have been removed; their sessions can't be listed."],
    });
    expectRoundTrip(ImportPreview, {
      sources: [],
      worktreesCovered: 0,
      worktreesTotal: 0,
      closedThreadsKept: 3,
      notes: [],
      dream: {
        memoryVersion: "",
        fromStart: true,
        threads: 0,
        messages: 0,
        estimatedTokens: 0,
        budgetTokens: 20_000,
        backlog: { threads: 0, messages: 0, estimatedTokens: 0 },
      },
    });
  });

  it("round-trips a session transcript", () => {
    expectRoundTrip(SessionTranscript, {
      agentSessionId: "s-1",
      cwd: "/repo",
      messages: [
        { role: "user", text: "Fix the build", at: 1_700_000_000_000 },
        {
          role: "assistant",
          text: "Looking.",
          tools: [
            { name: "Bash", input: '{"command":"pnpm check"}', output: "ok" },
            { name: "Read" },
          ],
        },
        { role: "system", text: "Conversation compacted" },
      ],
    });
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
