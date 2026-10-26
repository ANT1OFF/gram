#!/usr/bin/env node
// Invented mapper inputs. No agent CLI, SDK query, network or account configuration is used.
// Regenerate: node packages/agents/scripts/generate-error-fixtures.mjs
import { writeFileSync } from "node:fs";

const refusals = {
  401: "Invalid authentication token.",
  403: "API key is disabled. Check the configured provider's spending limit.",
  429: "No deployments available for selected model. cooldown_list=[]",
};
const write = (adapter, name, lines) =>
  writeFileSync(
    new URL(`../fixtures/${adapter}/${name}.jsonl`, import.meta.url),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );

for (const [status, message] of Object.entries(refusals)) {
  const httpStatus = Number(status);
  const session_id = `synthetic-claude-error-${status}`;
  let sequence = 0;
  const row = (msg) => ({ msg: { ...msg, session_id, uuid: `error-${status}-${++sequence}` } });
  const error = status === "429" ? "rate_limit" : "authentication_failed";
  const result = `API Error: ${status} ${message}`;
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const lines = [
    row({ type: "system", subtype: "session_state_changed", state: "running" }),
    row({
      type: "system",
      subtype: "init",
      cwd: "/synthetic/project",
      tools: ["Read", "Bash"],
      mcp_servers: [],
      model: "synthetic-model",
      permissionMode: "default",
      slash_commands: [],
      apiKeySource: "ANTHROPIC_API_KEY",
      claude_code_version: "2.1.296",
    }),
  ];
  if (status !== "403") {
    for (const attempt of [1, 2])
      lines.push(
        row({
          type: "system",
          subtype: "api_retry",
          attempt,
          max_retries: 2,
          retry_delay_ms: attempt * 100,
          error_status: httpStatus,
          error,
        }),
      );
  }
  lines.push(
    row({
      type: "assistant",
      parent_tool_use_id: null,
      error,
      is_api_error_message: true,
      message: {
        id: `synthetic-message-${status}`,
        type: "message",
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: result }],
        usage,
        stop_reason: "stop_sequence",
        stop_sequence: "",
      },
    }),
    row({
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: httpStatus,
      result,
      usage,
      modelUsage: {},
      total_cost_usd: 0,
      duration_ms: 10,
      duration_api_ms: 0,
      num_turns: 1,
      permission_denials: [],
    }),
    row({ type: "system", subtype: "session_state_changed", state: "idle" }),
  );
  write("claude", `p15-api-error-${status}`, lines);
}
