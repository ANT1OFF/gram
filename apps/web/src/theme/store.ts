import { paletteFromSeeds, type Palette } from "@gram/themes";
import { createStore, useStore } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { DEFAULT_THEME, sanitizePrefs, type ThemePrefs } from "./theme";

export interface ThemeState extends ThemePrefs {
  /** User palettes, rendered alongside the presets. */
  customPalettes: Palette[];
  setTheme: (patch: Partial<ThemePrefs>) => void;
  setCustomPalettes: (palettes: Palette[]) => void;
}

export type ThemeStore = ReturnType<typeof createThemeStore>;

export const THEME_STORAGE_KEY = "gram.theme";

function sanitizePalettes(input: unknown): Palette[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item: unknown) => {
    try {
      const p = item as Palette;
      return [paletteFromSeeds(p.seeds, { id: p.id, name: p.name })];
    } catch {
      return [];
    }
  });
}

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
        partialize: ({ look, palette, mode, density, contrast, motion, customPalettes }) => ({
          look,
          palette,
          mode,
          density,
          contrast,
          motion,
          customPalettes,
        }),
        merge: (persisted, current) => {
          const raw = (persisted ?? {}) as Record<string, unknown>;
          return {
            ...current,
            ...sanitizePrefs(raw),
            customPalettes: sanitizePalettes(raw["customPalettes"]),
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
