import { describe, expect, it } from "@effect/vitest";
import { MessageId, type GramUIMessageChunk } from "@gram/contracts";
import { makeCodexMapper } from "@gram/agents/codex";
import { MessageAccumulator } from "./message-accumulator.ts";

const feed = (acc: MessageAccumulator, chunks: ReadonlyArray<unknown>) =>
  chunks.map((chunk) => acc.apply(chunk as GramUIMessageChunk));

describe("MessageAccumulator", () => {
  it("persists completed-only native web details on one card after reload", () => {
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("web-message") });
    const acc = new MessageAccumulator("web-message");
    const action = {
      type: "findInPage",
      url: "https://example.com/docs",
      pattern: "compact",
    } as const;
    const item = { type: "webSearch", id: "web", query: "", action: null, results: null } as const;
    const notifications = [
      mapper.map({
        method: "item/started",
        params: { threadId: "synthetic", turnId: "turn", item, startedAtMs: 1 },
      }),
      mapper.map({
        method: "item/completed",
        params: {
          threadId: "synthetic",
          turnId: "turn",
          item: { ...item, action },
          completedAtMs: 2,
        },
      }),
    ];
    for (const events of notifications) {
      for (const event of events) if (event.type === "chunk") acc.apply(event.chunk);
    }
    const reloaded = JSON.parse(JSON.stringify(acc.snapshot()));
    expect(reloaded.parts).toEqual([
      { type: "step-start" },
      {
        type: "dynamic-tool",
        toolName: "WebSearch",
        toolCallId: "web",
        title: "Find in page",
        providerExecuted: true,
        state: "output-available",
        input: { action: "findInPage", url: action.url, pattern: action.pattern },
        output: { action },
      },
    ]);
  });

  it("builds text parts and reports completion at text-end", () => {
    const acc = new MessageAccumulator("m1");
    const completed = feed(acc, [
      { type: "start", messageMetadata: { model: "opus" } },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Hel" },
      { type: "text-delta", id: "t", delta: "lo" },
      { type: "text-end", id: "t" },
    ]);
    expect(completed).toEqual([false, false, false, false, true]);
    expect(acc.snapshot()).toEqual({
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: "Hello", state: "done" }],
      metadata: { model: "opus" },
    });
  });

  it("tracks a typed tool call from input to output", () => {
    const acc = new MessageAccumulator("m1");
    const completed = feed(acc, [
      { type: "tool-input-start", toolCallId: "c1", toolName: "Bash", providerExecuted: true },
      { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: '{"command"' },
      {
        type: "tool-input-available",
        toolCallId: "c1",
        toolName: "Bash",
        input: { command: "ls" },
      },
      { type: "tool-output-available", toolCallId: "c1", output: { stdout: "a" } },
    ]);
    expect(completed).toEqual([false, false, false, true]);
    expect(acc.snapshot().parts).toEqual([
      {
        type: "tool-Bash",
        toolCallId: "c1",
        providerExecuted: true,
        state: "output-available",
        input: { command: "ls" },
        output: { stdout: "a" },
      },
    ]);
  });

  it("persists the Codex cancelled-tool result before finishing the interrupted message", () => {
    const mapper = makeCodexMapper({ newMessageId: () => MessageId.make("cancelled") });
    const acc = new MessageAccumulator("cancelled");
    const started = mapper.map({
      method: "turn/started",
      params: {
        threadId: "synthetic",
        turn: {
          id: "turn",
          rootTurnId: null,
          status: "inProgress",
          items: [],
          itemsView: "full",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    });
    const item = mapper.map({
      method: "item/started",
      params: {
        threadId: "synthetic",
        turnId: "turn",
        startedAtMs: 0,
        item: {
          type: "commandExecution",
          pluginId: null,
          scriptPath: null,
          processId: null,
          source: "agent",
          id: "pending-command",
          command: "echo blocked",
          cwd: "/synthetic",
          commandActions: [],
          status: "inProgress",
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      },
    });
    const ended = mapper.map({
      method: "turn/completed",
      params: {
        threadId: "synthetic",
        turn: {
          id: "turn",
          rootTurnId: null,
          status: "interrupted",
          items: [],
          itemsView: "full",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      },
    });
    for (const event of [...started, ...item, ...ended]) {
      if (event.type === "chunk") acc.apply(event.chunk);
    }
    const reloaded = JSON.parse(JSON.stringify(acc.snapshot()));
    expect(reloaded.parts).toContainEqual(
      expect.objectContaining({
        type: "dynamic-tool",
        toolName: "Bash",
        toolCallId: "pending-command",
        state: "output-error",
        errorText: "Cancelled",
      }),
    );
  });

  it("names MCP tools as dynamic-tool parts", () => {
    const acc = new MessageAccumulator("m1");
    feed(acc, [
      {
        type: "tool-input-available",
        toolCallId: "c1",
        toolName: "mcp__gh__pr",
        input: {},
        dynamic: true,
      },
      { type: "tool-output-error", toolCallId: "c1", errorText: "boom" },
    ]);
    expect(acc.snapshot().parts).toEqual([
      {
        type: "dynamic-tool",
        toolName: "mcp__gh__pr",
        toolCallId: "c1",
        state: "output-error",
        input: {},
        errorText: "boom",
      },
    ]);
  });

  it("replaces a data part with the same id and skips transient ones", () => {
    const acc = new MessageAccumulator("m1");
    feed(acc, [
      { type: "data-task-chip", id: "k", data: { status: "offered" } },
      { type: "data-task-chip", id: "k", data: { status: "dismissed" } },
      { type: "data-usage", data: {}, transient: true },
    ]);
    expect(acc.snapshot().parts).toEqual([
      { type: "data-task-chip", id: "k", data: { status: "dismissed" } },
    ]);
  });

  it("drops the current step's parts on reset-step", () => {
    const acc = new MessageAccumulator("m1");
    feed(acc, [
      { type: "start-step" },
      { type: "text-start", id: "a" },
      { type: "text-end", id: "a" },
      { type: "start-step" },
      { type: "text-start", id: "b" },
      { type: "reset-step" },
    ]);
    expect(acc.snapshot().parts.map((p) => p.type)).toEqual(["step-start", "text", "step-start"]);
  });

  it("returns snapshots that don't change as more chunks arrive", () => {
    const acc = new MessageAccumulator("m1");
    feed(acc, [{ type: "text-start", id: "t" }]);
    const before = acc.snapshot();
    feed(acc, [{ type: "text-delta", id: "t", delta: "x" }]);
    expect(before.parts).toEqual([{ type: "text", text: "", state: "streaming" }]);
  });
});
