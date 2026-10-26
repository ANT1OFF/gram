import { safeValidateUIMessages } from "ai";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  ChapterDataSchema,
  CheckpointDataSchema,
  CompactionDataSchema,
  MessageMetadataSchema,
  PlanDataSchema,
  SessionRestartDataSchema,
  type GramUIMessage,
  TaskChipDataSchema,
  ToolImageDataSchema,
  WidgetDataSchema,
  UsageDataSchema,
} from "./ui-message.ts";
import { expectRoundTrip } from "./test-utils.ts";

const metadata = {
  turnId: "turn-1",
  agent: "claude",
  model: "claude-opus-5",
  createdAt: 1,
  agentMessageIds: ["5d0e7c1a-0b1e-4f5a-9a31-1e2f3a4b5c6d", "a8f2b3c4-7d6e-4a1b-8c9d-0e1f2a3b4c5d"],
};

const sample = {
  id: "m1",
  role: "assistant",
  metadata,
  parts: [
    { type: "step-start" },
    { type: "text", text: "Running the tests.", state: "done" },
    {
      type: "tool-Bash",
      toolCallId: "toolu_1",
      state: "output-available",
      providerExecuted: true,
      input: { command: "pnpm test", description: "Run tests" },
      output: { stdout: "ok", stderr: "", interrupted: false },
    },
    { type: "data-plan", data: { items: [{ content: "Fix test", status: "completed" }] } },
    {
      type: "data-checkpoint",
      data: { turnId: "turn-1", ref: "refs/gram/checkpoints/t1/turn-1", createdAt: 1 },
    },
    { type: "data-chapter", id: "c1", data: { id: "c1", title: "Fix the flaky test" } },
    { type: "data-compaction", data: { trigger: "auto", preTokens: 180000, postTokens: 12000 } },
    {
      type: "data-task-chip",
      id: "task-1",
      data: {
        id: "task-1",
        title: "Update the changelog",
        prompt: "Add a changelog entry for the retry fix",
        checkout: "new-worktree",
        branch: "docs/changelog",
        reason: "The user asked to keep this out of the release",
        status: "offered",
      },
    },
  ],
};

const validate = (messages: unknown) =>
  safeValidateUIMessages<GramUIMessage>({
    messages,
    metadataSchema: Schema.toStandardSchemaV1(MessageMetadataSchema),
    dataSchemas: {
      plan: Schema.toStandardSchemaV1(PlanDataSchema),
      usage: Schema.toStandardSchemaV1(UsageDataSchema),
      checkpoint: Schema.toStandardSchemaV1(CheckpointDataSchema),
      chapter: Schema.toStandardSchemaV1(ChapterDataSchema),
      "task-chip": Schema.toStandardSchemaV1(TaskChipDataSchema),
      widget: Schema.toStandardSchemaV1(WidgetDataSchema),
      "tool-image": Schema.toStandardSchemaV1(ToolImageDataSchema),
      compaction: Schema.toStandardSchemaV1(CompactionDataSchema),
      "session-restart": Schema.toStandardSchemaV1(SessionRestartDataSchema),
    },
  });

describe("Effect Schema as AI SDK validators via Standard Schema", () => {
  it("validates a sample message", async () => {
    const result = await validate([sample]);
    if (!result.success) throw result.error;
    expect(result.data[0]?.metadata?.turnId).toBe("turn-1");
    expect(result.data[0]?.metadata?.agentMessageIds).toEqual(metadata.agentMessageIds);
  });

  it("round-trips metadata with agent message ids", () => {
    expectRoundTrip(
      MessageMetadataSchema,
      Schema.decodeUnknownSync(MessageMetadataSchema)(metadata),
    );
  });

  it("reports invalid metadata", async () => {
    const result = await validate([{ ...sample, metadata: { turnId: "" } }]);
    expect(result.success).toBe(false);
    const badIds = await validate([{ ...sample, metadata: { agentMessageIds: [42] } }]);
    expect(badIds.success).toBe(false);
  });

  it("reports an invalid data part", async () => {
    const result = await validate([
      {
        ...sample,
        parts: [{ type: "data-plan", data: { items: [{ content: "x", status: "done" }] } }],
      },
    ]);
    expect(result.success).toBe(false);
  });

  it("validates a widget and reports one without its drawing", async () => {
    const widget = { id: "w1", title: "Latency", svg: '<svg viewBox="0 0 1 1"/>' };
    expectRoundTrip(WidgetDataSchema, widget);
    const valid = await validate([{ ...sample, parts: [{ type: "data-widget", data: widget }] }]);
    expect(valid.success).toBe(true);
    const invalid = await validate([
      { ...sample, parts: [{ type: "data-widget", data: { id: "w1", title: "Latency" } }] },
    ]);
    expect(invalid.success).toBe(false);
  });

  it("validates a tool image, stored or not, and reports one without its tool call", async () => {
    const stored = {
      toolCallId: "toolu_1",
      mediaType: "image/png",
      size: 68,
      path: "/data/attachments/t1/tool-0123456789abcdef.png",
    };
    const tooLarge = { toolCallId: "toolu_1", mediaType: "image/png", size: 9_000_000 };
    expectRoundTrip(ToolImageDataSchema, stored);
    expectRoundTrip(ToolImageDataSchema, tooLarge);
    const valid = await validate([
      {
        ...sample,
        parts: [
          { type: "data-tool-image", id: "toolu_1:0123456789abcdef", data: stored },
          { type: "data-tool-image", data: tooLarge },
        ],
      },
    ]);
    expect(valid.success).toBe(true);
    const invalid = await validate([
      {
        ...sample,
        parts: [{ type: "data-tool-image", data: { mediaType: "image/png", size: 1 } }],
      },
    ]);
    expect(invalid.success).toBe(false);
  });

  it("validates a compaction, with or without what it said, and reports an unknown trigger", async () => {
    const full = {
      trigger: "manual",
      preTokens: 182_000,
      postTokens: 24_000,
      at: 1_790_846_290_326,
      summary: "1. Primary request: make the retry test deterministic.",
    } as const;
    expectRoundTrip(CompactionDataSchema, full);
    // Without a time or a summary.
    expectRoundTrip(CompactionDataSchema, { trigger: "auto", preTokens: 180_000 });
    const valid = await validate([
      { ...sample, parts: [{ type: "data-compaction", id: "compaction:c1", data: full }] },
    ]);
    expect(valid.success).toBe(true);
    const invalid = await validate([
      { ...sample, parts: [{ type: "data-compaction", data: { trigger: "overflow" } }] },
    ]);
    expect(invalid.success).toBe(false);
  });

  it("validates a session restart marker and reports one without its time", async () => {
    const restart = { at: 1_790_846_290_326 };
    expectRoundTrip(SessionRestartDataSchema, restart);
    expectRoundTrip(SessionRestartDataSchema, { ...restart, reason: "mcpConfig" });
    const valid = await validate([
      { ...sample, parts: [{ type: "data-session-restart", id: "r1", data: restart }] },
    ]);
    expect(valid.success).toBe(true);
    const invalid = await validate([
      { ...sample, parts: [{ type: "data-session-restart", id: "r1", data: {} }] },
    ]);
    expect(invalid.success).toBe(false);
    const unknownReason = await validate([
      {
        ...sample,
        parts: [{ type: "data-session-restart", id: "r1", data: { ...restart, reason: "mood" } }],
      },
    ]);
    expect(unknownReason.success).toBe(false);
  });

  it("reports a task chip with an unknown status", async () => {
    const result = await validate([
      {
        ...sample,
        parts: [
          { type: "data-task-chip", data: { id: "t", title: "x", prompt: "y", status: "done" } },
        ],
      },
    ]);
    expect(result.success).toBe(false);
  });
});
