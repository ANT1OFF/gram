import { useEffect } from "react";

import { useFeature } from "@/settings/use-diagnostics";
import { useSaveSettings } from "@/settings/use-save-settings";
import { useServerSettings } from "@/settings-sync/store";

import { decideUpdateNotice, startUpdateWatch } from "./launch-check";
import { followNativeUpdates } from "./native";
import { useUpdateStore } from "./store";

/**
 * Mount once in the root layout. Once settings have loaded, and when the desktop shell allows it
 * (not in smoke runs, CI or development), checks the persisted channel at launch and periodically,
 * publishes the result to `useUpdateStore` and drops a pin the running version has moved past.
 */
export function useUpdateCheckOnLaunch() {
  const shown = useFeature("appUpdates", { settled: true });
  const loaded = useServerSettings((s) => s.settings !== undefined) && shown;
  const automaticChecks = useServerSettings((s) => s.settings?.updates.automaticChecks === true);
  const save = useSaveSettings();

  // A signed install's updater runs in main; this window follows its state.
  useEffect(() => (shown ? followNativeUpdates() : undefined), [shown]);

  useEffect(() => {
    const bridge = window.gram;
    if (!bridge || !loaded || !automaticChecks) return;
    let cancelled = false;
    let stop: (() => void) | undefined;

    bridge.updates.autoCheck().then(
      (enabled) => {
        if (!enabled || cancelled) return;
        stop = startUpdateWatch({
          check: () => {
            const current = useServerSettings.getState().settings?.updates.channel ?? "stable";
            return bridge.updates.check(current);
          },
          onResult: (check) => {
            useUpdateStore.setState({ latest: check });
            const pinned = useServerSettings.getState().settings?.updates.pinnedVersion;
            if (!decideUpdateNotice(check, pinned).clearPin) return;
            save({ updates: { pinnedVersion: null } }).catch((error: unknown) =>
              console.error("updates: clear the stale pin", error),
            );
          },
        });
      },
      (error: unknown) => console.error("updates: read the auto-check policy", error),
    );

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [loaded, automaticChecks, save]);
}
