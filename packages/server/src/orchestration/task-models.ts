import {
  DEFAULT_CHARTER,
  type Autonomy,
  type ModelRef,
  type OrchestratorCharter,
  type Settings,
  recommendedSetupOn,
  RECOMMENDED_ROSTER,
  type ModelSlot,
} from "@gram/contracts";

/**
 * Preserve saved choices; an unset orchestrator is resolved by local discovery at preview/start.
 * With the recommended setup on, a new workspace's orchestrator follows Lead and, with no roster
 * saved, its roster is each tier (`RECOMMENDED_ROSTER`).
 */
export const subscriptionTaskCharter = (
  agents: Settings["agents"],
  autonomy?: Autonomy,
  selected?: ModelRef,
): OrchestratorCharter => {
  const recommended = recommendedSetupOn({ agents });
  const model: ModelSlot | undefined =
    selected ?? (recommended ? { tier: "lead" } : agents.defaultModel);
  const roster =
    recommended && (agents.workerModels ?? []).length === 0
      ? RECOMMENDED_ROSTER
      : agents.workerModels;
  return {
    ...DEFAULT_CHARTER,
    workerMode: "auto",
    ...(autonomy === undefined ? {} : { autonomy }),
    ...(model === undefined ? {} : { orchestratorModel: model }),
    ...(roster === undefined || roster.length === 0 ? {} : { workerModels: roster }),
  };
};
