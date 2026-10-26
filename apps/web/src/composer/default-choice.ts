import { localSubscriptionDefault, type AgentModel, type ModelRef } from "@gram/contracts";

import type { AgentChoice } from "./agent-fields";

/** Preserve an explicit choice; otherwise use local discovery. Empty means no usable default yet. */
export const choiceFromModel = (
  selected: ModelRef | undefined,
  claude?: readonly AgentModel[],
  codex?: readonly AgentModel[],
): AgentChoice => {
  const model = selected ?? localSubscriptionDefault(claude, codex);
  return model === undefined
    ? { agent: "claude", model: "", speed: "standard" }
    : {
        agent: model.agent,
        model: model.model,
        ...(model.profileId === undefined ? {} : { profileId: model.profileId }),
        ...(model.variant === undefined ? {} : { variant: model.variant }),
        ...(model.speed === undefined ? {} : { speed: model.speed }),
      };
};
