import type { UsageProvider } from "@gram/contracts";
import type { Fields } from "./json-projection.ts";
import { makeClaudeHistory } from "./claude-history.ts";
import { makeCodexHistory } from "./codex-history.ts";
export * from "./history-types.ts";
const counters: Fields = Object.fromEntries(
  [
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "reasoning_output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ].map((key) => [key, true]),
);
export const historyFields: Fields = {
  type: true,
  timestamp: true,
  sessionId: true,
  uuid: true,
  requestId: true,
  isSidechain: true,
  parent_tool_use_id: true,
  forkedFrom: { sessionId: true, messageUuid: true },
  message: { id: true, model: true, usage: counters },
  payload: {
    type: true,
    id: true,
    session_id: true,
    model: true,
    turn_id: true,
    thread_id: true,
    response_id: true,
    from_model: true,
    to_model: true,
    forked_from_id: true,
    parent_thread_id: true,
    source: { subagent: { thread_spawn: { parent_thread_id: true } } },
    info: { total_token_usage: counters, last_token_usage: counters },
    usage: counters,
    turn_token_usage: counters,
  },
};

export const makeHistoryReducer = (provider: UsageProvider, from = -Infinity, to = Infinity) =>
  provider === "codex" ? makeCodexHistory(from, to) : makeClaudeHistory(from, to);
