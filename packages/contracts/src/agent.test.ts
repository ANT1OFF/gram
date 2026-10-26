import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { AgentCapabilities, AgentEvent, AppToolDescriptor } from "./agent.ts";
import { expectRoundTrip } from "./test-utils.ts";

const decodeEvent = Schema.decodeUnknownSync(AgentEvent);

const events: unknown[] = [
  {
    type: "identity",
    agentSessionId: "0b7c…",
    model: "claude-opus-5",
    tools: ["Bash", "Read"],
    commands: [{ name: "compact", description: "Compact the conversation", argumentHint: "" }],
  },
  {
    type: "chunk",
    messageId: "m1",
    chunk: {
      type: "tool-input-available",
      toolCallId: "toolu_1",
      toolName: "Bash",
      input: { command: "ls" },
      providerExecuted: true,
    },
  },
  {
    type: "toolImage",
    messageId: "m1",
    toolCallId: "toolu_1",
    mediaType: "image/png",
    data: "iVBORw0KGgo=",
  },
  {
    type: "toolImageRead",
    origin: "codex-image-view",
    messageId: "m1",
    toolCallId: "view",
    path: "/repo/image.png",
  },
  { type: "status", status: "awaitingApproval", detail: "Bash" },
  {
    type: "toolImageSource",
    origin: "codex-image-view",
    messageId: "m1",
    toolCallId: "view",
    path: "/repo/image.png",
  },
  {
    type: "status",
    status: "compacting",
    compaction: { startedAt: 1_758_800_000_000, trigger: "auto", preTokens: 182_000 },
  },
  { type: "status", status: "compacting", compaction: { startedAt: 1_758_800_000_000 } },
  {
    type: "request",
    request: { kind: "plan", id: "r1", plan: "# Plan", planFilePath: "/p.md" },
  },
  { type: "requestResolved", requestId: "r1" },
  {
    type: "plan",
    items: [{ content: "Write tests", status: "inProgress", activeForm: "Writing tests" }],
  },
  { type: "goal", objective: "Make the retry test deterministic" },
  { type: "goal" },
  { type: "files", changes: [{ path: "src/a.ts", kind: "modify" }] },
  {
    type: "usage",
    tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 },
    contextWindow: 200000,
    costUsd: 0.0123,
  },
  {
    type: "usage",
    tokens: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0.02,
    costEstimated: true,
  },
  {
    type: "subagentUsage",
    usage: {
      toolCallId: "toolu_2",
      status: "running",
      totalTokens: 9207,
      toolUses: 1,
      durationMs: 1911,
      startedAt: 1_758_800_000_000,
      subagentType: "Explore",
      lastToolName: "Glob",
    },
  },
  {
    type: "backgroundTasks",
    tasks: [
      {
        taskId: "brmkz602w",
        kind: "shell",
        description: "Wait two minutes",
        command: "sleep 120 && echo LONG_DONE",
        toolCallId: "toolu_01SLhyEvUPRLJQJjWs1dNH3E",
        startedAt: 1_758_800_000_000,
      },
      {
        taskId: "a3cb3dd39e45f42eb",
        kind: "subagent",
        description: "List all files in the repository",
        subagentType: "Explore",
        startedAt: 1_758_800_000_000,
      },
    ],
  },
  { type: "backgroundTasks", tasks: [] },
  { type: "backgroundOutput", taskId: "b1", toolCallId: "call-1", output: "ready on :3000\n" },
  { type: "turnEnd", reason: "interrupted" },
  {
    type: "turnEnd",
    reason: "error",
    error: "exceeded retry limit, last status: 429 Too Many Requests",
    failure: {
      kind: "gatewayRefused",
      httpStatus: 429,
      code: "responseTooManyFailedAttempts",
      retryable: false,
    },
  },
  { type: "ended", reason: "closed" },
  { type: "mode", mode: "acceptEdits" },
  { type: "speed", state: { speed: "standard", detail: "Synthetic Fast cooldown" } },
  { type: "model", model: "claude-preview[1m]" },
  { type: "notice", level: "warning", message: "claude 2.0.9 is older than the SDK expects" },
  {
    type: "rateLimit",
    status: "warning",
    window: "five_hour",
    utilization: 0.8,
    resetsAt: 1_790_000_000_000,
  },
  { type: "rateLimit", status: "rejected", window: "usage" },
  { type: "cwd", cwd: "/work/repo/.worktrees/feat" },
  { type: "connectorsLapsed", names: ["claude.ai Atlassian"] },
];

describe("AgentEvent", () => {
  it("round-trips every variant", () => {
    expect(new Set(events.map((e) => (e as { type: string }).type)).size).toBe(
      AgentEvent.members.length,
    );
    for (const event of events) expectRoundTrip(AgentEvent, decodeEvent(event));
  });

  it("passes chunk payloads through untouched", () => {
    const chunk = {
      type: "text-delta",
      id: "t",
      delta: "hi",
      providerMetadata: { anthropic: { x: 1 } },
    };
    const decoded = decodeEvent({ type: "chunk", messageId: "m1", chunk });
    expect(decoded).toEqual({ type: "chunk", messageId: "m1", chunk });
    expect(Schema.encodeSync(AgentEvent)(decoded)).toEqual({
      type: "chunk",
      messageId: "m1",
      chunk,
    });
  });

  it("rejects a chunk without a type", () => {
    expect(() => decodeEvent({ type: "chunk", messageId: "m1", chunk: { delta: "hi" } })).toThrow();
  });

  it("rejects unknown event types", () => {
    expect(() => decodeEvent({ type: "compacting" })).toThrow();
  });
});

describe("AgentCapabilities", () => {
  it("round-trips", () => {
    expectRoundTrip(AgentCapabilities, {
      fork: true,
      rewind: "historyAndFiles",
      steer: true,
      planMode: true,
      approvalScopes: ["once", "session", "always"],
      userQuestions: true,
      costReporting: true,
      perTurnModel: true,
      reasoningEffort: true,
      listSessions: true,
      subagentStreams: true,
      stopTasks: true,
    });
  });
});

describe("AppToolDescriptor", () => {
  it("round-trips and rejects unknown classes", () => {
    expectRoundTrip(AppToolDescriptor, {
      name: "set_auto_merge",
      class: "outward",
      description: "Enable auto-merge on the bound PR",
    });
    expect(() =>
      Schema.decodeUnknownSync(AppToolDescriptor)({ name: "x", class: "write", description: "" }),
    ).toThrow();
  });
});
