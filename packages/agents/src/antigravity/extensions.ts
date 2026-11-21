// Antigravity's ACP payloads read as Gram's: its models and thinking levels, its modes, its tools
// as Gram's cards know them, and the usage it reports. Pure.

import type { AgentModel, PermissionMode, ReasoningVariant, TokenUsage } from "@gram/contracts";

import type { OutwardGate } from "../host.ts";
import { count, type Json, record, records, text } from "../acp/json.ts";
import { answerItself } from "../acp/permissions.ts";
import type { CardTool } from "../acp/mapper.ts";
import { CUSTOMIZATIONS_FOLDER } from "./workspace.ts";

const EFFORTS: ReadonlySet<string> = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

/** The `session/new` config option with `id`. */
export const configOption = (opened: Json, id: string): Json =>
  records(opened["configOptions"]).find((option) => option["id"] === id) ?? {};

/**
 * The models a `session/new` lists, as the pickers show them: one per model of its `model` option,
 * with the thinking levels its `availableModels` pair that model with (`<model>-<level>`).
 */
export const antigravityModels = (opened: Json): ReadonlyArray<AgentModel> => {
  const paired = records(record(opened["models"])["availableModels"]).flatMap((model) => {
    const id = text(model["modelId"]);
    return id === undefined ? [] : [id];
  });
  return records(configOption(opened, "model")["options"]).flatMap((option): Array<AgentModel> => {
    const id = text(option["value"]);
    if (id === undefined) return [];
    const efforts = paired
      .filter((each) => each.startsWith(`${id}-`))
      .map((each) => each.slice(id.length + 1))
      .filter((effort): effort is ReasoningVariant => EFFORTS.has(effort));
    const description = text(option["description"]);
    return [
      {
        id,
        displayName: text(option["name"]) ?? id,
        ...(description === undefined ? {} : { description }),
        supportsEffort: efforts.length > 0,
        ...(efforts.length > 0 ? { efforts } : {}),
      },
    ];
  });
};

/**
 * Antigravity's mode for a Gram mode. Plan and Accept edits are its own; Auto is its own auto mode,
 * whose classifier still asks about what it won't run. Bypass asks, and Gram answers every request
 * itself (`autoAnswer`), so leaving Bypass takes effect at once; `--dangerously-skip-permissions`
 * would hold for the process's life. Under an outward gate Auto asks too, so Gram sees each command.
 */
export const antigravityMode = (
  mode: PermissionMode,
  gate: OutwardGate | undefined,
): "default" | "accept-edits" | "auto" | "plan" => {
  if (mode === "plan") return "plan";
  if (mode === "acceptEdits") return "accept-edits";
  if (mode === "auto" && gate === undefined) return "auto";
  return "default";
};

/** The input keys Antigravity names an edited file by. */
const EDIT_KEYS = ["Path", "TargetFile", "AbsolutePath", "file_path"];

/** Antigravity's own name for a call: its `name`, else the ACP title it opened with. */
export const antigravityToolName = (update: Json): string =>
  text(update["name"]) ?? text(update["title"]) ?? "tool";

/** The input keys Antigravity, or a tool it runs, gives a command line in. */
const COMMAND_KEYS = ["CommandLine", "commandLine", "command_line", "Command", "command"];

/** The command line a call carries, whatever its kind. */
export const commandLineOf = (call: Json): string | undefined => {
  const input = record(call["rawInput"]);
  for (const key of COMMAND_KEYS) {
    const line = text(input[key]);
    if (line !== undefined) return line;
  }
  return undefined;
};

/**
 * The answer Gram gives a permission request itself (`answerItself`). Gram's app tools are the calls
 * whose own `name` (never the title the model can shape) is for this session's own name of their
 * server (`mcp_<server>_<tool>`), which no other server can take; Antigravity's auto mode asks the
 * person about what its classifier won't run. A change under `.agents`, where Antigravity reads a
 * workspace's hooks, MCP servers and plugins from, always shows its card.
 */
export const autoAnswer = (
  mode: PermissionMode,
  gate: OutwardGate | undefined,
  call: Json,
  roots: ReadonlyArray<string>,
  appToolsServer: string,
): "allow" | "deny" | undefined =>
  answerItself(mode, gate, call, roots, {
    appTool: text(call["name"])?.startsWith(`mcp_${appToolsServer}_`) === true,
    command: commandLineOf(call),
    editKeys: EDIT_KEYS,
    autoAsks: true,
    guarded: [CUSTOMIZATIONS_FOLDER],
  });

/**
 * Antigravity's tools as Gram's cards know them: Claude Code's names and input keys. Gram's own app
 * tools, which Antigravity names `mcp_<server>_<tool>`, take the name every agent's cards give them.
 * A tool it doesn't name keeps Antigravity's own name and input.
 */
export const toolFor = (name: string, input: Json, appToolsServer: string): CardTool => {
  const pick = (entries: ReadonlyArray<readonly [string, string]>) =>
    Object.fromEntries(
      entries.flatMap(([from, to]) => (input[from] === undefined ? [] : [[to, input[from]]])),
    );
  const app = `mcp_${appToolsServer}_`;
  if (name.startsWith(app)) {
    const { toolSummary: _summary, ...rest } = input;
    return { name: `mcp__gram__${name.slice(app.length)}`, input: rest };
  }
  switch (name) {
    case "run_command":
      return {
        name: "Bash",
        input: pick([
          ["CommandLine", "command"],
          ["toolSummary", "description"],
        ]),
      };
    case "read_file":
    case "view_file":
      return {
        name: "Read",
        input: pick([
          ["Path", "file_path"],
          ["AbsolutePath", "file_path"],
        ]),
      };
    case "edit_file":
    case "replace_file_content":
      return {
        name: "Edit",
        input: pick([
          ["Path", "file_path"],
          ["TargetFile", "file_path"],
          ["Target", "old_string"],
          ["TargetContent", "old_string"],
          ["Replacement", "new_string"],
          ["ReplacementContent", "new_string"],
        ]),
      };
    case "write_file":
    case "write_to_file":
      return {
        name: "Write",
        input: pick([
          ["Path", "file_path"],
          ["TargetFile", "file_path"],
          ["Content", "content"],
          ["CodeContent", "content"],
        ]),
      };
    case "grep_search":
      return {
        name: "Grep",
        input: pick([
          ["Query", "pattern"],
          ["SearchPath", "path"],
        ]),
      };
    case "find_by_name":
      return {
        name: "Glob",
        input: pick([
          ["Pattern", "pattern"],
          ["SearchDirectory", "path"],
        ]),
      };
    case "list_dir":
      return { name: "LS", input: pick([["DirectoryPath", "path"]]) };
    case "search_web":
      return { name: "WebSearch", input: pick([["query", "query"]]) };
    case "read_url_content":
      return { name: "WebFetch", input: pick([["Url", "url"]]) };
    default:
      return { name, input };
  }
};

/** The longest output kept from a call that gave no text content. */
const OUTPUT_MAX = 20_000;

/** What a finished call said: its text content, else the output its raw output carries. */
export const outputText = (update: Json): string => {
  const parts: Array<string> = [];
  for (const entry of records(update["content"])) {
    if (entry["type"] === "content") {
      const body = text(record(entry["content"])["text"]);
      if (body !== undefined && body !== "") parts.push(body);
    } else if (entry["type"] === "diff") {
      const path = text(entry["path"]);
      if (path !== undefined) parts.push(`Updated ${path}`);
    }
  }
  if (parts.length > 0) return parts.join("\n");
  return (text(record(update["rawOutput"])["output"]) ?? "").slice(0, OUTPUT_MAX);
};

/**
 * A turn's usage as the answer to `session/prompt` reports it. Antigravity counts cached input
 * apart from the rest, and its thinking as `thoughtTokens`.
 */
export const promptUsage = (result: Json): TokenUsage | undefined => {
  const usage = record(result["usage"]);
  if (Object.keys(usage).length === 0) return undefined;
  const cached = count(usage["cachedReadTokens"]);
  const written = count(usage["cachedWriteTokens"]);
  const thought = count(usage["thoughtTokens"]);
  return {
    inputTokens: count(usage["inputTokens"]),
    outputTokens: count(usage["outputTokens"]),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(written > 0 ? { cacheWriteTokens: written } : {}),
    ...(thought > 0 ? { reasoningTokens: thought } : {}),
  };
};
