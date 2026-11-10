import {
  defaultSlotOf,
  isPinned,
  isTierRef,
  rosterModelHere,
  slotHere,
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
export function useAvailableModels(
  enabled = true,
): AvailableModels & { readonly settled: boolean } {
  const claude = useModelsQuery("claude", undefined, enabled);
  const codex = useModelsQuery("codex", undefined, enabled);
  return {
    claude: claude.isError ? undefined : claude.data?.models,
    codex: codex.isError ? undefined : codex.data?.models,
    // Both have answered, listing or failing: only then can a tier be called unfilled.
    settled: !claude.isPending && !codex.isPending,
  };
}

/**
 * `slot` as it stands here (`slotHere`): as saved when pinned, resolved when following, or why it
 * can't run here; nothing while unset.
 */
export function useSlotHere(slot: ModelSlot | undefined): ReturnType<typeof slotHere> {
  const following = slot !== undefined && isTierRef(slot);
  const available = useAvailableModels(following);
  return following && !available.settled ? {} : slotHere(slot, available);
}

/** What `slot` runs on here: as saved when pinned, resolved when following; none while unset. */
export function useSlotModel(slot: ModelSlot | undefined): ModelRef | undefined {
  return useSlotHere(slot).model;
}

/**
 * The new-chat default as it stands here (`useSlotHere`): what it runs on, or why it can't, for a
 * slot that inherits it to say so too.
 */
export function useDefaultHere(): ReturnType<typeof slotHere> {
  return useSlotHere(
    useServerSettings((state) =>
      state.settings === undefined ? undefined : defaultSlotOf(state.settings),
    ),
  );
}

/** The new-chat default as it runs here, resolved when it follows a tier. */
export function useDefaultModel(): ModelRef | undefined {
  return useDefaultHere().model;
}

/**
 * A roster as it runs here, in its order: entries that follow a tier resolved, as the server does,
 * each with why it can't run here when nothing here fills its tier.
 */
export function useRosterHere(
  models: readonly WorkerModel[],
): readonly { readonly entry: RosterModel; readonly missing?: string }[] {
  const available = useAvailableModels(models.some((model) => isTierRef(model)));
  return models.map((model) => {
    const here = rosterModelHere(model, available);
    // Until both harnesses answer, a tier isn't called unfilled; its first choice shows meanwhile.
    return isTierRef(model) && !available.settled ? { entry: here.entry } : here;
  });
}

/** Whether two slots are the same choice: the same model and effort, or the same tier pick. */
export const sameSlot = (a: ModelSlot, b: ModelSlot): boolean => {
  if (!isPinned(a) || !isPinned(b)) {
    return (
      !isPinned(a) &&
      !isPinned(b) &&
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
