import type {
  SDKMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKToolProgressMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { MessageId, type AgentEvent, type GramUIMessage } from "@gram/contracts";
import { readUIMessageStream, type UIMessageChunk } from "ai";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { identityFromInitialization, makeMapper, type TaskOutputRead } from "./mapper.ts";

const FIXTURES = new URL("../../fixtures/claude/", import.meta.url);

interface Recorded {
  readonly label?: string;
  readonly msg: SDKMessage;
}

const fixture = (name: string): Array<Recorded> =>
  readFileSync(new URL(`${name}.jsonl`, FIXTURES), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Partial<Recorded>)
    .filter((entry): entry is Recorded => entry.msg !== undefined);

const STARTED_AT = 1_758_800_000_000;

const newMapper = (rates?: Map<string, number>) => {
  let n = 0;
  return makeMapper({
    newMessageId: () => MessageId.make(`m${++n}`),
    now: () => STARTED_AT,
    ...(rates === undefined ? {} : { rates }),
  });
};

/** The summary the next compaction marker carries after a `PostCompact` hook with `raw`. */
const summaryOf = (raw: string): string | undefined => {
  const mapper = newMapper();
  mapper.compacted(raw);
  const marker = mapper
    .map(system("compact_boundary", { uuid: "c1", compact_metadata: { trigger: "auto" } }))
    .find((e) => e.type === "chunk" && e.chunk.type === "data-compaction");
  return marker?.type === "chunk" && marker.chunk.type === "data-compaction"
    ? marker.chunk.data.summary
    : undefined;
};

const replay = (messages: ReadonlyArray<SDKMessage>): Array<AgentEvent> => {
  const mapper = newMapper();
  return messages.flatMap((m) => mapper.map(m));
};

const replayFixture = (name: string, label?: string): Array<AgentEvent> =>
  replay(
    fixture(name)
      .filter((entry) => label === undefined || entry.label === label)
      .map((entry) => entry.msg),
  );

/** One line per event, with consecutive deltas collapsed. */
const summarize = (events: ReadonlyArray<AgentEvent>): Array<string> => {
  const lines: Array<string> = [];
  for (const e of events) {
    let line: string;
    switch (e.type) {
      case "chunk": {
        const c = e.chunk as Record<string, unknown>;
        const tool = typeof c["toolName"] === "string" ? ` ${c["toolName"]}` : "";
        const dynamic = c["dynamic"] === true ? " dynamic" : "";
        line = `${e.messageId} ${e.chunk.type}${tool}${dynamic}`;
        break;
      }
      case "status":
        line = `status ${e.status}${e.detail ? ` (${e.detail})` : ""}`;
        break;
      case "turnEnd":
        line = `turnEnd ${e.reason}${e.error ? ` (${e.error})` : ""}`;
        break;
      case "identity":
        line = `identity ${e.model} tools=${e.tools.length}`;
        break;
      case "mode":
        line = `mode ${e.mode}`;
        break;
      case "notice":
        line = `notice ${e.level} (${e.message})`;
        break;
      case "rateLimit":
        line = `rateLimit ${e.status} ${e.window} ${e.utilization ?? "-"} ${e.resetsAt ?? "-"}`;
        break;
      case "toolImage":
        line = `${e.messageId} toolImage ${e.mediaType}`;
        break;
      default:
        line = e.type;
    }
    const last = lines.at(-1);
    if (last?.startsWith(line) && line.endsWith("-delta")) {
      const count = Number(/ x(\d+)$/.exec(last)?.[1] ?? 1);
      lines[lines.length - 1] = `${line} x${count + 1}`;
    } else {
      lines.push(line);
    }
  }
  return lines;
};

const withoutMetadata = (lines: ReadonlyArray<string>): Array<string> =>
  lines.filter((line) => !line.endsWith(" message-metadata"));

/** Rebuilds each UIMessage the way the client does. */
const assemble = async (events: ReadonlyArray<AgentEvent>): Promise<Map<string, GramUIMessage>> => {
  const chunks = new Map<string, Array<UIMessageChunk>>();
  for (const e of events) {
    if (e.type !== "chunk") continue;
    const list = chunks.get(e.messageId) ?? [];
    list.push(e.chunk as UIMessageChunk);
    chunks.set(e.messageId, list);
  }
  const messages = new Map<string, GramUIMessage>();
  for (const [id, list] of chunks) {
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const c of list) controller.enqueue(c);
        controller.close();
      },
    });
    let last: GramUIMessage | undefined;
    for await (const message of readUIMessageStream<GramUIMessage>({
      stream,
      onError: (error) => {
        throw error;
      },
    })) {
      last = message;
    }
    if (last) messages.set(id, last);
  }
  return messages;
};

const partsOf = (message: GramUIMessage | undefined) =>
  (message?.parts ?? []).filter((p) => p.type !== "step-start");

const textOf = (message: GramUIMessage | undefined): string =>
  (message?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");

const toolParts = (message: GramUIMessage | undefined) =>
  (message?.parts ?? []).flatMap((p) =>
    p.type.startsWith("tool-") || p.type === "dynamic-tool"
      ? [
          p as {
            type: string;
            state: string;
            output?: unknown;
            errorText?: string;
            input?: unknown;
          },
        ]
      : [],
  );

/** The usage a turn's `result` reports: the last one before that turn's end. */
/** Each usage event's cost, and whether it is a guess. */
const costs = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((e) =>
    e.type === "usage" ? [{ costUsd: e.costUsd, costEstimated: e.costEstimated }] : [],
  );

const finalUsage = (events: ReadonlyArray<AgentEvent>, turn = 0): AgentEvent | undefined => {
  const end = events.flatMap((e, i) => (e.type === "turnEnd" ? [i] : []))[turn];
  return events.slice(0, end).findLast((e) => e.type === "usage");
};

const failure = (name: string) =>
  replayFixture(name).flatMap((e) => (e.type === "turnEnd" ? [e] : []))[0];

const usageEvents = (events: ReadonlyArray<AgentEvent>) => events.filter((e) => e.type === "usage");

const subagentUsages = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((e) => (e.type === "subagentUsage" ? [e.usage] : []));

const fixtureNames = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => f.replace(/\.jsonl$/, ""));

const resumeForkSessionId = (label: string) =>
  replayFixture("p09-resume-fork", label).flatMap((e) =>
    e.type === "identity" ? [e.agentSessionId] : [],
  )[0];

describe("fixture replay", () => {
  it.each(fixtureNames)("%s assembles into valid UIMessages", async (name) => {
    const labels = [...new Set(fixture(name).map((e) => e.label))];
    for (const label of labels) {
      const events = replayFixture(name, label);
      expect(summarize(events)).toMatchSnapshot(label ?? "events");
      const messages = await assemble(events);
      for (const message of messages.values()) {
        expect(message.role).toBe("assistant");
      }
      // Every opened message is finished.
      const starts = events.filter((e) => e.type === "chunk" && e.chunk.type === "start").length;
      const finishes = events.filter((e) => e.type === "chunk" && e.chunk.type === "finish").length;
      expect(finishes).toBe(starts);
    }
  });

  it("streams text and reasoning deltas without duplicating the complete message", async () => {
    const events = replayFixture("p02-streaming");
    const messages = await assemble(events);
    expect(messages.size).toBe(1);
    const message = messages.get("m1");
    expect(textOf(message)).toBe("1\n2\n3\n4\n5");
    expect(partsOf(message).map((p) => p.type)).toEqual(["reasoning", "text"]);
    expect(events.filter((e) => e.type === "chunk" && e.chunk.type === "text-delta").length).toBe(
      2,
    );
    expect(events.at(-2)?.type).toBe("usage");
    expect(events.at(-1)).toEqual({ type: "turnEnd", reason: "completed" });
  });

  it("emits complete messages whole when partial messages are off", async () => {
    const messages = await assemble(replayFixture("p03-session-state-with"));
    expect(textOf(messages.get("m1"))).toBe("OK");
  });

  it("maps session state: running, then idle after the result", () => {
    const events = replayFixture("p03-session-state-with");
    const statuses = events.filter((e) => e.type === "status");
    expect(statuses).toEqual([
      { type: "status", status: "running" },
      { type: "status", status: "idle" },
    ]);
    const turnEndIndex = events.findIndex((e) => e.type === "turnEnd");
    const idleIndex = events.findIndex((e) => e.type === "status" && e.status === "idle");
    expect(idleIndex).toBeGreaterThan(turnEndIndex);
    expect(replayFixture("p03-session-state-without").some((e) => e.type === "status")).toBe(false);
  });

  it("reports identity from system/init with the session id", () => {
    const identity = replayFixture("p01-init").find((e) => e.type === "identity");
    expect(identity).toMatchObject({
      type: "identity",
      agentSessionId: "00000000-0000-4000-8000-000000000001",
      model: "claude-haiku-4-5-20251001",
    });
    expect(identity?.type === "identity" && identity.tools).toContain("Bash");
  });

  it("drops thinking tokens and hook messages", () => {
    const summary = withoutMetadata(summarize(replayFixture("p11-default-settings")));
    expect(summary).toEqual([
      "identity claude-haiku-4-5-20251001 tools=28",
      "mode default",
      "m1 start",
      "m1 start-step",
      "m1 reasoning-start",
      "m1 reasoning-delta",
      "m1 reasoning-end",
      // The request reports its own usage, so the meter moves during the turn, not only at its end.
      // The turn's second assistant message is the same request, so it doesn't report again.
      "usage",
      "m1 text-start",
      "m1 text-delta",
      "m1 text-end",
      "m1 finish-step",
      "m1 finish",
      "usage",
      "turnEnd completed",
    ]);
  });

  it("maps allowed and denied Bash calls to typed provider-executed tool parts", async () => {
    const events = replayFixture("p05-approvals");
    const inputs = events.flatMap((e) =>
      e.type === "chunk" && e.chunk.type === "tool-input-available" ? [e.chunk] : [],
    );
    expect(inputs.map((c) => [c.toolName, c.providerExecuted, c.dynamic])).toEqual([
      ["Bash", true, undefined],
      ["Bash", true, undefined],
      ["Bash", true, undefined],
    ]);
    const messages = await assemble(events);
    const [first, , third] = [...messages.values()];
    expect(toolParts(first)).toMatchObject([
      { type: "tool-Bash", state: "output-available", output: { stdout: "", interrupted: false } },
    ]);
    expect(toolParts(third)).toMatchObject([
      {
        type: "tool-Bash",
        state: "output-error",
        errorText: "User denied this fixture command.",
      },
    ]);
    expect(
      events.filter((e) => e.type === "turnEnd").map((e) => e.type === "turnEnd" && e.reason),
    ).toEqual(["completed", "completed", "completed"]);
  });

  it("renders ExitPlanMode, ToolSearch and Write as tool parts", async () => {
    const messages = await assemble(replayFixture("p06-exit-plan-mode"));
    expect(toolParts(messages.get("m1")).map((p) => [p.type, p.state])).toEqual([
      ["tool-Write", "output-available"],
      ["tool-ToolSearch", "output-available"],
      ["tool-ExitPlanMode", "output-available"],
      ["tool-Write", "output-available"],
    ]);
  });

  it("hands a read image over as a toolImage event and keeps its bytes out of the output", async () => {
    const events = replayFixture("p13-read-image");
    const images = events.filter((e) => e.type === "toolImage");
    expect(images).toHaveLength(1);
    const image = images[0]!;
    expect(image.mediaType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").subarray(1, 4).toString("latin1")).toBe("PNG");

    const outputAt = events.findIndex(
      (e) =>
        e.type === "chunk" &&
        e.chunk.type === "tool-output-available" &&
        e.chunk.toolCallId === image.toolCallId,
    );
    expect(events.indexOf(image)).toBeLessThan(outputAt);

    const read = partsOf((await assemble(events)).get(image.messageId)).find(
      (p) => p.type === "tool-Read",
    );
    expect(read).toMatchObject({
      state: "output-available",
      input: { file_path: "/work/repo/logo.png" },
      output: {
        type: "image",
        file: { type: "image/png", originalSize: 119, dimensions: { originalWidth: 32 } },
      },
    });
    expect(JSON.stringify(events.filter((e) => e.type === "chunk"))).not.toContain(image.data);
  });

  it("carries AskUserQuestion answers in the structured tool output", async () => {
    const messages = await assemble(replayFixture("p07-ask-user-question"));
    const [question] = toolParts(messages.get("m1"));
    expect(question).toMatchObject({
      type: "tool-AskUserQuestion",
      state: "output-available",
      output: { answers: { "Which file name should I use?": "beta.txt" } },
    });
  });

  it("maps an interrupt to an errored tool and an interrupted turn, then continues", async () => {
    const events = replayFixture("p08-interrupt");
    const turnEnds = events.filter((e) => e.type === "turnEnd");
    expect(turnEnds).toEqual([
      { type: "turnEnd", reason: "interrupted" },
      { type: "turnEnd", reason: "completed" },
    ]);
    const messages = await assemble(events);
    expect(toolParts(messages.get("m1"))).toMatchObject([
      { type: "tool-Bash", state: "output-error" },
    ]);
    expect(textOf(messages.get("m2"))).toBe("AFTER");
  });

  it("ends a steered turn as interrupted and answers the steer in a new message", async () => {
    const events = replayFixture("p04-streaming-input-now");
    expect(
      events.filter((e) => e.type === "turnEnd").map((e) => e.type === "turnEnd" && e.reason),
    ).toEqual(["interrupted", "completed"]);
    const messages = await assemble(events);
    expect(toolParts(messages.get("m1"))).toMatchObject([
      { type: "tool-Bash", state: "output-available" },
    ]);
    expect(textOf(messages.get("m2"))).toBe("SECOND");
    expect(events.at(-1)).toEqual({ type: "status", status: "idle" });
  });

  it("merges a default mid-turn push into the running turn", () => {
    const events = replayFixture("p04-streaming-input-default");
    expect(events.filter((e) => e.type === "turnEnd")).toEqual([
      { type: "turnEnd", reason: "completed" },
    ]);
  });

  it("keeps the session id on resume and gets a new one on fork", () => {
    const original = resumeForkSessionId("original");
    expect(resumeForkSessionId("resume")).toBe(original);
    expect(resumeForkSessionId("fork")).not.toBe(original);
    expect(resumeForkSessionId("resume-original-after-fork")).toBe(original);
  });

  it("records each assistant message uuid in the turn's agentMessageIds", async () => {
    const messages = fixture("p05-approvals").map((entry) => entry.msg);
    const firstResult = messages.findIndex((m) => m.type === "result");
    const uuids = messages
      .slice(0, firstResult)
      .flatMap((m) => (m.type === "assistant" ? [m.uuid] : []));
    expect(uuids.length).toBeGreaterThan(1);
    const assembled = await assemble(replay(messages));
    const main = messages.find((m) => m.type === "assistant");
    expect(assembled.get("m1")?.metadata).toEqual({
      agent: "claude",
      agentMessageIds: uuids,
      agentSessionId: main?.session_id,
      model: main?.type === "assistant" ? main.message.model : undefined,
    });
  });

  it("reports usage with cache tokens, context window and cumulative cost", () => {
    const usage = finalUsage(replayFixture("p05-approvals"));
    expect(usage).toEqual({
      type: "usage",
      tokens: {
        inputTokens: 18,
        outputTokens: 162,
        cacheReadTokens: 15372,
        cacheWriteTokens: 15596,
        reasoningTokens: 70,
      },
      contextWindow: 200000,
      // The prompt of the last main request before this turn's result, well under the summed tokens.
      contextTokens: 15604,
      costUsd: 0.0228422,
      // The recorded CLI asked for the five-minute TTL; idle compaction skips such a thread.
      cacheWrites: { fiveMinute: 15596, oneHour: 0 },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Synthetic messages for paths the fixtures don't cover

const base = { uuid: "u", session_id: "s" };

/** A `rate_limit_event` with `info`, as the CLI sends it. */
const rateLimitReport = (info: Record<string, unknown>) =>
  ({ type: "rate_limit_event", rate_limit_info: info, ...base }) as unknown as SDKMessage;

const assistant = (
  id: string,
  content: Array<Record<string, unknown>>,
  parent: string | null = null,
): SDKMessage =>
  ({
    type: "assistant",
    message: { id, role: "assistant", model: "m", content },
    parent_tool_use_id: parent,
    ...base,
  }) as unknown as SDKMessage;

const toolResult = (
  toolUseId: string,
  content: string,
  options: { isError?: boolean; parent?: string | null; structured?: unknown } = {},
): SDKMessage =>
  ({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          is_error: options.isError ?? false,
        },
      ],
    },
    parent_tool_use_id: options.parent ?? null,
    ...(options.structured === undefined ? {} : { tool_use_result: options.structured }),
    ...base,
  }) as unknown as SDKMessage;

const result = (overrides: Record<string, unknown>): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    errors: [],
    usage: { input_tokens: 1, output_tokens: 2 },
    modelUsage: {},
    total_cost_usd: 0.5,
    permission_denials: [],
    terminal_reason: "completed",
    ...base,
    ...overrides,
  }) as unknown as SDKMessage;

const system = (subtype: string, fields: Record<string, unknown>): SDKMessage =>
  ({ type: "system", subtype, ...base, ...fields }) as unknown as SDKMessage;

const streamEvent = (event: Record<string, unknown>, parent: string | null = null): SDKMessage =>
  ({ type: "stream_event", event, parent_tool_use_id: parent, ...base }) as unknown as SDKMessage;

/** One streamed request: the prompt is known at its start, the output count only at its end. */
const streamedRequest = (
  id: string,
  start: Record<string, unknown>,
  end: Record<string, unknown>,
): Array<SDKMessage> => [
  streamEvent({ type: "message_start", message: { id, usage: start } }),
  streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
  streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
  streamEvent({ type: "content_block_stop", index: 0 }),
  streamEvent({ type: "message_delta", usage: end }),
];

const withUuid = (m: SDKMessage, uuid: string) => ({ ...m, uuid }) as unknown as SDKMessage;

/** `m` with a per-request usage on its API message, as the SDK sends each assistant message. */
const withRequestUsage = (m: SDKMessage, usage: Record<string, unknown>) => {
  const message = (m as unknown as { message: Record<string, unknown> }).message;
  return { ...m, message: { ...message, usage } } as unknown as SDKMessage;
};

/** A request's usage with its cache writes split by TTL. */
const split = (fiveMinute: number, oneHour: number) => ({
  input_tokens: 5,
  cache_creation_input_tokens: fiveMinute + oneHour,
  cache_read_input_tokens: 200_000,
  cache_creation: { ephemeral_5m_input_tokens: fiveMinute, ephemeral_1h_input_tokens: oneHour },
});

const SCREENSHOT = "aW1hZ2UtYnl0ZXM=";
const screenshotCall = (id: string) =>
  ({
    type: "assistant",
    parent_tool_use_id: null,
    uuid: `a-${id}`,
    session_id: "s",
    message: {
      id: `msg-${id}`,
      role: "assistant",
      content: [{ type: "tool_use", id, name: "mcp__browser__screenshot", input: {} }],
    },
  }) as unknown as SDKMessage;
const screenshotResult = (id: string, isError: boolean) => {
  const content = [
    { type: "text", text: "captured" },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: SCREENSHOT } },
  ];
  return {
    type: "user",
    parent_tool_use_id: null,
    uuid: `u-${id}`,
    session_id: "s",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }],
    },
    tool_use_result: content,
  } as unknown as SDKMessage;
};

const cacheReadRequest = (n: number) =>
  streamedRequest(
    `msg_${n}`,
    { input_tokens: 10, cache_read_input_tokens: 500 },
    { input_tokens: 10, cache_read_input_tokens: 500, output_tokens: 100 },
  );

const init = (model: string) =>
  system("init", { model, tools: [], slash_commands: [], permissionMode: "default" });

/** An assistant message from the subagent under the `t1` call, on its own model. */
const subagent = (content: Array<Record<string, unknown>>) =>
  ({
    type: "assistant",
    message: { id: "msg_sub", role: "assistant", model: "claude-opus-5-20260401", content },
    parent_tool_use_id: "t1",
    ...base,
  }) as unknown as SDKMessage;

const changed = (...tasks: Array<Record<string, unknown>>) =>
  system("background_tasks_changed", { tasks });

const task = (taskId: string, kind: string, description: string) => ({
  taskId,
  kind,
  description,
  startedAt: STARTED_AT,
});

const userText = (text: string): SDKMessage =>
  ({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    ...base,
  }) as unknown as SDKMessage;

/** An identity event's command names. */
const names = (event: AgentEvent | undefined) =>
  event?.type === "identity" ? event.commands.map((c) => c.name) : undefined;

const reason = (overrides: Record<string, unknown>) =>
  replay([result(overrides)]).find((e) => e.type === "turnEnd");

const modelRequest = (id: string, model: string) =>
  withRequestUsage(
    {
      ...assistant(id, [{ type: "text", text: "hi" }]),
      message: { id, role: "assistant", model, content: [{ type: "text", text: "hi" }] },
    } as unknown as SDKMessage,
    { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 10_000 },
  );

const priced = (model: string, costUSD: number, total: number) =>
  result({
    total_cost_usd: total,
    modelUsage: {
      [model]: {
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadInputTokens: 10_000,
        cacheCreationInputTokens: 0,
        costUSD,
        contextWindow: 200_000,
      },
    },
  });

describe("synthetic", () => {
  it("ends an open reply when the CLI goes idle without a result, once", () => {
    const mapper = newMapper();
    mapper.map(screenshotCall("open-tool"));
    const idle = system("session_state_changed", { state: "idle" });
    expect(mapper.map(idle).filter((e) => e.type === "turnEnd")).toEqual([
      { type: "turnEnd", reason: "interrupted" },
    ]);
    expect(mapper.map(idle).filter((e) => e.type === "turnEnd")).toEqual([]);
    mapper.map(screenshotCall("next-tool"));
    mapper.map(result({}));
    expect(mapper.map(idle).filter((e) => e.type === "turnEnd")).toEqual([]);
  });
  it("takes the images out of an MCP tool's result, error or not", () => {
    const mapper = newMapper();
    const events = [
      screenshotCall("toolu_ok"),
      screenshotResult("toolu_ok", false),
      screenshotCall("toolu_bad"),
      screenshotResult("toolu_bad", true),
    ].flatMap((m) => mapper.map(m));

    expect(events.filter((e) => e.type === "toolImage")).toMatchObject([
      { toolCallId: "toolu_ok", mediaType: "image/jpeg", data: SCREENSHOT },
      { toolCallId: "toolu_bad", mediaType: "image/jpeg", data: SCREENSHOT },
    ]);
    const chunks = events.flatMap((e) => (e.type === "chunk" ? [e.chunk] : []));
    expect(JSON.stringify(chunks)).not.toContain(SCREENSHOT);
    expect(chunks.find((c) => c.type === "tool-output-available")).toMatchObject({
      output: [
        { type: "text", text: "captured" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg" } },
      ],
    });
    expect(chunks.find((c) => c.type === "tool-output-error")).toMatchObject({
      errorText: "captured",
    });
  });

  it("keeps the main conversation's TodoWrite list as the plan, not a subagent's", () => {
    const todos = {
      todos: [
        { content: "Reproduce the flake", status: "completed", activeForm: "Reproducing" },
        { content: "Fix the retry", status: "in_progress", activeForm: "Fixing the retry" },
        { content: "Open a PR", status: "pending" },
        { status: "pending" },
      ],
    };
    const events = replay([
      assistant("msg_1", [{ type: "tool_use", id: "t1", name: "TodoWrite", input: todos }]),
      assistant("msg_2", [{ type: "tool_use", id: "t2", name: "TodoWrite", input: todos }], "t9"),
    ]);
    expect(events.filter((e) => e.type === "plan")).toEqual([
      {
        type: "plan",
        items: [
          { content: "Reproduce the flake", status: "completed", activeForm: "Reproducing" },
          { content: "Fix the retry", status: "inProgress", activeForm: "Fixing the retry" },
          { content: "Open a PR", status: "pending" },
        ],
      },
    ]);
  });

  it("measures context from the last main request, not the turn's summed cache reads", () => {
    const request = (n: number, cacheRead: number) =>
      withRequestUsage(
        assistant(`msg_${n}`, [{ type: "tool_use", id: `t${n}`, name: "Read", input: {} }]),
        { input_tokens: 5, cache_creation_input_tokens: 400, cache_read_input_tokens: cacheRead },
      );
    const messages: Array<SDKMessage> = [];
    // Twelve tool calls, each re-reading a growing cached prompt of ~50-60K.
    for (let n = 1; n <= 12; n++) {
      messages.push(request(n, 49_000 + n * 900), toolResult(`t${n}`, "ok"));
    }
    // A subagent's own requests are a separate context and don't move the meter.
    messages.push(
      withRequestUsage(assistant("msg_sub", [{ type: "text", text: "sub" }], "t12"), {
        input_tokens: 9,
        cache_read_input_tokens: 150_000,
      }),
    );
    messages.push(
      result({
        usage: {
          input_tokens: 60,
          output_tokens: 35_900,
          cache_read_input_tokens: 658_200,
          cache_creation_input_tokens: 4_800,
        },
        modelUsage: { m: { contextWindow: 200_000 } },
      }),
    );
    const usage = finalUsage(replay(messages));
    expect(usage).toMatchObject({
      tokens: { cacheReadTokens: 658_200 },
      contextWindow: 200_000,
      // The twelfth request: 5 input + 400 cache creation + 59,800 cache read, about 30%.
      contextTokens: 60_205,
    });
  });

  it("reports the turn's usage as each request lands, not only at its end", () => {
    const events = replay([
      ...streamedRequest(
        "msg_1",
        { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 },
        {
          input_tokens: 10,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 900,
          output_tokens: 80,
          output_tokens_details: { thinking_tokens: 20 },
        },
      ),
      withRequestUsage(assistant("msg_1", [{ type: "text", text: "hi" }]), {
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 900,
        output_tokens: 1,
      }),
      result({
        usage: {
          input_tokens: 10,
          output_tokens: 80,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 900,
        },
        modelUsage: { m: { contextWindow: 200_000 } },
      }),
    ]);
    const reports = usageEvents(events);
    // The request's start, its final output count, then the result. The complete assistant message
    // repeats the start's numbers, so it adds nothing.
    expect(reports).toHaveLength(3);
    expect(reports.map((e) => e.tokens.outputTokens)).toEqual([0, 80, 80]);
    expect(reports.every((e) => e.contextTokens === 1010)).toBe(true);
    expect(events.indexOf(reports[1]!)).toBeLessThan(events.findIndex((e) => e.type === "turnEnd"));
    expect(reports[1]).toMatchObject({
      tokens: { inputTokens: 10, cacheWriteTokens: 100, cacheReadTokens: 900, reasoningTokens: 20 },
    });
  });

  it("sums the turn's cache writes by TTL across its requests, once per request", () => {
    const events = replay([
      withRequestUsage(
        assistant("msg_1", [{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
        split(0, 3_000),
      ),
      // The same request reported again repeats its writes: they count once.
      withRequestUsage(assistant("msg_1", [{ type: "text", text: "again" }]), split(0, 3_000)),
      toolResult("t1", "ok"),
      withRequestUsage(assistant("msg_2", [{ type: "text", text: "done" }]), split(0, 1_200)),
      result({
        usage: { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 4_200 },
        modelUsage: { m: { contextWindow: 1_000_000 } },
      }),
    ]);
    expect(finalUsage(events)).toMatchObject({ cacheWrites: { fiveMinute: 0, oneHour: 4_200 } });
    // A five-minute write is reported as one, which idle compaction reads as an unknown lifetime.
    const short = replay([
      withRequestUsage(assistant("msg_3", [{ type: "text", text: "hi" }]), split(700, 0)),
      result({ usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} }),
    ]);
    expect(finalUsage(short)).toMatchObject({ cacheWrites: { fiveMinute: 700, oneHour: 0 } });
  });

  it("never lets the result's total step the meter backwards", () => {
    const events = replay([
      ...cacheReadRequest(1),
      ...cacheReadRequest(2),
      // A result that reports one request's worth for a two-request turn.
      result({ usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 500 } }),
    ]);
    const totals = usageEvents(events).map((e) => e.tokens.outputTokens + e.tokens.inputTokens);
    expect(totals).toEqual(totals.toSorted((a, b) => a - b));
    expect(usageEvents(events).at(-1)?.tokens).toMatchObject({
      inputTokens: 20,
      outputTokens: 200,
      cacheReadTokens: 1000,
    });
  });

  it("leaves the main lane's usage alone while a subagent runs", () => {
    const events = replay([
      withRequestUsage(assistant("msg_1", [{ type: "tool_use", id: "t1", name: "Agent" }]), {
        input_tokens: 10,
        cache_read_input_tokens: 5_000,
        output_tokens: 20,
      }),
      withRequestUsage(assistant("msg_sub", [{ type: "text", text: "sub" }], "t1"), {
        input_tokens: 7,
        cache_read_input_tokens: 90_000,
        output_tokens: 900,
      }),
      toolResult("t1", "done"),
    ]);
    // Only the main request reported; the subagent's own context never reached the meter.
    expect(usageEvents(events)).toHaveLength(1);
    expect(usageEvents(events)[0]).toMatchObject({
      tokens: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5_000 },
      contextTokens: 5_010,
    });
  });

  it("measures the context window with the main model's entry, not the widest one", () => {
    const events = replay([
      assistant("msg_1", [{ type: "tool_use", id: "t1", name: "Agent", input: {} }]),
      assistant("msg_sub", [{ type: "text", text: "sub" }], "t1"),
      toolResult("t1", "done"),
      result({
        modelUsage: {
          m: { contextWindow: 200_000 },
          "claude-opus-5-20260401": { contextWindow: 1_000_000 },
        },
      }),
    ]);
    expect(finalUsage(events)).toMatchObject({ contextWindow: 200_000 });
  });

  // Recorded against a live 1M session: messages said `claude-orzata-eap`, `modelUsage` keyed the
  // entry `claude-orzata-eap[1m]`, and the exact lookup missed, so no 1M thread ever had a meter.
  it("finds the window of a model `modelUsage` keys by its variant tag", () => {
    const events = replay([
      assistant("msg_1", [{ type: "text", text: "a" }]),
      result({
        modelUsage: {
          "claude-haiku-4-5-20251001": { contextWindow: 200_000 },
          "m[1m]": { contextWindow: 1_000_000, canonicalModel: "m[1m]" },
        },
      }),
    ]);
    expect(finalUsage(events)).toMatchObject({ contextWindow: 1_000_000 });
  });

  it("prefers the session's tagged model over a subagent's entry under the bare id", () => {
    const events = replay([
      system("init", {
        model: "m[1m]",
        tools: [],
        slash_commands: [],
        permissionMode: "default",
      }),
      assistant("msg_1", [{ type: "text", text: "a" }]),
      result({
        modelUsage: { m: { contextWindow: 200_000 }, "m[1m]": { contextWindow: 1_000_000 } },
      }),
    ]);
    expect(finalUsage(events)).toMatchObject({ contextWindow: 1_000_000 });
  });

  // `modelUsage` is cumulative, so once a session has run both `m` and `m[1m]` both entries stay.
  it("follows a model switch between a model and its tagged variant, in each direction", () => {
    const both = {
      modelUsage: { m: { contextWindow: 200_000 }, "m[1m]": { contextWindow: 1_000_000 } },
    };
    const turn = (mapper: ReturnType<typeof newMapper>, id: string) =>
      finalUsage([assistant(id, [{ type: "text", text: "a" }]), result(both)].flatMap(mapper.map));

    const widened = newMapper();
    widened.map(init("m"));
    expect(turn(widened, "msg_1")).toMatchObject({ contextWindow: 200_000 });
    widened.setSessionModel("m[1m]");
    expect(turn(widened, "msg_2")).toMatchObject({ contextWindow: 1_000_000 });

    const narrowed = newMapper();
    narrowed.map(init("m[1m]"));
    expect(turn(narrowed, "msg_1")).toMatchObject({ contextWindow: 1_000_000 });
    narrowed.setSessionModel("m");
    expect(turn(narrowed, "msg_2")).toMatchObject({ contextWindow: 200_000 });
  });

  it("reads the variant tag off an alias the session was asked for", () => {
    const mapper = newMapper();
    mapper.setSessionModel("opus[1m]");
    const events = [
      assistant("msg_1", [{ type: "text", text: "a" }]),
      result({
        modelUsage: { m: { contextWindow: 200_000 }, "m[1m]": { contextWindow: 1_000_000 } },
      }),
    ].flatMap(mapper.map);
    expect(finalUsage(events)).toMatchObject({ contextWindow: 1_000_000 });
  });

  it("carries the context window into the next turn's mid-turn reports", () => {
    const mapper = newMapper();
    for (const m of [
      assistant("msg_1", [{ type: "text", text: "a" }]),
      result({ modelUsage: { m: { contextWindow: 200_000 } } }),
    ])
      mapper.map(m);
    const events = mapper.map(
      withRequestUsage(assistant("msg_2", [{ type: "text", text: "b" }]), {
        input_tokens: 10,
        cache_read_input_tokens: 40,
      }),
    );
    expect(usageEvents(events)[0]).toMatchObject({ contextWindow: 200_000, contextTokens: 50 });
  });

  it("stamps a subagent's own model on its lane", async () => {
    const events = replay([
      assistant("msg_1", [
        { type: "tool_use", id: "t1", name: "Agent", input: { description: "d", prompt: "p" } },
      ]),
      subagent([{ type: "text", text: "sub" }]),
      toolResult("t1", "done"),
      result({}),
    ]);
    const messages = await assemble(events);
    // The Task input carries a model only when the caller overrode it, so the lane is the source.
    expect(messages.get("m2")?.metadata).toMatchObject({
      parentToolUseId: "t1",
      model: "claude-opus-5-20260401",
    });
    expect(messages.get("m1")?.metadata).toHaveProperty("model", "m");
  });

  it("reports a running subagent from task_started, then its tokens from task_progress", () => {
    const events = replay([
      assistant("msg_1", [{ type: "tool_use", id: "t1", name: "Agent", input: {} }]),
      system("task_started", {
        task_id: "a1",
        tool_use_id: "t1",
        subagent_type: "Explore",
        task_type: "local_agent",
        is_backgrounded: true,
      }),
      system("task_progress", {
        task_id: "a1",
        tool_use_id: "t1",
        description: "Finding **/*",
        subagent_type: "Explore",
        usage: { total_tokens: 9207, tool_uses: 1, duration_ms: 1911 },
        last_tool_name: "Glob",
        summary: "Listing files",
      }),
    ]);
    expect(subagentUsages(events)).toEqual([
      { toolCallId: "t1", status: "running", startedAt: STARTED_AT, subagentType: "Explore" },
      {
        toolCallId: "t1",
        status: "running",
        totalTokens: 9207,
        toolUses: 1,
        durationMs: 1911,
        startedAt: STARTED_AT,
        subagentType: "Explore",
        lastToolName: "Glob",
        summary: "Listing files",
      },
    ]);
  });

  it("keeps a background subagent's final tokens from its task_notification", () => {
    const events = replay([
      assistant("msg_1", [{ type: "tool_use", id: "bg1", name: "Agent", input: {} }]),
      system("task_started", { task_id: "a1", tool_use_id: "bg1", is_backgrounded: true }),
      toolResult("bg1", "launched", { structured: { status: "async_launched" } }),
      result({}),
      system("task_notification", {
        task_id: "a1",
        tool_use_id: "bg1",
        status: "completed",
        summary: "A very long report the transcript already holds.",
        usage: { total_tokens: 12_345, tool_uses: 4, duration_ms: 60_000 },
      }),
    ]);
    // The start goes out on the reply, then again on the lane the launch opens.
    expect(subagentUsages(events)).toEqual([
      { toolCallId: "bg1", status: "running", startedAt: STARTED_AT },
      { toolCallId: "bg1", status: "running", startedAt: STARTED_AT },
      {
        toolCallId: "bg1",
        status: "completed",
        totalTokens: 12_345,
        toolUses: 4,
        durationMs: 60_000,
        startedAt: STARTED_AT,
      },
    ]);
  });

  it("forgets a foreground run's start once its result is in", () => {
    const events = replay([
      assistant("msg_1", [{ type: "tool_use", id: "t1", name: "Agent", input: {} }]),
      system("task_started", { task_id: "a1", tool_use_id: "t1", task_type: "local_agent" }),
      toolResult("t1", "done"),
      system("task_notification", { task_id: "a1", tool_use_id: "t1", status: "completed" }),
    ]);
    expect(subagentUsages(events)).toEqual([
      { toolCallId: "t1", status: "running", startedAt: STARTED_AT },
      { toolCallId: "t1", status: "completed" },
    ]);
  });

  it("ignores progress from housekeeping tasks and backgrounded shells", () => {
    const progress = (taskId: string, toolUseId: string) =>
      system("task_progress", {
        task_id: taskId,
        tool_use_id: toolUseId,
        description: "d",
        usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
      });
    const events = replay([
      system("task_started", { task_id: "ambient", tool_use_id: "t1", ambient: true }),
      system("task_started", { task_id: "shell", tool_use_id: "t2", task_type: "local_bash" }),
      system("task_started", { task_id: "agent", tool_use_id: "t3", task_type: "local_agent" }),
      progress("ambient", "t1"),
      progress("shell", "t2"),
      progress("agent", "t3"),
    ]);
    expect(subagentUsages(events).map((u) => u.toolCallId)).toEqual(["t3", "t3"]);
  });

  it("reports the background tasks that run, leaving out ambient ones", () => {
    const shell = { task_id: "b1", task_type: "local_bash", description: "pnpm check" };
    const watcher = { task_id: "w1", task_type: "monitor_ws", description: "w", ambient: true };
    const events = replay([
      changed(watcher),
      changed(watcher, shell),
      changed(shell, { task_id: "a1", task_type: "local_agent", description: "explore" }),
      changed({ ...shell, description: "pnpm check, renamed" }),
      changed(watcher),
    ]);
    expect(events.filter((e) => e.type === "backgroundTasks")).toEqual([
      { type: "backgroundTasks", tasks: [task("b1", "shell", "pnpm check")] },
      {
        type: "backgroundTasks",
        tasks: [task("b1", "shell", "pnpm check"), task("a1", "subagent", "explore")],
      },
      { type: "backgroundTasks", tasks: [task("b1", "shell", "pnpm check, renamed")] },
      { type: "backgroundTasks", tasks: [] },
    ]);
  });

  it("joins a background shell to its Bash call's command and keeps its first start", () => {
    let clock = STARTED_AT;
    const mapper = makeMapper({ newMessageId: () => MessageId.make("m1"), now: () => clock });
    const bash = { command: "pnpm test", description: "Run the tests", timeout: 120_000 };
    const listed = { task_id: "b1", task_type: "local_bash", description: "Run the tests" };
    const started = (backgrounded: boolean) =>
      system("task_started", {
        task_id: "b1",
        tool_use_id: "t1",
        description: "Run the tests",
        task_type: "local_bash",
        is_backgrounded: backgrounded,
      });
    // A foreground Bash that outruns its timeout: started at once, listed only when moved.
    const events = [
      assistant("msg_1", [{ type: "tool_use", id: "t1", name: "Bash", input: bash }]),
      started(false),
    ].flatMap((m) => mapper.map(m));
    clock += 120_000;
    events.push(
      ...[
        system("background_tasks_changed", { tasks: [listed] }),
        toolResult("t1", "Command was moved to the background"),
        system("task_notification", { task_id: "b1", tool_use_id: "t1", status: "completed" }),
        system("background_tasks_changed", { tasks: [] }),
      ].flatMap((m) => mapper.map(m)),
    );
    expect(events.filter((e) => e.type === "backgroundTasks")).toEqual([
      {
        type: "backgroundTasks",
        tasks: [
          {
            taskId: "b1",
            kind: "shell",
            description: "Run the tests",
            command: "pnpm test",
            toolCallId: "t1",
            startedAt: STARTED_AT,
          },
        ],
      },
      { type: "backgroundTasks", tasks: [] },
    ]);
  });

  // CLI 2.1.283: the level lists a shell a moment before its `task_started` names the tool call,
  // and a `stopTask` answers with `task_notification` status `stopped`.
  it("reports the recorded background shells with their commands as they start and stop", () => {
    const reported = replayFixture("p14-background-shells").flatMap((e) =>
      e.type === "backgroundTasks"
        ? [e.tasks.map((t) => `${t.taskId} ${t.kind} ${t.command ?? "-"} (${t.description})`)]
        : [],
    );
    expect(reported).toEqual([
      ["fixture-shell-long shell - (Wait two minutes)"],
      ["fixture-shell-long shell sleep 120 && echo LONG_DONE (Wait two minutes)"],
      [
        "fixture-shell-long shell sleep 120 && echo LONG_DONE (Wait two minutes)",
        "fixture-shell-short shell - (Wait six seconds)",
      ],
      [
        "fixture-shell-long shell sleep 120 && echo LONG_DONE (Wait two minutes)",
        "fixture-shell-short shell sleep 6 && echo SHORT_DONE (Wait six seconds)",
      ],
      ["fixture-shell-short shell sleep 6 && echo SHORT_DONE (Wait six seconds)"],
      [],
    ]);
  });

  it("renders MCP tools as dynamic tool parts", async () => {
    const events = replay([
      assistant("msg_1", [
        { type: "tool_use", id: "t1", name: "mcp__gram__set_title", input: { title: "x" } },
      ]),
      toolResult("t1", "ok"),
      result({}),
    ]);
    const messages = await assemble(events);
    expect(toolParts(messages.get("m1"))).toMatchObject([
      { type: "dynamic-tool", state: "output-available", output: "ok", input: { title: "x" } },
    ]);
  });

  // CLI 2.1.273's init lists `Task`; the SDK's tool typings name it `Agent`. Nesting is keyed by
  // `parent_tool_use_id`, so both render the same.
  it.each(["Task", "Agent"])(
    "nests subagent output in its own message under the %s call",
    async (toolName) => {
      const events = replay([
        assistant("msg_1", [
          {
            type: "tool_use",
            id: "task1",
            name: toolName,
            input: { description: "d", prompt: "p" },
          },
        ]),
        assistant("msg_sub", [{ type: "text", text: "looking" }], "task1"),
        assistant(
          "msg_sub",
          [{ type: "tool_use", id: "grep1", name: "Grep", input: { pattern: "x" } }],
          "task1",
        ),
        toolResult("grep1", "found", { parent: "task1" }),
        toolResult("task1", "done"),
        assistant("msg_2", [{ type: "text", text: "summary" }]),
        result({}),
      ]);
      expect(withoutMetadata(summarize(events))).toEqual([
        "m1 start",
        "m1 start-step",
        `m1 tool-input-available ${toolName}`,
        "m2 start",
        "m2 start-step",
        "m2 text-start",
        "m2 text-delta",
        "m2 text-end",
        "m2 tool-input-available Grep",
        "m2 tool-output-available",
        "m2 finish-step",
        "m2 finish",
        "m1 tool-output-available",
        "m1 finish-step",
        "m1 start-step",
        "m1 text-start",
        "m1 text-delta",
        "m1 text-end",
        "m1 finish-step",
        "m1 finish",
        "usage",
        "turnEnd completed",
      ]);
      const start = events.find((e) => e.type === "chunk" && e.messageId === "m2");
      expect(start?.type === "chunk" && start.chunk).toEqual({
        type: "start",
        messageId: "m2",
        messageMetadata: { agent: "claude", parentToolUseId: "task1" },
      });
      const messages = await assemble(events);
      expect(textOf(messages.get("m2"))).toBe("looking");
      expect(textOf(messages.get("m1"))).toBe("summary");
    },
  );

  it("records agentMessageIds per UIMessage, including subagent messages", async () => {
    const events = replay([
      withUuid(
        assistant("msg_1", [{ type: "tool_use", id: "task1", name: "Agent", input: {} }]),
        "a1",
      ),
      withUuid(assistant("msg_sub", [{ type: "text", text: "looking" }], "task1"), "s1"),
      withUuid(assistant("msg_sub", [{ type: "text", text: "found it" }], "task1"), "s2"),
      toolResult("task1", "done"),
      withUuid(assistant("msg_2", [{ type: "text", text: "summary" }]), "a2"),
      result({}),
    ]);
    const messages = await assemble(events);
    expect(messages.get("m1")?.metadata).toEqual({
      agent: "claude",
      agentMessageIds: ["a1", "a2"],
      agentSessionId: "s",
      model: "m",
    });
    expect(messages.get("m2")?.metadata).toEqual({
      agent: "claude",
      parentToolUseId: "task1",
      model: "m",
      agentMessageIds: ["s1", "s2"],
    });
  });

  it("keeps a background subagent's transcript open past the turn until its task_notification", async () => {
    const events = replay([
      assistant("msg_1", [{ type: "tool_use", id: "bg1", name: "Agent", input: {} }]),
      system("task_started", { task_id: "a1", tool_use_id: "bg1", is_backgrounded: true }),
      toolResult("bg1", "launched", { structured: { status: "async_launched" } }),
      assistant("msg_sub", [{ type: "text", text: "looking" }], "bg1"),
      assistant("msg_2", [{ type: "text", text: "It runs in the background." }]),
      result({}),
      assistant("msg_sub", [{ type: "tool_use", id: "grep1", name: "Grep", input: {} }], "bg1"),
      toolResult("grep1", "found", { parent: "bg1" }),
      system("task_notification", { task_id: "a1", tool_use_id: "bg1", status: "completed" }),
      assistant("msg_3", [{ type: "text", text: "DONE" }]),
      result({}),
    ]);
    expect(withoutMetadata(summarize(events))).toEqual([
      "m1 start",
      "m1 start-step",
      "m1 tool-input-available Agent",
      "subagentUsage",
      "m2 start",
      "subagentUsage",
      "m1 tool-output-available",
      "m2 start-step",
      "m2 text-start",
      "m2 text-delta",
      "m2 text-end",
      "m1 finish-step",
      "m1 start-step",
      "m1 text-start",
      "m1 text-delta",
      "m1 text-end",
      "m1 finish-step",
      "m1 finish",
      "usage",
      "turnEnd completed",
      "m2 tool-input-available Grep",
      "m2 tool-output-available",
      "subagentUsage",
      "m2 finish-step",
      "m2 finish",
      "m3 start",
      "m3 start-step",
      "m3 text-start",
      "m3 text-delta",
      "m3 text-end",
      "m3 finish-step",
      "m3 finish",
      "usage",
      "turnEnd completed",
    ]);
    const messages = await assemble(events);
    expect(textOf(messages.get("m2"))).toBe("looking");
    expect(toolParts(messages.get("m2"))).toMatchObject([{ state: "output-available" }]);
    // The reply to the report is the agent's own turn.
    const followUp = events.find(
      (e) => e.type === "chunk" && e.messageId === "m3" && e.chunk.type === "start",
    );
    expect(followUp?.type === "chunk" && followUp.chunk).toMatchObject({
      messageMetadata: { agent: "claude", initiator: "agent" },
    });
  });

  it("marks the reply to a background shell's exit between turns agent-initiated", () => {
    const events = replay([
      assistant("msg_1", [
        { type: "tool_use", id: "b1", name: "Bash", input: { command: "pnpm check" } },
      ]),
      toolResult("b1", "Command was moved to the background after 120s"),
      result({}),
      system("task_notification", { task_id: "ambient", status: "completed", ambient: true }),
      assistant("msg_2", [{ type: "text", text: "unprompted" }]),
      result({}),
      system("task_notification", { task_id: "s1", tool_use_id: "b1", status: "completed" }),
      assistant("msg_3", [{ type: "text", text: "the checks passed" }]),
      result({}),
    ]);
    const starts = events.flatMap((e) =>
      e.type === "chunk" && e.chunk.type === "start" ? [e.chunk.messageMetadata] : [],
    );
    expect(starts).toEqual([
      { agent: "claude" },
      { agent: "claude" },
      { agent: "claude", initiator: "agent" },
    ]);
  });

  it("doesn't mark the next reply agent-initiated when the user sent something first", () => {
    const mapper = newMapper();
    const events = [
      assistant("msg_1", [{ type: "tool_use", id: "bg1", name: "Agent", input: {} }]),
      toolResult("bg1", "launched", { structured: { status: "async_launched" } }),
      result({}),
      system("task_notification", { task_id: "a1", tool_use_id: "bg1", status: "completed" }),
    ].flatMap((m) => mapper.map(m));
    mapper.sent();
    const reply = mapper.map(assistant("msg_2", [{ type: "text", text: "OK" }]));
    const start = [...events, ...reply].find(
      (e) => e.type === "chunk" && e.messageId === "m3" && e.chunk.type === "start",
    );
    expect(start?.type === "chunk" && start.chunk).toEqual({
      type: "start",
      messageId: "m3",
      messageMetadata: { agent: "claude" },
    });
  });

  it("closes a background subagent's transcript when the query ends without a notification", () => {
    const mapper = newMapper();
    const events = [
      assistant("msg_1", [{ type: "tool_use", id: "bg1", name: "Agent", input: {} }]),
      toolResult("bg1", "launched", { structured: { status: "async_launched" } }),
      assistant("msg_sub", [{ type: "text", text: "looking" }], "bg1"),
      result({}),
    ].flatMap((m) => mapper.map(m));
    expect(summarize(events)).not.toContain("m2 finish");
    expect(withoutMetadata(summarize(mapper.flush())).slice(-1)).toEqual(["m2 finish"]);
  });

  // CLI 2.1.273 runs agents in the background by default and starts a follow-up turn once the
  // subagent reports back.
  it("reports the recorded Explore subagent's tokens while it runs and when it reports back", () => {
    const usages = subagentUsages(replayFixture("p12-background-subagent"));
    expect(usages).toMatchObject([
      { status: "running", startedAt: STARTED_AT, subagentType: "Explore" },
      { status: "running", startedAt: STARTED_AT, subagentType: "Explore" },
      { status: "running", totalTokens: 9207, toolUses: 1, startedAt: STARTED_AT },
      { status: "completed", startedAt: STARTED_AT },
    ]);
    expect(new Set(usages.map((u) => u.toolCallId)).size).toBe(1);
    // The notification's summary is the whole report; it stays in the transcript.
    expect(usages[3]).not.toHaveProperty("summary");
  });

  it("keeps a recorded background Explore subagent in one transcript across both turns", async () => {
    const events = replayFixture("p12-background-subagent");
    const messages = await assemble(events);
    const nested = [...messages.values()].filter((m) => m.metadata?.parentToolUseId !== undefined);
    expect(nested).toHaveLength(1);
    expect(textOf(nested[0])).not.toBe("");
    const finished = events.findIndex(
      (e) => e.type === "chunk" && e.messageId === nested[0]!.id && e.chunk.type === "finish",
    );
    const turnEnds = events.flatMap((e, i) => (e.type === "turnEnd" ? [i] : []));
    expect(turnEnds).toHaveLength(2);
    expect(finished).toBeGreaterThan(turnEnds[0]!);
    expect(finished).toBeLessThan(turnEnds[1]!);
  });

  it("keeps a background subagent's transcript when the user sends a message meanwhile", async () => {
    const events = replay([
      assistant("msg_1", [{ type: "tool_use", id: "bg1", name: "Agent", input: {} }]),
      toolResult("bg1", "launched", { structured: { status: "async_launched" } }),
      assistant("msg_sub", [{ type: "text", text: "looking" }], "bg1"),
      result({}),
      userText("Reply OK."),
      assistant("msg_2", [{ type: "text", text: "OK" }]),
      assistant("msg_sub", [{ type: "tool_use", id: "grep1", name: "Grep", input: {} }], "bg1"),
      toolResult("grep1", "found", { parent: "bg1" }),
      result({}),
      assistant("msg_sub2", [{ type: "text", text: "three files" }], "bg1"),
      system("task_notification", { task_id: "a1", tool_use_id: "bg1", status: "completed" }),
    ]);
    const lines = withoutMetadata(summarize(events));
    // One transcript for the subagent across both turns, finished only by the notification.
    expect(lines.filter((line) => line.endsWith(" start"))).toEqual([
      "m1 start",
      "m2 start",
      "m3 start",
    ]);
    expect(lines.at(-1)).toBe("m2 finish");
    expect(lines.indexOf("m2 finish")).toBe(lines.length - 1);
    const messages = await assemble(events);
    expect(textOf(messages.get("m2"))).toBe("lookingthree files");
    expect(toolParts(messages.get("m2"))).toMatchObject([{ state: "output-available" }]);
    expect(textOf(messages.get("m3"))).toBe("OK");
  });

  it("streams tool input deltas and takes the final input from the complete message", async () => {
    const events = replay([
      streamEvent({ type: "message_start", message: { id: "msg_1" } }),
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":' },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '"ls"}' },
      }),
      assistant("msg_1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
      streamEvent({ type: "content_block_stop", index: 0 }),
      toolResult("t1", "a\nb", { structured: { stdout: "a\nb", stderr: "", interrupted: false } }),
      result({}),
    ]);
    expect(withoutMetadata(summarize(events)).slice(2, 6)).toEqual([
      "m1 tool-input-start Bash",
      "m1 tool-input-delta x2",
      "m1 tool-input-available Bash",
      "m1 tool-output-available",
    ]);
    const messages = await assemble(events);
    expect(toolParts(messages.get("m1"))).toMatchObject([
      { type: "tool-Bash", state: "output-available", input: { command: "ls" } },
    ]);
  });

  /**
   * The SDK carries `tool_use_result` on the parent's message only, so every tool a subagent runs
   * reports its result text instead. The web cards have to render a bare string for any tool.
   */
  it("hands a subagent's tool result on as text, and the parent's as the structured output", async () => {
    const events = replay([
      assistant("msg_1", [
        { type: "tool_use", id: "task1", name: "Task", input: { description: "d", prompt: "p" } },
      ]),
      assistant(
        "msg_sub",
        [{ type: "tool_use", id: "fetch1", name: "WebFetch", input: { url: "u", prompt: "p" } }],
        "task1",
      ),
      toolResult("fetch1", "Fetched 12 links.", { parent: "task1" }),
      toolResult("task1", "done", { structured: { status: "completed", totalTokens: 12 } }),
      result({}),
    ]);
    const messages = await assemble(events);
    expect(toolParts(messages.get("m2"))).toMatchObject([
      { type: "tool-WebFetch", state: "output-available", output: "Fetched 12 links." },
    ]);
    expect(toolParts(messages.get("m1"))).toMatchObject([
      { type: "tool-Task", state: "output-available", output: { status: "completed" } },
    ]);
  });

  it("maps result outcomes to turn-end reasons", () => {
    expect(reason({ subtype: "error_max_turns", terminal_reason: "max_turns" })).toEqual({
      type: "turnEnd",
      reason: "maxTurns",
    });
    expect(
      reason({
        subtype: "error_during_execution",
        errors: ["boom"],
        is_error: true,
        terminal_reason: "api_error",
      }),
    ).toEqual({ type: "turnEnd", reason: "error", error: "boom" });
    expect(reason({ is_error: true, result: "Prompt is too long" })).toEqual({
      type: "turnEnd",
      reason: "error",
      error: "Prompt is too long",
    });
    expect(reason({ terminal_reason: "aborted_streaming" })).toEqual({
      type: "turnEnd",
      reason: "interrupted",
    });
  });

  it("classifies invented API errors with gateway refusals first", () => {
    expect(failure("p15-api-error-429")).toEqual({
      type: "turnEnd",
      reason: "error",
      error: "API Error: 429 No deployments available for selected model. cooldown_list=[]",
      failure: { kind: "gatewayRefused", httpStatus: 429, code: "rate_limit", retryable: false },
    });
    expect(failure("p15-api-error-403")).toMatchObject({
      failure: { kind: "costGuard", httpStatus: 403, code: "authentication_failed" },
    });
    expect(failure("p15-api-error-401")).toMatchObject({
      failure: { kind: "auth", httpStatus: 401, code: "authentication_failed", retryable: false },
    });
  });

  it("reads an allowed report only with a share and a 5-hour or weekly window", () => {
    expect(
      replay([
        rateLimitReport({
          status: "allowed",
          rateLimitType: "seven_day",
          utilization: 0.61,
          resetsAt: 9,
        }),
        rateLimitReport({ status: "allowed", rateLimitType: "five_hour" }),
        rateLimitReport({ status: "allowed", rateLimitType: "overage", utilization: 0.9 }),
        rateLimitReport({ status: "allowed", utilization: 0.3 }),
      ]),
    ).toEqual([
      {
        type: "rateLimit",
        status: "allowed",
        window: "seven_day",
        utilization: 0.61,
        resetsAt: 9000,
      },
    ]);
  });

  it("reads a window spent but carried on extra usage as allowed on credits, not a refusal", () => {
    expect(
      replay([
        rateLimitReport({
          status: "rejected",
          rateLimitType: "five_hour",
          utilization: 1,
          resetsAt: 9,
          overageStatus: "allowed",
          isUsingOverage: true,
        }),
        rateLimitReport({
          status: "allowed",
          rateLimitType: "seven_day",
          utilization: 0.4,
          isUsingOverage: true,
        }),
      ]),
    ).toEqual([
      {
        type: "rateLimit",
        status: "allowed",
        window: "five_hour",
        utilization: 1,
        resetsAt: 9000,
        credits: true,
      },
      {
        type: "rateLimit",
        status: "allowed",
        window: "seven_day",
        utilization: 0.4,
        credits: true,
      },
    ]);
    // With extra usage refused too, it is the refusal it says.
    const refused = replay([
      rateLimitReport({
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 9,
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
      }),
    ]);
    expect(refused).toContainEqual({
      type: "rateLimit",
      status: "rejected",
      window: "five_hour",
      resetsAt: 9000,
    });
  });

  it("maps retries, rate limits, compaction, mode changes and auth errors", () => {
    const events = replay([
      system("session_state_changed", { state: "running" }),
      system("api_retry", {
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 500,
        error_status: 529,
        error: "overloaded",
      }),
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.4 },
        ...base,
      } as unknown as SDKMessage,
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 0.8,
        },
        ...base,
      } as unknown as SDKMessage,
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 1790000000 },
        ...base,
      } as unknown as SDKMessage,
      system("status", { status: "compacting" }),
      system("status", { status: null, compact_result: "failed", compact_error: "too big" }),
      system("status", { status: null, permissionMode: "acceptEdits" }),
      system("status", { status: null, permissionMode: "acceptEdits" }),
      {
        type: "auth_status",
        isAuthenticating: false,
        output: [],
        error: "OAuth token expired",
        ...base,
      } as unknown as SDKMessage,
    ]);
    expect(summarize(events)).toEqual([
      "status running",
      "status retrying (API retry 2/10 (HTTP 529))",
      "rateLimit allowed five_hour 0.4 -",
      "rateLimit warning five_hour 0.8 -",
      "status retrying",
      "rateLimit rejected seven_day - 1790000000000",
      "status compacting",
      "status running",
      "notice warning (Compaction failed: too big)",
      "mode acceptEdits",
      "status error",
      "notice error (OAuth token expired. Run `claude /login`.)",
    ]);
  });

  it("marks compaction with a compaction data part", async () => {
    const events = replay([
      system("compact_boundary", {
        uuid: "c1",
        compact_metadata: { trigger: "auto", pre_tokens: 120000, post_tokens: 9000 },
      }),
      system("session_state_changed", { state: "idle" }),
    ]);
    const messages = await assemble(events);
    expect(partsOf(messages.get("m1"))).toEqual([
      {
        type: "data-compaction",
        id: "compaction:c1",
        data: { trigger: "auto", preTokens: 120000, postTokens: 9000, at: STARTED_AT },
      },
    ]);
  });

  it("replays a recorded /compact: the hook's summary rides the marker and the meter drops", async () => {
    const mapper = newMapper();
    const recorded = readFileSync(new URL("p16-compact.jsonl", FIXTURES), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { msg?: SDKMessage; note?: string; data?: unknown });
    const events = recorded.flatMap((entry) =>
      entry.msg !== undefined
        ? mapper.map(entry.msg)
        : entry.note === "PostCompact"
          ? mapper.compacted((entry.data as { compact_summary: string }).compact_summary)
          : entry.note === "PreCompact"
            ? mapper.compacting((entry.data as { trigger: "manual" | "auto" }).trigger)
            : [],
    );
    // Live from its status on, named by its hook, and busy until the marker is in.
    const startedAt = events.findIndex((e) => e.type === "status" && e.status === "compacting");
    const markerAt = events.findIndex(
      (e) => e.type === "chunk" && e.chunk.type === "data-compaction",
    );
    const between = events.slice(startedAt, markerAt).filter((e) => e.type === "status");
    // The last request's prompt; the boundary's 13952 also counts the reply to it.
    expect(between).toEqual([
      {
        type: "status",
        status: "compacting",
        compaction: { startedAt: STARTED_AT, preTokens: 13809 },
      },
      {
        type: "status",
        status: "compacting",
        compaction: { startedAt: STARTED_AT, preTokens: 13809, trigger: "manual" },
      },
    ]);
    expect(events[markerAt + 1]).toEqual({ type: "status", status: "running" });
    const messages = await assemble(events);
    const markers = [...messages.values()].flatMap((m) =>
      m.parts.filter((p) => p.type === "data-compaction"),
    );
    expect(markers).toHaveLength(1);
    const { summary, ...data } = markers[0]!.data as Record<string, unknown>;
    expect(data).toEqual({ trigger: "manual", preTokens: 13952, postTokens: 3765, at: STARTED_AT });
    // The `<summary>` the session carries on from, without the model's `<analysis>` notes.
    expect(summary).toMatch(/^1\. Primary Request and Intent:/);
    expect(summary).not.toContain("Fixture analysis must stay hidden.");
    expect(summary).not.toContain("</summary>");
    const usage = events.filter((e) => e.type === "usage");
    expect(usage.at(-1)).toMatchObject({ contextTokens: 3765 });
  });

  it("reads a summary without its analysis, and in linear time on repeated tags", () => {
    expect(summaryOf("<analysis>notes</analysis>\nThe gist.")).toBe("The gist.");
    expect(summaryOf("<summary>Cut off")).toBe("Cut off");
    expect(summaryOf("<analysis>only notes</analysis>")).toBeUndefined();
    expect(summaryOf("<analysis>unfinished private notes")).toBeUndefined();
    expect(summaryOf("<analysis>private notes</analys")).toBeUndefined();
    expect(summaryOf("Retained context.\n<analysis>unfinished private notes")).toBe(
      "Retained context.",
    );
    expect(summaryOf("<analysis>unfinished notes\n<summary>Preserved result.</summary>")).toBe(
      "Preserved result.",
    );
    expect(summaryOf("<analysis>first</analysis><analysis>second</analysis>The gist.")).toBe(
      "The gist.",
    );
    const started = performance.now();
    summaryOf("<analysis>".repeat(50_000));
    summaryOf("<analysis></analysis>".repeat(50_000));
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("gives a marker its summary when the hook comes after the boundary", async () => {
    const mapper = newMapper();
    const events = [
      ...mapper.map(
        system("compact_boundary", {
          uuid: "c1",
          compact_metadata: { trigger: "auto", pre_tokens: 120000 },
        }),
      ),
      ...mapper.compacted("<analysis>notes</analysis>\n<summary>\nThe gist.\n</summary>"),
      // A later compaction doesn't take a summary that was already used.
      ...mapper.map(
        system("compact_boundary", { uuid: "c2", compact_metadata: { trigger: "manual" } }),
      ),
      ...mapper.map(system("session_state_changed", { state: "idle" })),
    ];
    const messages = await assemble(events);
    expect(partsOf(messages.get("m1"))).toEqual([
      {
        type: "data-compaction",
        id: "compaction:c1",
        data: { trigger: "auto", preTokens: 120000, at: STARTED_AT, summary: "The gist." },
      },
      { type: "data-compaction", id: "compaction:c2", data: { trigger: "manual", at: STARTED_AT } },
    ]);
  });

  it("uses command descriptions from initializationResult in identity", () => {
    const mapper = newMapper();
    mapper.setCommands([{ name: "review", description: "Review a PR" }]);
    const [identity] = mapper.map(
      system("init", {
        model: "opus",
        tools: [],
        slash_commands: ["review", "compact"],
        apiKeySource: "none",
      }),
    );
    expect(identity).toMatchObject({
      commands: [
        { name: "review", description: "Review a PR" },
        { name: "compact", description: "" },
      ],
    });
  });

  describe("the commands a thread offers", () => {
    const reported = [
      { name: "gram-cmd", description: "Project command", argumentHint: "<word>" },
      { name: "dataviz", description: "Charts", builtin: true },
      { name: "context", description: "Show context usage", builtin: true },
      { name: "plugins-lab", description: "A CLI command not checked here", builtin: true },
      { name: "clear", description: "Start a new session", builtin: true, aliases: ["reset"] },
      { name: "agents", description: "(removed)", builtin: true },
      { name: "__remote-workflow", description: "Internal", builtin: true },
    ];
    const initWith = (skills: Array<string>, slash = reported.map((c) => c.name)) =>
      system("init", { model: "opus", tools: [], slash_commands: slash, skills });

    it("leaves out the CLI's own commands that do nothing in a thread, and the internal ones", () => {
      expect(
        names(
          identityFromInitialization({ commands: reported } as never, {
            agentSessionId: "s",
            model: "opus",
          }),
        ),
      ).toEqual(["gram-cmd", "dataviz", "context", "plugins-lab"]);
    });

    it("keeps, once a turn names the skills, only the CLI's own that are skills or known to work", () => {
      const mapper = newMapper();
      mapper.setCommands(reported);
      expect(names(mapper.map(initWith(["dataviz"]))[0])).toEqual([
        "gram-cmd",
        "dataviz",
        "context",
      ]);
    });

    it("reports a changed list against the last init, and not an unchanged one", () => {
      const mapper = newMapper();
      mapper.setCommands(reported);
      mapper.map(initWith([]));
      const added = [...reported, { name: "new-skill", description: "Found in a subdirectory" }];
      const [next] = mapper.map(system("commands_changed", { commands: added }));
      expect(next).toMatchObject({ type: "identity", agentSessionId: "s", model: "opus" });
      expect(names(next)).toEqual(["gram-cmd", "context", "new-skill"]);
      expect(mapper.map(system("commands_changed", { commands: added }))).toEqual([]);
    });
  });

  it("warns with what a command's shell step wrote to stderr, which comes only in a replay", () => {
    const replayed = {
      ...userText(
        "<local-command-stderr>Shell command failed for pattern &quot;!`git diff origin/HEAD...`&quot;: fatal: ambiguous argument 'origin/HEAD...'</local-command-stderr>",
      ),
      isReplay: true,
    } as unknown as SDKMessage;
    expect(newMapper().map(replayed)).toEqual([
      {
        type: "notice",
        level: "warning",
        message:
          "Shell command failed for pattern \"!`git diff origin/HEAD...`\": fatal: ambiguous argument 'origin/HEAD...'",
      },
    ]);
    const stdout = {
      ...userText("<local-command-stdout>Compacted </local-command-stdout>"),
      isReplay: true,
    };
    expect(newMapper().map(stdout as unknown as SDKMessage)).toEqual([]);
  });

  it("keeps the context window across a local command's synthetic reply", () => {
    const local = {
      ...assistant("local-1", [{ type: "text", text: "## Context Usage" }]),
      message: {
        id: "local-1",
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "## Context Usage" }],
      },
    } as unknown as SDKMessage;
    const events = replay([
      modelRequest("msg_1", "claude-opus-4-7"),
      priced("claude-opus-4-7", 0.01, 0.01),
      local,
      result({ total_cost_usd: 0.01, modelUsage: {} }),
    ]);
    const last = events.findLast((e) => e.type === "usage");
    expect(last?.type === "usage" && last.contextWindow).toBe(200_000);
  });

  it("flushes open messages when the query ends mid-turn", () => {
    const mapper = newMapper();
    mapper.map(assistant("msg_1", [{ type: "text", text: "partial" }]));
    expect(summarize(mapper.flush())).toEqual(["m1 finish-step", "m1 finish"]);
    expect(mapper.flush()).toEqual([]);
  });

  describe("cost while a turn runs", () => {
    // 1000 + 200 × 5 + 10000 × 0.1 input-token equivalents.
    const WEIGHT = 3_000;

    it("guesses from the family's list price until the session has a result", () => {
      const [running] = costs(replay([modelRequest("msg_1", "claude-opus-4-7")]));
      expect(running?.costEstimated).toBe(true);
      expect(running?.costUsd).toBeCloseTo(WEIGHT * 5e-6, 12);
    });

    it("prefers the price the SDK advertises for the picked model to the family table", () => {
      const mapper = newMapper();
      mapper.setAdvertisedRate(2e-6);
      const [running] = costs(mapper.map(modelRequest("msg_1", "claude-sonnet-5")));
      expect(running?.costUsd).toBeCloseTo(WEIGHT * 2e-6, 12);
      // A gateway alias names no family, but its picker entry can still carry a price.
      const [alias] = costs(mapper.map(modelRequest("msg_2", "gateway-alias[1m]")));
      expect(alias?.costEstimated).toBe(true);
    });

    it("says nothing for a model it can't price, rather than guess a family", () => {
      expect(costs(replay([modelRequest("msg_1", "gateway-alias[1m]")]))).toEqual([
        { costUsd: undefined, costEstimated: undefined },
      ]);
    });

    it("adds the turn's guess, at the rate the session has paid, to what it has been charged", () => {
      const events = replay([
        modelRequest("msg_1", "gateway-alias[1m]"),
        priced("gateway-alias[1m]", 0.0075, 0.0075),
        modelRequest("msg_2", "gateway-alias[1m]"),
      ]);
      const [, settled, running] = costs(events);
      expect(settled).toEqual({ costUsd: 0.0075, costEstimated: undefined });
      expect(running?.costEstimated).toBe(true);
      expect(running?.costUsd).toBeCloseTo(0.0075 + 0.0075, 12);
    });

    it("takes a resumed session's carried total off, and counts on across a restart", () => {
      const mapper = makeMapper({ newMessageId: () => MessageId.make("m"), carriedCost: 1 });
      const reported = [1.25, 1.5, 0.125, 0.25].flatMap((total) =>
        costs(mapper.map(result({ total_cost_usd: total }))),
      );
      // `/clear` restarts the counter: 0.5 was spent before it, 0.125 then 0.25 after.
      expect(reported.map((c) => c.costUsd)).toEqual([0.25, 0.5, 0.625, 0.75]);
    });

    it("hands a new session the rates an earlier one learned", () => {
      const rates = new Map<string, number>();
      const first = newMapper(rates);
      for (const m of [modelRequest("msg_1", "alias"), priced("alias", 0.006, 0.006)]) first.map(m);
      const [running] = costs(newMapper(rates).map(modelRequest("msg_1", "alias")));
      expect(running?.costEstimated).toBe(true);
      expect(running?.costUsd).toBeCloseTo(0.006, 12);
    });
  });
});

// SDK 0.3.296 `sdk.d.ts`: a foreground command is registered as a `local_bash` task
// (`SDKTaskStartedMessage`, `is_backgrounded: false`) once it has run a few seconds, and
// `getTaskOutput` answers with an `SDKControlGetTaskOutputResponse`.
const shellRead = (output: string, truncated = false): TaskOutputRead => ({
  output,
  total_bytes: output.length,
  truncated,
});
const bashCall = (id: string, parent: string | null = null) =>
  assistant(
    parent === null ? "msg_1" : "msg_sub",
    [{ type: "tool_use", id, name: "Bash", input: { command: "pnpm test" } }],
    parent,
  );
const shellStarted = (taskId: string, toolUseId: string, backgrounded = false): SDKMessage =>
  ({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: toolUseId,
    description: "Run the tests",
    is_backgrounded: backgrounded,
    task_type: "local_bash",
    ...base,
  }) satisfies Omit<SDKTaskStartedMessage, "uuid"> & { uuid: string } as unknown as SDKMessage;
const taskUpdated = (taskId: string, patch: SDKTaskUpdatedMessage["patch"]) =>
  ({
    type: "system",
    subtype: "task_updated",
    task_id: taskId,
    patch,
    ...base,
  }) as unknown as SDKMessage;
const preliminaryOutput = (stdout: string, toolCallId = "t1") => ({
  type: "tool-output-available",
  toolCallId,
  output: { stdout, stderr: "", interrupted: false },
  preliminary: true,
  providerExecuted: true,
});
const chunksOf = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((e) => (e.type === "chunk" ? [e.chunk] : []));

describe("running shell output", () => {
  // CLI 2.1.272: `sleep 6 && echo FIRST_DONE` is registered 3.6 s in, and its task ends a moment
  // before its result.
  it("follows a recorded foreground Bash from its task's start to its result", async () => {
    const TASK = "00000000-0000-4000-8000-000000000142";
    const mapper = newMapper();
    const messages = fixture("p04-streaming-input-default").map((entry) => entry.msg);
    const at = messages.findIndex((m) => m.type === "system" && m.subtype === "task_started");
    const events = messages.slice(0, at).flatMap((m) => mapper.map(m));
    expect(mapper.runningShells()).toEqual([]);
    events.push(...mapper.map(messages[at]!));
    expect(mapper.runningShells()).toEqual([{ taskId: TASK, toolCallId: "toolu_fixture_0001" }]);

    expect(mapper.shellOutput(TASK, shellRead(""))).toEqual([]);
    const first = mapper.shellOutput(TASK, shellRead("FIRST"));
    expect(chunksOf(first)).toEqual([preliminaryOutput("FIRST", "toolu_fixture_0001")]);
    expect(mapper.shellOutput(TASK, shellRead("FIRST"))).toEqual([]);
    events.push(...first);
    const running = toolParts([...(await assemble(events)).values()][0]);
    expect(running).toEqual([
      expect.objectContaining({ state: "output-available", preliminary: true }),
    ]);

    events.push(...messages.slice(at + 1).flatMap((m) => mapper.map(m)));
    expect(mapper.runningShells()).toEqual([]);
    expect(mapper.shellOutput(TASK, shellRead("FIRST_DONE"))).toEqual([]);
    const [done] = toolParts([...(await assemble(events)).values()][0]);
    expect(done).toMatchObject({ state: "output-available", output: { stdout: "FIRST_DONE" } });
    expect(done).not.toHaveProperty("preliminary", true);
  });

  it("sends each new read whole, from the first whole line of a cut tail", () => {
    const mapper = newMapper();
    for (const m of [bashCall("t1"), shellStarted("b1", "t1")]) mapper.map(m);
    expect(chunksOf(mapper.shellOutput("b1", shellRead("line 1\n")))).toEqual([
      preliminaryOutput("line 1\n"),
    ]);
    expect(chunksOf(mapper.shellOutput("b1", shellRead("line 1\nline 2\n")))).toEqual([
      preliminaryOutput("line 1\nline 2\n"),
    ]);
    expect(chunksOf(mapper.shellOutput("b1", shellRead("ne 9\nline 10\n", true)))).toEqual([
      preliminaryOutput("line 10\n"),
    ]);
    // A cut tail with no line break yet is all there is to show.
    expect(chunksOf(mapper.shellOutput("b1", shellRead("xxxx", true)))).toEqual([
      preliminaryOutput("xxxx"),
    ]);
    // One long line ending in a break: trimming would leave nothing, so it shows whole.
    expect(chunksOf(mapper.shellOutput("b1", shellRead("progress 99%\n", true)))).toEqual([
      preliminaryOutput("progress 99%\n"),
    ]);
  });

  it("forgets a shell whose call ended with no result or notification for its task", () => {
    const mapper = newMapper();
    for (const m of [bashCall("t1"), shellStarted("b1", "t1")]) mapper.map(m);
    expect(mapper.runningShells()).toEqual([{ taskId: "b1", toolCallId: "t1" }]);
    // An interrupt: the CLI goes idle and the open call is closed as cancelled.
    mapper.map(system("session_state_changed", { state: "idle" }));
    expect(mapper.runningShells()).toEqual([]);
    // A later call under the same task id is not mistaken for the old one.
    for (const m of [bashCall("t2"), shellStarted("b1", "t2")]) mapper.map(m);
    expect(mapper.runningShells()).toEqual([{ taskId: "b1", toolCallId: "t2" }]);
  });

  it("takes the task a running shell writes to from `tool_progress` too", () => {
    const progress = {
      type: "tool_progress",
      tool_use_id: "t1",
      tool_name: "Bash",
      parent_tool_use_id: null,
      elapsed_time_seconds: 4,
      task_id: "b1",
      ...base,
    } as const satisfies Omit<SDKToolProgressMessage, "uuid"> & { uuid: string };
    const mapper = newMapper();
    mapper.map(bashCall("t1"));
    // Elapsed time alone is no output: nothing is sent for it.
    expect(mapper.map(progress as unknown as SDKMessage)).toEqual([]);
    expect(mapper.runningShells()).toEqual([{ taskId: "b1", toolCallId: "t1" }]);

    const { task_id: _, ...withoutTask } = progress;
    const other = newMapper();
    other.map(bashCall("t1"));
    expect(other.map(withoutTask as unknown as SDKMessage)).toEqual([]);
    expect(other.runningShells()).toEqual([]);
  });

  it("follows backgrounded shells and a move to the background apart, and leaves out other tools", () => {
    const mapper = newMapper();
    mapper.map(
      assistant("msg_1", [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 99" } },
        { type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm dev" } },
        { type: "tool_use", id: "t3", name: "Task", input: { prompt: "look around" } },
      ]),
    );
    mapper.map(shellStarted("b1", "t1"));
    mapper.map(shellStarted("b2", "t2", true));
    mapper.map(shellStarted("a3", "t3"));
    expect(mapper.runningShells()).toEqual([
      { taskId: "b1", toolCallId: "t1" },
      { taskId: "b2", toolCallId: "t2", background: true },
    ]);
    // A background shell's read goes beside its call, which already has its final result.
    expect(mapper.shellOutput("b2", shellRead("ready on :5173\n"))).toEqual([
      { type: "backgroundOutput", taskId: "b2", toolCallId: "t2", output: "ready on :5173\n" },
    ]);
    expect(mapper.shellOutput("b2", shellRead("ready on :5173\n"))).toEqual([]);
    expect(mapper.shellOutput("b2", shellRead(""))).toEqual([]);
    expect(mapper.shellOutput("a3", shellRead("not a shell"))).toEqual([]);

    // Moved to the background on its timeout: its interim output stops and its reads go beside.
    expect(chunksOf(mapper.shellOutput("b1", shellRead("tick\n")))).toEqual([
      preliminaryOutput("tick\n"),
    ]);
    const moved = {
      type: "system",
      subtype: "task_updated",
      task_id: "b1",
      patch: { is_backgrounded: true },
      ...base,
    } as const satisfies Omit<SDKTaskUpdatedMessage, "uuid"> & { uuid: string };
    mapper.map(moved as unknown as SDKMessage);
    mapper.map(toolResult("t1", "Command was moved to the background"));
    expect(mapper.runningShells()).toEqual([
      { taskId: "b2", toolCallId: "t2", background: true },
      { taskId: "b1", toolCallId: "t1", background: true },
    ]);
    // Its last interim output was the call's; the first read beside it is sent even if the same.
    expect(mapper.shellOutput("b1", shellRead("tick\n"))).toEqual([
      { type: "backgroundOutput", taskId: "b1", toolCallId: "t1", output: "tick\n" },
    ]);
    // Cut tails are trimmed as for a foreground one.
    expect(mapper.shellOutput("b1", shellRead("ck\ntock\n", true))).toEqual([
      { type: "backgroundOutput", taskId: "b1", toolCallId: "t1", output: "tock\n" },
    ]);
  });

  it("stops following a background shell when its task ends, leaves the level or the query ends", () => {
    const level = (...ids: string[]) =>
      system("background_tasks_changed", {
        tasks: ids.map((id) => ({ task_id: id, task_type: "local_bash", description: id })),
      });
    const mapper = newMapper();
    mapper.map(
      assistant(
        "msg_1",
        ["t1", "t2", "t3", "t4"].map((id) => ({
          type: "tool_use",
          id,
          name: "Bash",
          input: { command: `run ${id}` },
        })),
      ),
    );
    // The level and `task_started` come in either order: one not listed yet stays followed.
    mapper.map(level("b1"));
    for (const [taskId, call] of [
      ["b1", "t1"],
      ["b2", "t2"],
      ["b3", "t3"],
      ["b4", "t4"],
    ] as const)
      mapper.map(shellStarted(taskId, call, true));
    const followed = () => mapper.runningShells().map((shell) => shell.taskId);
    expect(followed()).toEqual(["b1", "b2", "b3", "b4"]);
    mapper.map(level("b2", "b3", "b4"));
    expect(followed()).toEqual(["b2", "b3", "b4"]);
    expect(mapper.shellOutput("b1", shellRead("late"))).toEqual([]);
    mapper.map(taskUpdated("b2", { status: "paused" }));
    mapper.map(taskUpdated("b2", { status: "killed", end_time: 1 }));
    expect(followed()).toEqual(["b3", "b4"]);
    mapper.map(
      system("task_notification", {
        task_id: "b3",
        tool_use_id: "t3",
        status: "completed",
        output_file: "/synthetic/b3.output",
        summary: "done",
      }),
    );
    expect(followed()).toEqual(["b4"]);
    // A turn's end leaves it running; the end of the query doesn't.
    mapper.map(result({}));
    expect(followed()).toEqual(["b4"]);
    mapper.flush();
    expect(followed()).toEqual([]);
    expect(mapper.shellOutput("b4", shellRead("late"))).toEqual([]);
  });

  // CLI 2.1.296's `run_in_background` shells, recorded: two start, one is stopped and the other
  // ends between turns.
  it("follows the recorded background shells until each one's task ends", () => {
    const mapper = newMapper();
    const messages = fixture("p14-background-shells").map((entry) => entry.msg);
    const upTo = (subtype: string, taskId: string) =>
      messages.findIndex(
        (m) => m.type === "system" && m.subtype === subtype && Reflect.get(m, "task_id") === taskId,
      );
    const shortStart = upTo("task_started", "fixture-shell-short");
    const longEnd = upTo("task_notification", "fixture-shell-long");
    const shortEnd = upTo("task_notification", "fixture-shell-short");
    let at = 0;
    const replayTo = (index: number) => {
      for (; at <= index; at++) mapper.map(messages[at]!);
    };
    replayTo(shortStart - 1);
    expect(mapper.runningShells()).toEqual([
      { taskId: "fixture-shell-long", toolCallId: "toolu_fixture_0027", background: true },
    ]);
    replayTo(shortStart + 1);
    expect(mapper.runningShells().map((shell) => shell.taskId)).toEqual([
      "fixture-shell-long",
      "fixture-shell-short",
    ]);
    expect(mapper.shellOutput("fixture-shell-short", shellRead("SHORT"))).toEqual([
      {
        type: "backgroundOutput",
        taskId: "fixture-shell-short",
        toolCallId: "toolu_fixture_0026",
        output: "SHORT",
      },
    ]);
    replayTo(longEnd);
    expect(mapper.runningShells().map((shell) => shell.taskId)).toEqual(["fixture-shell-short"]);
    // Between turns, the short one is still read.
    replayTo(shortEnd - 3);
    expect(mapper.runningShells().map((shell) => shell.taskId)).toEqual(["fixture-shell-short"]);
    replayTo(shortEnd);
    expect(mapper.runningShells()).toEqual([]);
    replayTo(messages.length - 1);
    expect(mapper.runningShells()).toEqual([]);
  });

  it("puts a subagent's shell output on its lane, and stops at the end of the turn", () => {
    const mapper = newMapper();
    const events = [
      assistant("msg_1", [{ type: "tool_use", id: "task1", name: "Task", input: {} }]),
      bashCall("t1", "task1"),
      shellStarted("b1", "t1"),
    ].flatMap((m) => mapper.map(m));
    const lane = events.find(
      (e) =>
        e.type === "chunk" &&
        e.chunk.type === "start" &&
        e.chunk.messageMetadata?.parentToolUseId === "task1",
    );
    expect(lane?.type).toBe("chunk");
    const [snapshot] = mapper.shellOutput("b1", shellRead("ok\n"));
    expect(snapshot).toMatchObject({
      type: "chunk",
      messageId: lane?.type === "chunk" ? lane.messageId : "none",
    });
    mapper.map(result({ terminal_reason: "aborted_tools" }));
    expect(mapper.runningShells()).toEqual([]);
    expect(mapper.shellOutput("b1", shellRead("ok\nmore\n"))).toEqual([]);
  });
});
