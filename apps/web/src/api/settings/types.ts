import type { Palette, PaletteId, Settings, SettingsPatch } from "@gram/contracts";

/** `settings.*` and `palettes.*`: the user's settings and their own colour palettes. */
export interface SettingsApi {
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  listPalettes(): Promise<readonly Palette[]>;
  upsertPalette(palette: Palette): Promise<Palette>;
  removePalette(paletteId: PaletteId): Promise<void>;
}
