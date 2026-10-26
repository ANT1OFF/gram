import {
  applySettingsPatch,
  overviewHiddenOf,
  overviewSectionsValue,
  overviewSidebarOf,
} from "@gram/contracts";
import { useEffect } from "react";

import { useApi } from "@/api/context";
import { useKeybindingsSync } from "@/keyboard/use-keybindings-sync";
import { useLayoutStore } from "@/stores/layout";
import { themeStore } from "@/theme/store";

import { createSettingsSync } from "./engine";
import { useServerSettings } from "./store";
import { useGridSync } from "./use-grid-sync";

let active: ReturnType<typeof createSettingsSync> | undefined;

/** Re-reads the server's settings and palettes into this window; a no-op before the sync mounts. */
export const pullServerSettings = (): Promise<void> => active?.pull() ?? Promise.resolve();

/** Mount once in the root layout: syncs appearance, grouping, custom palettes and the pane grid. */
export function useSettingsSync() {
  const api = useApi();

  useEffect(() => {
    const sync = createSettingsSync({
      api,
      theme: themeStore,
      layout: useLayoutStore,
      onLoaded: (settings) => useServerSettings.setState({ settings }),
    });
    active = sync;
    void sync.start();
    return () => {
      if (active === sync) active = undefined;
      sync.dispose();
    };
  }, [api]);

  // The overview's mode is pushed from the layout store, like the layout itself; the copy of the
  // settings Settings reads (its rows, Restore defaults) follows it at once.
  useEffect(
    () =>
      useLayoutStore.subscribe((state, before) => {
        if (state.overviewSidebar === before.overviewSidebar) return;
        const settings = useServerSettings.getState().settings;
        if (settings === undefined || overviewSidebarOf(settings) === state.overviewSidebar) return;
        useServerSettings.setState({
          settings: applySettingsPatch(settings, {
            layout: { overviewSidebar: state.overviewSidebar ?? null },
          }),
        });
      }),
    [],
  );
  // The sections Settings turns off, the same way.
  useEffect(
    () =>
      useLayoutStore.subscribe((state, before) => {
        if (state.overviewHidden === before.overviewHidden) return;
        const settings = useServerSettings.getState().settings;
        if (settings === undefined) return;
        const stored = overviewHiddenOf(settings);
        if (stored.join() === state.overviewHidden.join()) return;
        useServerSettings.setState({
          settings: applySettingsPatch(settings, {
            layout: { overviewSections: overviewSectionsValue(state.overviewHidden) },
          }),
        });
      }),
    [],
  );

  useGridSync();
  useKeybindingsSync();
}
