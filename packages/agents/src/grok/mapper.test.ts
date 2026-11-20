import { MessageId, RequestId, type AgentEvent } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { makeGrokMapper, optionFor, scopeOf } from "./mapper.ts";

const SESSION = "session-1";

const mapper = () => {
  let n = 0;
  return makeGrokMapper({ sessionId: SESSION, newMessageId: () => MessageId.make(`m${++n}`) });
};

const chunks = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((event) => (event.type === "chunk" ? [event.chunk] : []));

/** One turn as Grok Build streams it: a thought, a reply, a command and its result, its usage. */
const TURN = [
  { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking the folder." } },
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I'll list it." } },
  {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "run_terminal_command",
    rawInput: { command: "ls", description: "List files" },
    _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } },
  },
  {
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "README.md\n" } }],
  },
  {
    sessionUpdate: "response_completed",
    usage: { input_tokens: 400, cache_read_input_tokens: 1600, output_tokens: 20 },
  },
  { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
  {
    sessionUpdate: "turn_completed",
    usage: {
      inputTokens: 3000,
      outputTokens: 50,
      cachedReadTokens: 2000,
      reasoningTokens: 10,
      costUsdTicks: 120_000_000,
    },
  },
];

describe("Grok Build mapper", () => {
  it("maps a turn to one message with its thought, text, command card and priced usage", () => {
    const map = mapper();
    const events = [
      ...map.started(),
      ...TURN.flatMap((update) => map.update(update)),
      ...map.ended("end_turn"),
    ];
    const parts = chunks(events);
    expect(parts.map((part) => part.type)).toEqual([
      "start",
      "start-step",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-available",
      "tool-output-available",
      "finish-step",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
    expect(parts.find((part) => part.type === "tool-input-available")).toMatchObject({
      toolName: "Bash",
      input: { command: "ls", description: "List files" },
    });
    expect(parts.find((part) => part.type === "tool-output-available")).toMatchObject({
      output: "README.md\n",
    });
    expect(events.find((event) => event.type === "usage")).toEqual({
      type: "usage",
      tokens: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 2000, reasoningTokens: 10 },
      costUsd: 0.012,
      contextTokens: 2000,
    });
    expect(events.slice(-2)).toEqual([
      { type: "turnEnd", reason: "completed" },
      { type: "status", status: "idle" },
    ]);
  });

  it("ignores updates a resumed session replays outside a turn, so past prices aren't counted again", () => {
    const map = mapper();
    const replayed = TURN.flatMap((update) => map.update(update));
    expect(replayed).toEqual([]);
    const events = [...map.started(), ...map.update(TURN.at(-1)!), ...map.ended("end_turn")];
    expect(events.find((event) => event.type === "usage")).toMatchObject({ costUsd: 0.012 });
    expect(map.costUsd()).toBe(0.012);
  });

  it("closes a cancelled turn's open calls as cancelled and resolves its cards", () => {
    const map = mapper();
    map.started();
    map.update(TURN[2]!);
    const request = RequestId.make("r1");
    const asked = map.permission(request, {
      toolCall: TURN[2],
      options: [
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject-once", kind: "reject_once" },
      ],
    });
    expect(asked).toContainEqual({ type: "status", status: "awaitingApproval" });
    const ended = map.ended("cancelled");
    expect(chunks(ended)).toContainEqual(
      expect.objectContaining({ type: "tool-output-error", toolCallId: "call-1", errorText: "Cancelled" }),
    );
    expect(ended).toContainEqual({ type: "requestResolved", requestId: request });
    expect(ended).toContainEqual({ type: "turnEnd", reason: "interrupted" });
  });
});

describe("Grok Build permission options", () => {
  const offered = [
    { optionId: "allow-edits-session", kind: "allow_always" },
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "always-allow", kind: "allow_always" },
    { optionId: "reject-once", kind: "reject_once" },
    { optionId: "reject-always", kind: "reject_always" },
  ];

  it("reads a session-long grant from its id", () => {
    expect(offered.map(scopeOf)).toEqual(["session", "once", "always", undefined, undefined]);
  });

  it("answers with the option for the decision and scope, never a wider allow than asked", () => {
    expect(optionFor(offered, "allow", "session")?.optionId).toBe("allow-edits-session");
    expect(optionFor(offered, "allow", "always")?.optionId).toBe("always-allow");
    expect(optionFor(offered, "allow", "once")?.optionId).toBe("allow-once");
    expect(optionFor(offered.slice(1, 2), "allow", "always")?.optionId).toBe("allow-once");
    expect(optionFor(offered, "deny", undefined)?.optionId).toBe("reject-once");
  });
});
