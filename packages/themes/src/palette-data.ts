import { derivePalette, type Mode, type Palette, type SemanticColors } from "./palette.ts";
import { DEFAULT_PALETTE_ID, PRESET_PALETTES } from "./presets.ts";

/** One mode of the default pair: the preset's id and every semantic colour it derives. */
export interface PaletteDataMode {
  id: string;
  colors: SemanticColors;
}

/**
 * Gram's default palette pair as plain data, the shape of `packages/themes/palette.json`. An app
 * that wants Gram's colours reads that file and runs none of this package's code.
 */
export interface PaletteData {
  defaultPaletteId: string;
  light: PaletteDataMode;
  dark: PaletteDataMode;
}

/** The command that writes `palette.json` from these sources. */
export const PALETTE_DATA_COMMAND = "bun run --filter @gram/themes palette:data";

/** The default palette and its pair, derived at standard contrast. */
export function defaultPaletteData(): PaletteData {
  const presets: readonly Palette[] = PRESET_PALETTES;
  const chosen = presets.find((palette) => palette.id === DEFAULT_PALETTE_ID);
  const pair = presets.find((palette) => palette.id === chosen?.pairId);
  if (!chosen || !pair || pair.mode === chosen.mode) {
    throw new Error(`${DEFAULT_PALETTE_ID} needs a pair in the other mode.`);
  }
  const byMode = (mode: Mode): PaletteDataMode => {
    const palette = chosen.mode === mode ? chosen : pair;
    return { id: palette.id, colors: derivePalette(palette).colors };
  };
  return { defaultPaletteId: DEFAULT_PALETTE_ID, light: byMode("light"), dark: byMode("dark") };
}

/** `palette.json`'s exact text. */
export function paletteDataJson(): string {
  return `${JSON.stringify(defaultPaletteData(), null, 2)}\n`;
}
