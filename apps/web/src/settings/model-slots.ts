import {
  isTierRef,
  rosterModelHere,
  slotModel,
  type AvailableModels,
  type ModelRef,
  type ModelSlot,
  type RosterModel,
  type WorkerModel,
} from "@gram/contracts";

import { useModelsQuery } from "@/composer/models";
import { useServerSettings } from "@/settings-sync/store";

// Model slots in the app: a pinned slot is the model the user saved, one that follows a tier is
// resolved here against what this machine's harnesses list, as the server resolves it at use.

/**
 * What this machine's harnesses list on their own logins, for slots that follow a tier. Lists
 * only while `enabled`, so a pinned choice never probes a harness it doesn't name.
 */
export function useAvailableModels(enabled = true): AvailableModels {
  const claude = useModelsQuery("claude", undefined, enabled);
  const codex = useModelsQuery("codex", undefined, enabled);
  return {
    claude: claude.isError ? undefined : claude.data?.models,
    codex: codex.isError ? undefined : codex.data?.models,
  };
}

/** What `slot` runs on here: as saved when pinned, resolved when following; none while unset. */
export function useSlotModel(slot: ModelSlot | undefined): ModelRef | undefined {
  const following = slot !== undefined && isTierRef(slot);
  const available = useAvailableModels(following);
  return slot === undefined || !isTierRef(slot) ? slot : slotModel(slot, available);
}

/** The new-chat default as it runs here, resolved when it follows a tier. */
export function useDefaultModel(): ModelRef | undefined {
  return useSlotModel(useServerSettings((state) => state.settings?.agents.defaultModel));
}

/** A roster as it runs here, in its order: entries that follow a tier resolved, as the server does. */
export function useRosterHere(models: readonly WorkerModel[]): readonly RosterModel[] {
  const available = useAvailableModels(models.some((model) => isTierRef(model)));
  return models.map((model) => rosterModelHere(model, available).entry);
}

/** Whether two slots are the same choice: the same model and effort, or the same tier pick. */
export const sameSlot = (a: ModelSlot, b: ModelSlot): boolean => {
  if (isTierRef(a) || isTierRef(b)) {
    return (
      isTierRef(a) &&
      isTierRef(b) &&
      a.tier === b.tier &&
      a.agent === b.agent &&
      a.variant === b.variant
    );
  }
  return (
    a.agent === b.agent &&
    a.model === b.model &&
    a.profileId === b.profileId &&
    a.variant === b.variant &&
    a.speed === b.speed
  );
};
