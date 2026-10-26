import {
  ReasoningVariant,
  gatewayModelUsable,
  type AgentKind,
  type GatewayModel,
} from "./domain.ts";
import type { AgentModel } from "./models.ts";
import type { CustomModel } from "./settings.ts";

/**
 * `listed` followed by the user's own models. One whose id the agent already lists is dropped, so
 * the agent's entry, which knows the model's real efforts, is the one the picker shows.
 */
export const withCustomModels = (
  listed: ReadonlyArray<AgentModel>,
  custom: ReadonlyArray<CustomModel>,
): ReadonlyArray<AgentModel> => {
  const seen = new Set(listed.map((model) => model.id));
  const added: AgentModel[] = [];
  for (const model of custom) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    added.push({
      id: model.id,
      displayName: model.name?.trim() || model.id,
      description: "Added in Settings",
      supportsEffort: model.effort !== false,
    });
  }
  return added.length === 0 ? listed : [...listed, ...added];
};

/** The API an agent reaches a gateway model through, which decides the efforts it can send. */
export type GatewaySurface = "responses" | "chat" | "messages";

/** Codex speaks `/responses` and Claude Code `/v1/messages`; anything else, chat completions. */
export const gatewaySurface = (agent: AgentKind): GatewaySurface =>
  agent === "codex" ? "responses" : agent === "claude" ? "messages" : "chat";

/**
 * The efforts offered for a gateway model its gateway describes no efforts for: each one a gateway
 * at worst ignores. `none` is left out because Azure answers it with a 400 on `/responses` for
 * `gpt-6.1-sol` and `gpt-6-astra`, and `max` because chat completions refuses it.
 */
export const UNLISTED_GATEWAY_EFFORTS: ReadonlyArray<ReasoningVariant> = [
  "low",
  "medium",
  "high",
  "xhigh",
];

/**
 * The efforts a gateway model takes through `surface`, `[]` when it has no effort setting, and
 * `undefined` when nothing says. The gateway's capability flags decide when it has them: `low` to
 * `high` always, `xhigh` and `max` only when declared, `max` never on chat completions (Azure
 * refuses it there), and `none` only on chat completions and never where declared unsupported.
 * Codex's own catalog lists no `none`, and Claude Code has no such effort. Without flags, the
 * efforts the user's OpenCode config lists apply.
 */
export const gatewayEfforts = (
  model: GatewayModel,
  surface: GatewaySurface,
): ReadonlyArray<ReasoningVariant> | undefined => {
  const info = model.info;
  const offered = (variant: ReasoningVariant): boolean => {
    if (variant === "max" && surface === "chat") return false;
    if (variant === "none" && info?.noneEffort === false) return false;
    return true;
  };
  let efforts: ReadonlyArray<ReasoningVariant>;
  if (info?.reasoning === false) return [];
  if (info?.reasoning === true) {
    efforts = ReasoningVariant.literals.filter((variant) => {
      switch (variant) {
        case "none":
          return surface === "chat";
        case "xhigh":
          return info.xhighEffort === true;
        case "max":
          return info.maxEffort === true;
        default:
          return true;
      }
    });
  } else if (model.variants !== undefined && model.variants.length > 0) {
    efforts = model.variants;
  } else {
    return undefined;
  }
  const kept = efforts.filter(offered);
  return kept.some((variant) => variant !== "none") ? kept : [];
};

/**
 * A gateway model as the model picker lists it for `agent`: the efforts `gatewayEfforts` gives, none
 * when it has no effort setting, and {@link UNLISTED_GATEWAY_EFFORTS}, marked `effortsUnlisted`,
 * when nothing says. A gateway's `/models` gives ids alone, so a model the gateway's catalog and the
 * user's OpenCode config both miss would otherwise have no effort to pick.
 */
export const gatewayAgentModel = (model: GatewayModel, agent: AgentKind): AgentModel => {
  const efforts = gatewayEfforts(model, gatewaySurface(agent));
  return {
    id: model.id,
    displayName: model.name,
    ...(efforts === undefined
      ? { supportsEffort: true, efforts: UNLISTED_GATEWAY_EFFORTS, effortsUnlisted: true }
      : efforts.length > 0
        ? { supportsEffort: true, efforts }
        : { supportsEffort: false }),
  };
};

/** What the pickers say of a model its gateway doesn't list: it may still run, or may not. */
export const GATEWAY_UNLISTED_WARNING = "Not listed by the gateway; it may not work";

/** A profile's models as `agent`'s pickers list them: the usable ones, in the gateway's order. */
export const gatewayAgentModels = (
  models: ReadonlyArray<GatewayModel>,
  agent: AgentKind,
): Array<AgentModel> =>
  models.filter(gatewayModelUsable).map((model) => gatewayAgentModel(model, agent));
