import { createMockSettings } from "../mock-settings";
import type { SettingsApi } from "./types";

/**
 * Settings and palettes kept in the page's storage. The core builds it, because so much of what it
 * serves reads the settings; `api` is what joins the `Api`.
 */
export function createSettingsMock() {
  const store = createMockSettings();
  const api: SettingsApi = {
    getSettings: () => store.get(),
    updateSettings: (patch) => store.update(patch),
    listPalettes: () => store.listPalettes(),
    upsertPalette: (palette) => store.upsertPalette(palette),
    removePalette: (paletteId) => store.removePalette(paletteId),
  };
  return { api, get: store.get, setCodexRuntime: store.setCodexRuntime };
}
