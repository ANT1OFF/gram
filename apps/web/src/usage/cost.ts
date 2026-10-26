import type { ModelRef } from "@gram/contracts";

import { useServerSettings } from "@/settings-sync/store";

/**
 * Whether a thread's dollar cost shows: only on a gateway profile, which bills its own API key, and
 * only with Show dollar cost on. A subscription's use is its limits, which the usage meter shows.
 */
export const costShown = (
  showCost: boolean,
  model: Pick<ModelRef, "profileId"> | undefined,
): boolean => showCost && model?.profileId !== undefined;

/** Settings → Appearance → Show dollar cost; off until set. */
export const useShowCost = (): boolean =>
  useServerSettings((s) => s.settings?.appearance.showCost === true);

/** `costShown` for `model` under the current setting. */
export const useCostShown = (model: Pick<ModelRef, "profileId"> | undefined): boolean =>
  costShown(useShowCost(), model);
