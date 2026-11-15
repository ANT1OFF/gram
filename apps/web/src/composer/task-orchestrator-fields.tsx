import { ADMITTED_AGENTS } from "@/orchestration/admitted";

import { AgentFields, type AgentChoice } from "./agent-fields";

/**
 * The orchestrator's agent and model on New task, as a direct task has the worker's: the composer's
 * own chips, held to the agents that may orchestrate. Its own module, so the form's first paint
 * doesn't carry the model pickers.
 */
export default function TaskOrchestratorFields({
  value,
  onChange,
}: {
  value: AgentChoice;
  onChange: (choice: AgentChoice) => void;
}) {
  return <AgentFields ghost value={value} allowed={ADMITTED_AGENTS} onChange={onChange} />;
}
