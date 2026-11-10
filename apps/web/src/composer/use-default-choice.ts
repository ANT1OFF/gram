import { isTierRef, slotModel, type ModelSlot } from "@gram/contracts";
import { useState } from "react";
import type { AgentChoice } from "./agent-fields";
import { choiceFromModel } from "./default-choice";
import { useModelsSettled } from "./models";

/**
 * Discovery is only for an unset choice. A user selection or captured default stops inference. A
 * saved default that follows a tier waits for both harnesses' lists and is captured as what it
 * resolves to; only one nothing here fills falls back to discovery.
 */
export function useDraftAgentChoice(saved: ModelSlot | undefined) {
  const following = saved !== undefined && isTierRef(saved);
  const [picked, setChoice] = useState<AgentChoice | undefined>(() =>
    saved === undefined || isTierRef(saved) ? undefined : choiceFromModel(saved),
  );
  const resolving = following && picked === undefined;
  const claude = useModelsSettled("claude", resolving);
  const codex = useModelsSettled("codex", resolving);
  const pending = resolving && (!claude.settled || !codex.settled);
  const resolved =
    resolving && !pending
      ? slotModel(saved, { claude: claude.models, codex: codex.models })
      : undefined;
  // Captured once, during render, like discovery below; a choice the user made since stands.
  if (resolved !== undefined) setChoice(choiceFromModel(resolved));
  const local = useLocalDefaultChoice(picked === undefined && !pending && resolved === undefined);
  const choice = picked ?? local.choice;
  // Capture the first settled result during render; later query errors cannot change harness.
  if (
    picked === undefined &&
    !pending &&
    resolved === undefined &&
    !local.discovering &&
    local.choice.model !== ""
  ) {
    setChoice(local.choice);
  }
  return { choice, setChoice, discovering: picked === undefined && (pending || local.discovering) };
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
