import type { AgentKind } from "./agent-kind.ts";
import type { GatewayKind, GatewayModel, GatewayProfile } from "./domain.ts";

/** OpenRouter's OpenAI-style root: Codex appends `/responses`, Claude Code drops `/v1`. */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** xAI's OpenAI-style root: Codex appends `/responses`, OpenCode `/chat/completions`. */
export const XAI_BASE_URL = "https://api.x.ai/v1";

/**
 * Whether `agent` is offered `model` on `profile`: always on a LiteLLM-style gateway. On
 * OpenRouter, Claude Code gets Anthropic's models and Codex OpenAI's, the ones each runs well, and
 * OpenCode every other maker's: never Anthropic's, which stay with Claude Code. On xAI, Codex and
 * OpenCode get every model and Claude Code none, as xAI no longer serves the Anthropic API. Grok
 * Build and Antigravity run on their own sign-in, never on a gateway.
 */
export const gatewayModelForAgent = (
  profile: Pick<GatewayProfile, "kind">,
  model: Pick<GatewayModel, "id">,
  agent: AgentKind,
): boolean => {
  if (agent === "grok" || agent === "antigravity") return false;
  if (profile.kind === "xai") return agent !== "claude";
  if (profile.kind !== "openrouter") return true;
  switch (agent) {
    case "claude":
      return model.id.startsWith("anthropic/");
    case "codex":
      return model.id.startsWith("openai/");
    case "opencode":
      return !model.id.startsWith("anthropic/") && !model.id.startsWith("~anthropic/");
  }
  return false;
};

const normalURL = (url: string): string => {
  const text = url.trim().toLowerCase();
  let end = text.length;
  while (end > 0 && text[end - 1] === "/") end--;
  return text.slice(0, end);
};

/** Whether two gateway addresses name the same endpoint, whatever their case or trailing slash. */
export const sameGatewayURL = (a: string, b: string): boolean => normalURL(a) === normalURL(b);

/**
 * The kind a gateway's own address implies, so a profile added by hand on OpenRouter's or xAI's API
 * follows its conventions too; `undefined` for any other address.
 */
export const gatewayKindOf = (baseURL: string): GatewayKind | undefined => {
  if (sameGatewayURL(baseURL, OPENROUTER_BASE_URL)) return "openrouter";
  const url = normalURL(baseURL);
  return url === normalURL(XAI_BASE_URL) || url === "https://api.x.ai" ? "xai" : undefined;
};
