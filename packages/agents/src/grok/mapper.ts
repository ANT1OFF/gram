import type { MessageId, TokenUsage } from "@gram/contracts";

import { count, type Json, record, text } from "../acp/json.ts";
import { makeAcpMapper, type AcpMapper } from "../acp/mapper.ts";

export { optionFor, scopeOf, type PermissionOption } from "../acp/permissions.ts";

/** Grok Build's own name for a call: its `x.ai/tool` meta, else the ACP title it opened with. */
export const grokToolName = (update: Json): string =>
  text(record(record(update["_meta"])["x.ai/tool"])["name"]) ?? text(update["title"]) ?? "tool";

/**
 * Grok Build's tools as Gram's cards know them: Claude Code's names and input keys, so a command,
 * an edit or a read draws the same card whichever agent made it. A tool it doesn't name (an MCP
 * server's) keeps Grok's own name and input.
 */
export const toolFor = (
  name: string,
  input: Json,
): { readonly name: string; readonly input: Json } => {
  const pick = (entries: ReadonlyArray<readonly [string, string]>) =>
    Object.fromEntries(
      entries.flatMap(([from, to]) => (input[from] === undefined ? [] : [[to, input[from]]])),
    );
  switch (name) {
    case "run_terminal_command":
      return {
        name: "Bash",
        input: pick([
          ["command", "command"],
          ["description", "description"],
          ["is_background", "run_in_background"],
        ]),
      };
    case "read_file":
      return {
        name: "Read",
        input: pick([
          ["target_file", "file_path"],
          ["offset", "offset"],
          ["limit", "limit"],
        ]),
      };
    case "search_replace":
    case "edit":
      return {
        name: "Edit",
        input: pick([
          ["file_path", "file_path"],
          ["old_string", "old_string"],
          ["new_string", "new_string"],
          ["replace_all", "replace_all"],
        ]),
      };
    case "write":
      return {
        name: "Write",
        input: pick([
          ["file_path", "file_path"],
          ["target_file", "file_path"],
          ["content", "content"],
        ]),
      };
    case "grep":
      return {
        name: "Grep",
        input: pick([
          ["pattern", "pattern"],
          ["path", "path"],
          ["glob", "glob"],
        ]),
      };
    case "glob":
      return {
        name: "Glob",
        input: pick([
          ["pattern", "pattern"],
          ["path", "path"],
        ]),
      };
    case "list_dir":
      return { name: "LS", input: pick([["target_directory", "path"]]) };
    case "web_search":
      return { name: "WebSearch", input: pick([["query", "query"]]) };
    case "web_fetch":
      return { name: "WebFetch", input: pick([["url", "url"]]) };
    case "spawn_subagent":
    case "task":
      return {
        name: "Task",
        input: pick([
          ["description", "description"],
          ["prompt", "prompt"],
          ["agent", "subagent_type"],
        ]),
      };
    case "todo_write":
      return { name: "TodoWrite", input: pick([["todos", "todos"]]) };
    case "use_tool": {
      const tool = typeof input["tool_name"] === "string" ? input["tool_name"] : undefined;
      if (tool === undefined) return { name, input };
      return {
        name: tool.includes("__") ? `mcp__${tool}` : tool,
        input: record(input["tool_input"]),
      };
    }
    default:
      return { name, input };
  }
};

/** The longest output kept from a call that gave no text content. */
const OUTPUT_MAX = 20_000;

/** What a finished call said: its text content, else the text its raw output carries. */
export const outputText = (update: Json): string => {
  const parts: Array<string> = [];
  const content = update["content"];
  if (Array.isArray(content)) {
    for (const item of content) {
      const entry = record(item);
      if (entry["type"] === "content") {
        const body = text(record(entry["content"])["text"]);
        if (body !== undefined && body !== "") parts.push(body);
      } else if (entry["type"] === "diff") {
        const path = text(entry["path"]);
        if (path !== undefined) parts.push(`Updated ${path}`);
      }
    }
  }
  if (parts.length > 0) return parts.join("\n");
  const raw = record(update["rawOutput"]);
  const found = [
    text(raw["output_for_prompt"]),
    text(record(raw["Content"])["content"]),
    text(record(raw["EditsApplied"])["tool_output_for_prompt"]),
  ].find((each) => each !== undefined && each !== "");
  if (found !== undefined) return found.slice(0, OUTPUT_MAX);
  return "";
};

/** A turn's usage as Grok Build reports it in `turn_completed`. */
export const turnUsage = (usage: Json): TokenUsage => {
  const cached = count(usage["cachedReadTokens"]);
  const written = count(usage["cacheCreationTokens"]);
  const reasoning = count(usage["reasoningTokens"]);
  return {
    inputTokens: Math.max(0, count(usage["inputTokens"]) - cached),
    outputTokens: count(usage["outputTokens"]),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(written > 0 ? { cacheWriteTokens: written } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
};

/** Grok Build prices a turn in ticks: ten billion to the US dollar. */
export const USD_TICKS = 1e10;

export interface GrokMapperOptions {
  readonly newMessageId: () => MessageId;
  /** The Grok Build session this thread runs; updates for any other are ignored. */
  readonly sessionId: string;
}

export type GrokMapper = AcpMapper;

/**
 * Grok Build's ACP updates as Gram's events: one assistant message per turn, its thinking and text
 * as parts, its calls under Claude Code's tool names, permission requests as approval cards, and
 * the turn's usage and price (`response_completed`, `turn_completed`).
 */
export const makeGrokMapper = (options: GrokMapperOptions): GrokMapper =>
  makeAcpMapper({
    agent: "grok",
    sessionId: options.sessionId,
    newMessageId: options.newMessageId,
    toolOf: (update) => toolFor(grokToolName(update), record(update["rawInput"])),
    outputOf: outputText,
    refusal: "Grok declined to continue.",
    extension: (update, turn) => {
      if (update["sessionUpdate"] === "response_completed") {
        const usage = record(update["usage"]);
        turn.setContextTokens(
          count(usage["input_tokens"]) + count(usage["cache_read_input_tokens"]),
        );
        turn.endStep();
      } else if (update["sessionUpdate"] === "turn_completed") {
        const usage = record(update["usage"]);
        const ticks = usage["costUsdTicks"];
        turn.setTurnUsage(
          turnUsage(usage),
          typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0 ? ticks / USD_TICKS : 0,
        );
      }
    },
  });
