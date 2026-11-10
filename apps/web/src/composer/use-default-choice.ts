import { isPinned, isTierRef, slotHere, type ModelSlot } from "@gram/contracts";
import { useState } from "react";
import type { AgentChoice } from "./agent-fields";
import { choiceFromModel } from "./default-choice";
import { useModelsSettled } from "./models";

/**
 * Discovery is only for an unset choice. A user selection or captured default stops inference. A
 * saved default that follows a tier waits for both harnesses' lists and is captured as what it
 * resolves to; one nothing here fills (or only a newer Gram knows) falls back to discovery, and
 * `unavailable` says why, for the draft to show beside what stands in.
 */
export function useDraftAgentChoice(saved: ModelSlot | undefined) {
  const following = saved !== undefined && !isPinned(saved);
  const [picked, setChoice] = useState<AgentChoice | undefined>(() =>
    saved === undefined || !isPinned(saved) ? undefined : choiceFromModel(saved),
  );
  const [unavailable, setUnavailable] = useState<string>();
  const resolving = following && picked === undefined;
  const lists = resolving && isTierRef(saved);
  const claude = useModelsSettled("claude", lists);
  const codex = useModelsSettled("codex", lists);
  const pending = lists && (!claude.settled || !codex.settled);
  const here =
    resolving && !pending ? slotHere(saved, { claude: claude.models, codex: codex.models }) : {};
  // Captured once, during render, like discovery below; a choice the user made since stands.
  if (here.model !== undefined) setChoice(choiceFromModel(here.model));
  if (here.missing !== undefined && unavailable === undefined) setUnavailable(here.missing);
  const local = useLocalDefaultChoice(picked === undefined && !pending && here.model === undefined);
  const choice = picked ?? local.choice;
  // Capture the first settled result during render; later query errors cannot change harness.
  if (
    picked === undefined &&
    !pending &&
    here.model === undefined &&
    !local.discovering &&
    local.choice.model !== ""
  ) {
    setChoice(local.choice);
  }
  return {
    choice,
    setChoice,
    discovering: picked === undefined && (pending || local.discovering),
    /** Why the saved default can't run here, when what stands in is discovery's pick. */
    ...(unavailable === undefined ? {} : { unavailable }),
  };
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
