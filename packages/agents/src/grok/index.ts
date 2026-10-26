import { AgentUnavailable, type AgentCapabilities } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AgentHost } from "../host.ts";

/** No executable support until the official CLI can enforce all-route subscription auth. */
export const GROK_SUBSCRIPTION_BLOCKER =
  "Grok Build is unavailable in Gram: the official CLI cannot enforce subscription-only inference routing for all configured models and auxiliary requests. Login or a subscription purchase does not resolve this CLI capability limitation. No CLI was started.";
export const GROK_CAPABILITIES: AgentCapabilities = {
  fork: false,
  rewind: "none",
  steer: false,
  planMode: false,
  approvalScopes: [],
  userQuestions: false,
  costReporting: false,
  perTurnModel: false,
  reasoningEffort: false,
  listSessions: false,
  subagentStreams: false,
  stopTasks: false,
};
export class GrokHost extends Context.Service<GrokHost, AgentHost>()("@gram/agents/GrokHost") {}
export interface GrokHostConfig {
  readonly home: string;
  readonly authPath?: string;
}

/** No executable, environment, model name or cached login can override this closed boundary. */
export const makeGrokHost = (_config: GrokHostConfig): AgentHost => ({
  kind: "grok",
  capabilities: GROK_CAPABILITIES,
  listModels: () =>
    Effect.fail(new AgentUnavailable({ agent: "grok", message: GROK_SUBSCRIPTION_BLOCKER })),
  open: () =>
    Effect.fail(new AgentUnavailable({ agent: "grok", message: GROK_SUBSCRIPTION_BLOCKER })),
});
export const GrokHostLive = (config: GrokHostConfig) =>
  Layer.succeed(GrokHost, makeGrokHost(config));
