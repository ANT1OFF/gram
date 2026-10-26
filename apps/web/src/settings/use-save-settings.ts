import type { Settings, SettingsPatch } from "@gram/contracts";
import { useCallback } from "react";

import { useApi } from "@/api/context";
import { useServerSettings } from "@/settings-sync/store";

/**
 * The save in flight, which the next one waits for. A field that saves on blur and the reset beside
 * it both save in one click; sent together, the older could land last and undo the reset.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Saves a settings patch and publishes the stored result to `useServerSettings`. Saves go one at a
 * time, in the order they were asked for, so the last one asked for is what stays.
 */
export function useSaveSettings(): (patch: SettingsPatch) => Promise<Settings> {
  const api = useApi();
  return useCallback(
    (patch) => {
      const next = queue.then(async () => {
        const settings = await api.updateSettings(patch);
        useServerSettings.setState({ settings });
        return settings;
      });
      // A failed save is its caller's to report; the next one still goes.
      queue = next.catch(() => undefined);
      return next;
    },
    [api],
  );
}
