import type { Settings, SettingsPatch } from "@gram/contracts";
import { useCallback } from "react";

import { useApi } from "@/api/context";
import { useServerSettings } from "@/settings-sync/store";

import { claimTouchedRow, markSaved } from "./saved-mark";

let queue: Promise<unknown> = Promise.resolve();

/**
 * Saves a settings patch and publishes the stored result to `useServerSettings`. Saves go one at a
 * time, in the order they were asked for, so the last one asked for is what stays. Once stored, the
 * setting the change came from says "Saved" beside itself.
 */
export function useSaveSettings(): (patch: SettingsPatch) => Promise<Settings> {
  const api = useApi();
  return useCallback(
    (patch) => {
      const row = claimTouchedRow();
      const next = queue.then(async () => {
        const settings = await api.updateSettings(patch);
        useServerSettings.setState({ settings });
        markSaved(row);
        return settings;
      });
      queue = next.catch(() => undefined);
      return next;
    },
    [api],
  );
}
