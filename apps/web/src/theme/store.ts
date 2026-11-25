import { fieldsOf } from "@gram/contracts";
import type { Palette } from "@gram/themes";
import { createStore, useStore } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { DEFAULT_THEME, sanitizePalettes, sanitizePrefs, type ThemePrefs } from "./theme";

export interface ThemeState extends ThemePrefs {
  /** User palettes, rendered alongside the presets. */
  customPalettes: Palette[];
  setTheme: (patch: Partial<ThemePrefs>) => void;
  setCustomPalettes: (palettes: Palette[]) => void;
}

export type ThemeStore = ReturnType<typeof createThemeStore>;

export const THEME_STORAGE_KEY = "gram.theme";

export function createThemeStore(storage?: StateStorage) {
  return createStore<ThemeState>()(
    persist(
      (set) => ({
        ...DEFAULT_THEME,
        customPalettes: [],
        setTheme: (patch) => set(sanitizePrefs(patch)),
        setCustomPalettes: (palettes) => set({ customPalettes: palettes }),
      }),
      {
        name: THEME_STORAGE_KEY,
        version: 1,
        storage: createJSONStorage(() => storage ?? window.localStorage),
        partialize: (state) => ({
          look: state.look,
          palette: state.palette,
          mode: state.mode,
          density: state.density,
          contrast: state.contrast,
          motion: state.motion,
          accent: state.accent,
          backdrop: state.backdrop,
          surfaces: state.surfaces,
          sidebar: state.sidebar,
          sidebarIcons: state.sidebarIcons,
          customPalettes: state.customPalettes,
        }),
        merge: (persisted, current) => {
          return {
            ...current,
            ...sanitizePrefs(persisted),
            customPalettes: sanitizePalettes(fieldsOf(persisted).get("customPalettes")),
          };
        },
      },
    ),
  );
}

export const themeStore = createThemeStore();

export function useThemeStore<T>(selector: (state: ThemeState) => T): T {
  return useStore(themeStore, selector);
}
