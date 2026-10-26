import {
  DEFAULT_CHARTER,
  type Autonomy,
  type ModelRef,
  type OrchestratorCharter,
  type Settings,
} from "@gram/contracts";

/** Preserve saved choices; an unset orchestrator is resolved by local discovery at preview/start. */
export const subscriptionTaskCharter = (
  agents: Settings["agents"],
  autonomy?: Autonomy,
  selected?: ModelRef,
): OrchestratorCharter => {
  const model = selected ?? agents.defaultModel;
  const roster = agents.workerModels;
  return {
    ...DEFAULT_CHARTER,
    workerMode: "auto",
    ...(autonomy === undefined ? {} : { autonomy }),
    ...(model === undefined ? {} : { orchestratorModel: model }),
    ...(roster === undefined || roster.length === 0 ? {} : { workerModels: roster }),
  };
};
