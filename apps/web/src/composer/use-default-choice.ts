import type { ModelRef } from "@gram/contracts";
import { useState } from "react";
import type { AgentChoice } from "./agent-fields";
import { choiceFromModel } from "./default-choice";
import { useModelsSettled } from "./models";

/** Discovery is only for an unset choice. A user selection or captured default stops inference. */
export function useDraftAgentChoice(saved: ModelRef | undefined) {
  const [picked, setChoice] = useState<AgentChoice | undefined>(() =>
    saved === undefined ? undefined : choiceFromModel(saved),
  );
  const local = useLocalDefaultChoice(picked === undefined);
  const choice = picked ?? local.choice;
  // Capture the first settled result during render; later query errors cannot change harness.
  if (picked === undefined && !local.discovering && local.choice.model !== "") {
    setChoice(local.choice);
  }
  return { choice, setChoice, discovering: picked === undefined && local.discovering };
}

/** Settings can display this inferred choice without persisting a default or granting consent. */
export function useLocalDefaultChoice(enabled: boolean) {
  const claude = useModelsSettled("claude", enabled);
  const codex = useModelsSettled("codex", enabled);
  const discovering = enabled && (!claude.settled || !codex.settled);
  return {
    choice: choiceFromModel(
      undefined,
      discovering ? undefined : claude.models,
      discovering ? undefined : codex.models,
    ),
    discovering,
  };
}
