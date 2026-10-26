import { makeMapper as makeClaudeMapper } from "@gram/agents/claude";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { MessageId } from "@gram/contracts";
import { expect, it } from "vitest";

import { MessageAccumulator } from "./message-accumulator.ts";

it("does not leave a Claude tool Running when the CLI goes idle without returning its result", () => {
  const acc = new MessageAccumulator("audit");
  const mapper = makeClaudeMapper({ newMessageId: () => MessageId.make("audit") });
  const events = [
    {
      type: "assistant",
      uuid: "a",
      parent_tool_use_id: null,
      message: {
        id: "a",
        model: "synthetic-model",
        content: [{ type: "tool_use", id: "call", name: "Bash", input: { command: "echo audit" } }],
        usage: {},
      },
    },
    { type: "system", subtype: "session_state_changed", state: "idle" },
  ];
  for (const message of events)
    for (const event of mapper.map(message as SDKMessage)) {
      if (event.type === "chunk") acc.apply(event.chunk);
    }
  const message = JSON.parse(JSON.stringify(acc.snapshot()));
  expect(message.parts).toContainEqual(
    expect.objectContaining({ type: "tool-Bash", state: "output-error", errorText: "Cancelled" }),
  );
});
