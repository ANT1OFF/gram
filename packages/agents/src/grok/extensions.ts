// Grok Build's ACP extensions and payloads read as Gram's: its models, billing, permissions,
// prompts, slash commands, MCP servers and replayed transcripts. Pure, apart from reading images.

import type {
  AgentModel,
  PermissionMode,
  ReasoningVariant,
  SessionTranscriptMessage,
  SlashCommand,
  SubscriptionLimitReport,
  UserInput,
} from "@gram/contracts";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { APP_TOOLS_SERVER_NAME } from "../app-tools.ts";
import { BUILT_IN_TOGGLE_REASON, type ConnectorStatus, type OutwardGate } from "../host.ts";
import { gateAsks, outwardKind } from "../outward.ts";
import { canonicalSessionHome } from "../session-home.ts";
import { grokToolName, toolFor } from "./mapper.ts";

/** A JSON object as ACP carries it. */
export type Json = Readonly<Record<string, unknown>>;

/** `value` as an object, or an empty one. */
export const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};

/** `value` when it is a string. */
export const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const EFFORTS: ReadonlySet<string> = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

/** The models an `initialize` or `session/new` lists, as the pickers show them. */
export const grokModels = (state: Json): ReadonlyArray<AgentModel> =>
  (Array.isArray(state["availableModels"]) ? state["availableModels"] : [])
    .map(record)
    .flatMap((model): Array<AgentModel> => {
      const id = text(model["modelId"]);
      if (id === undefined) return [];
      const meta = record(model["_meta"]);
      const efforts = (Array.isArray(meta["reasoningEfforts"]) ? meta["reasoningEfforts"] : [])
        .map((effort) => text(record(effort)["value"]))
        .filter(
          (effort): effort is ReasoningVariant => effort !== undefined && EFFORTS.has(effort),
        );
      const description = text(model["description"]);
      return [
        {
          id,
          displayName: text(model["name"]) ?? id,
          ...(description === undefined ? {} : { description }),
          supportsEffort: meta["supportsReasoningEffort"] === true && efforts.length > 0,
          ...(efforts.length > 0 ? { efforts } : {}),
        },
      ];
    });

/**
 * The plan's credits as `x.ai/billing` reports them, as Gram's subscription windows: a weekly
 * period is the `seven_day` window. A monthly one has no window of Gram's, so it gives nothing.
 * Prepaid credits keep turns going past a used-up allowance.
 */
export const billingLimits = (response: Json): ReadonlyArray<SubscriptionLimitReport> => {
  const config = record(response["config"]);
  const percent = config["creditUsagePercent"];
  const period = record(config["currentPeriod"]);
  if (typeof percent !== "number" || !Number.isFinite(percent)) return [];
  if (text(period["type"]) !== "USAGE_PERIOD_TYPE_WEEKLY") return [];
  const utilization = Math.min(1, Math.max(0, percent / 100));
  const resetsAt = Date.parse(text(period["end"]) ?? "");
  const prepaid = record(config["prepaidBalance"])["val"];
  const credits = typeof prepaid === "number" && prepaid > 0;
  return [
    {
      window: "seven_day",
      utilization,
      status: utilization >= 1 ? "rejected" : "allowed",
      ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
      ...(credits ? { credits: true, creditsAvailable: true } : {}),
    },
  ];
};

/** The context window `state` gives for `model`. */
export const contextWindowOf = (state: Json, model: string | undefined): number | undefined => {
  const entry = (Array.isArray(state["availableModels"]) ? state["availableModels"] : [])
    .map(record)
    .find((each) => text(each["modelId"]) === model);
  const tokens = record(entry?.["_meta"])["totalContextTokens"];
  return typeof tokens === "number" && Number.isInteger(tokens) && tokens > 0 ? tokens : undefined;
};

/**
 * How Grok Build should hold permissions for a Gram mode. `ask` sends every call its own policy
 * doesn't clear to Gram, which answers some itself (`autoAnswer`). Bypass and auto run on Grok's
 * own always-approve and classifier, but not under an outward gate: Gram has to see each command
 * then, so the session asks and Gram lets through what the gate doesn't stop.
 */
export const grokPermission = (
  mode: PermissionMode,
  gate: OutwardGate | undefined,
): "ask" | "auto" | "always-approve" => {
  if (gate !== undefined) return "ask";
  if (mode === "bypassPermissions") return "always-approve";
  if (mode === "auto") return "auto";
  return "ask";
};

/** The `x.ai/yolo_mode_changed` params that put a session in `permission`. */
export const permissionParams = (permission: "ask" | "auto" | "always-approve"): Json => ({
  yolo_mode: permission === "always-approve",
  auto_mode: permission === "auto",
  permission_mode: permission,
});

const EDIT_PATH_KEYS = ["file_path", "target_file", "path", "notebook_path", "target_directory"];

/**
 * Whether every path an edit request names (its `locations` and its input's path keys) is, once
 * links are followed, inside one of `roots`, the first of which relative paths are read from. A
 * request naming no path is not.
 */
export const editWithin = (call: Json, roots: ReadonlyArray<string>): boolean => {
  const [cwd] = roots;
  if (cwd === undefined) return false;
  const input = record(call["rawInput"]);
  const named = [
    ...(Array.isArray(call["locations"]) ? call["locations"] : []).map((at) => record(at)["path"]),
    ...EDIT_PATH_KEYS.map((key) => input[key]),
  ].filter((path) => path !== undefined);
  if (named.length === 0) return false;
  const inside = roots.map((root) => canonicalSessionHome(resolve(root)));
  return named.every((path) => {
    if (typeof path !== "string" || path === "") return false;
    const real = canonicalSessionHome(resolve(cwd, path));
    return inside.some((root) => {
      const rest = relative(root, real);
      return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
    });
  });
};

/**
 * The answer Gram gives a permission request itself, without a card: Gram's own app tools go
 * through, as their registry raises its own card where one is needed; `dontAsk` refuses, edits
 * inside the thread's folders (`roots`, `editWithin`) go through in `acceptEdits`, and a mode that
 * would have run the call unasked lets it through when the outward gate doesn't ask about it.
 * `undefined` shows the card.
 */
export const autoAnswer = (
  mode: PermissionMode,
  gate: OutwardGate | undefined,
  call: Json,
  roots: ReadonlyArray<string>,
): "allow" | "deny" | undefined => {
  const tool = text(record(call["rawInput"])["tool_name"]);
  if (tool?.startsWith(`${APP_TOOLS_SERVER_NAME}__`) === true) return "allow";
  if (mode === "dontAsk") return "deny";
  const kind = text(call["kind"]);
  if (mode === "acceptEdits" && kind === "edit" && editWithin(call, roots)) return "allow";
  if (mode !== "bypassPermissions" && mode !== "auto") return undefined;
  if (gate === undefined) return "allow";
  if (kind !== "execute") return "allow";
  const command = text(record(call["rawInput"])["command"]);
  if (command === undefined) return undefined;
  return gateAsks(gate, outwardKind(command)) ? undefined : "allow";
};

/** The largest image sent inline; a bigger one goes as a link to its file. */
const IMAGE_INLINE_MAX = 10 * 1024 * 1024;

/**
 * A message as ACP content: its text, each image inline (Grok Build reads images), and every other
 * attachment as a link to its file, which Grok reads with its own tools.
 */
export const promptOf = async (
  input: UserInput,
  read: (path: string) => Promise<Uint8Array> = readFile,
): Promise<ReadonlyArray<Json>> => {
  const blocks: Array<Json> = [{ type: "text", text: input.text }];
  for (const attachment of input.attachments ?? []) {
    const name = attachment.name ?? attachment.path.split(/[\\/]/).at(-1) ?? attachment.path;
    if (attachment.mediaType?.startsWith("image/") === true) {
      const bytes = await read(attachment.path).catch(() => undefined);
      if (bytes !== undefined && bytes.byteLength <= IMAGE_INLINE_MAX) {
        blocks.push({
          type: "image",
          mimeType: attachment.mediaType,
          data: Buffer.from(bytes).toString("base64"),
        });
        continue;
      }
    }
    blocks.push({
      type: "resource_link",
      uri: pathToFileURL(attachment.path).href,
      name,
      ...(attachment.mediaType === undefined ? {} : { mimeType: attachment.mediaType }),
    });
  }
  return blocks;
};

/** Grok Build's `available_commands_update` as Gram's slash commands. */
export const grokCommands = (update: Json): ReadonlyArray<SlashCommand> =>
  (Array.isArray(update["availableCommands"]) ? update["availableCommands"] : [])
    .map(record)
    .flatMap((command): Array<SlashCommand> => {
      const name = text(command["name"]);
      if (name === undefined || name === "") return [];
      const hint = text(record(command["input"])["hint"]);
      return [
        {
          name,
          description: text(command["description"]) ?? "",
          ...(hint === undefined ? {} : { argumentHint: hint }),
        },
      ];
    });

/** A server's state in `x.ai/mcp/list` as Gram's connector status. */
export const connectorOf = (entry: Json): ConnectorStatus | undefined => {
  const name = text(entry["name"]);
  if (name === undefined) return undefined;
  const session = record(entry["session"]);
  const builtIn = name === APP_TOOLS_SERVER_NAME;
  const status: ConnectorStatus["status"] =
    session["enabled"] === false
      ? "disabled"
      : session["authRequired"] === true || session["status"] === "setupRequired"
        ? "needs-auth"
        : session["status"] === "ready"
          ? "connected"
          : session["status"] === "unavailable"
            ? "failed"
            : "pending";
  const tools = (Array.isArray(session["tools"]) ? session["tools"] : [])
    .map(record)
    .flatMap((tool) => {
      const toolName = text(tool["name"]);
      return toolName === undefined ? [] : [{ name: toolName }];
    });
  const blocked = text(session["blockedReason"]);
  const source = text(entry["source"]);
  return {
    name,
    status,
    ...(blocked === undefined ? {} : { error: blocked }),
    ...(source === undefined ? {} : { source }),
    ...(tools.length > 0 ? { tools } : {}),
    ...(builtIn ? { builtIn: true, toggleUnavailable: BUILT_IN_TOGGLE_REASON } : {}),
  };
};

/**
 * A past session's main conversation from the updates `session/load` replays: each user message,
 * and each reply with the calls it made, in order.
 */
export const transcriptOf = (updates: ReadonlyArray<Json>): Array<SessionTranscriptMessage> => {
  const messages: Array<SessionTranscriptMessage> = [];
  let last:
    | { role: "user" | "assistant"; text: string; tools: Array<{ name: string }>; at?: number }
    | undefined;
  const flush = () => {
    if (last === undefined) return;
    if (last.text.trim() !== "" || last.tools.length > 0)
      messages.push({
        role: last.role,
        text: last.text.trim(),
        ...(last.tools.length > 0 ? { tools: last.tools } : {}),
        ...(last.at === undefined ? {} : { at: last.at }),
      });
    last = undefined;
  };
  for (const params of updates) {
    const update = record(params["update"]);
    const kind = update["sessionUpdate"];
    const stamp = record(params["_meta"])["agentTimestampMs"];
    const at = typeof stamp === "number" ? stamp : undefined;
    const role =
      kind === "user_message_chunk"
        ? "user"
        : kind === "agent_message_chunk" || kind === "tool_call"
          ? "assistant"
          : undefined;
    if (role === undefined) continue;
    if (last?.role !== role) {
      flush();
      last = { role, text: "", tools: [], ...(at === undefined ? {} : { at }) };
    }
    if (kind === "tool_call") last.tools.push({ name: toolFor(grokToolName(update), {}).name });
    else last.text += text(record(update["content"])["text"]) ?? "";
  }
  flush();
  return messages;
};
