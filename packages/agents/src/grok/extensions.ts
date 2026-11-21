// Grok Build's ACP extensions and payloads read as Gram's: its models, billing, permissions,
// slash commands, MCP servers and replayed transcripts. Pure.

import type {
  AgentModel,
  PermissionMode,
  ReasoningVariant,
  SessionTranscriptMessage,
  SlashCommand,
  SubscriptionLimitReport,
} from "@gram/contracts";

import { APP_TOOLS_SERVER_NAME } from "../app-tools.ts";
import { BUILT_IN_TOGGLE_REASON, type ConnectorStatus, type OutwardGate } from "../host.ts";
import { commandsOf, transcriptOf as acpTranscriptOf } from "../acp/content.ts";
import { type Json, record, text } from "../acp/json.ts";
import { answerItself } from "../acp/permissions.ts";
import { grokToolName, toolFor } from "./mapper.ts";

export { promptOf } from "../acp/content.ts";
export { editWithin } from "../acp/permissions.ts";
export { type Json, record, text };

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

/**
 * The answer Gram gives a permission request itself, without a card (`answerItself`): Gram's own
 * app tools are the calls Grok names `gram__…`.
 */
export const autoAnswer = (
  mode: PermissionMode,
  gate: OutwardGate | undefined,
  call: Json,
  roots: ReadonlyArray<string>,
): "allow" | "deny" | undefined =>
  answerItself(mode, gate, call, roots, {
    appTool:
      text(record(call["rawInput"])["tool_name"])?.startsWith(`${APP_TOOLS_SERVER_NAME}__`) ===
      true,
    command: text(record(call["rawInput"])["command"]),
  });

/** Grok Build's `available_commands_update` as Gram's slash commands. */
export const grokCommands = (update: Json): ReadonlyArray<SlashCommand> => commandsOf(update);

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
export const transcriptOf = (updates: ReadonlyArray<Json>): Array<SessionTranscriptMessage> =>
  acpTranscriptOf(updates, (update) => toolFor(grokToolName(update), {}).name);
