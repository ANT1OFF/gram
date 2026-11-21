import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  type Palette,
  type PaletteId,
  type RuntimeSourceChoice,
  type Settings,
  type SettingsPatch,
} from "@gram/contracts";
import { PRESET_PALETTES } from "@gram/themes";

const BUILTIN_PALETTES: Palette[] = PRESET_PALETTES.map((preset) => ({
  id: preset.id as PaletteId,
  name: preset.name,
  mode: preset.mode,
  ...("pairId" in preset && preset.pairId ? { pairId: preset.pairId as PaletteId } : {}),
  seeds: { ...preset.seeds },
  builtin: true,
}));

const STORAGE_KEY = "gram.mock.settings";

const persistence = (): Storage | undefined =>
  import.meta.env["VITE_API"] === "mock" && typeof sessionStorage !== "undefined"
    ? sessionStorage
    : undefined;

/** In-memory `settings.*` and `palettes.*` for MockApi. */
export function createMockSettings() {
  const storage = persistence();
  const saved = storage?.getItem(STORAGE_KEY);
  let settings: Settings = saved
    ? applySettingsPatch(DEFAULT_SETTINGS, JSON.parse(saved) as SettingsPatch)
    : DEFAULT_SETTINGS;
  const palettes = new Map<string, Palette>(BUILTIN_PALETTES.map((p) => [p.id, p]));

  return {
    get: async () => settings,
    update: async (patch: SettingsPatch) => {
      settings = applySettingsPatch(settings, patch);
      storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
      return settings;
    },
    /** What `agentRuntime.useSource` writes; `settings.set` can't. */
    setCodexRuntime: async (choice: RuntimeSourceChoice) => {
      const { codexRuntime: _previous, ...agents } = settings.agents;
      settings = {
        ...settings,
        agents: choice === "path" ? agents : { ...agents, codexRuntime: choice },
      };
      storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
    },
    listPalettes: async (): Promise<readonly Palette[]> => [...palettes.values()],
    upsertPalette: async (palette: Palette) => {
      if (palettes.get(palette.id)?.builtin)
        throw new Error(`InvalidState: ${palette.id} is builtin`);
      palettes.set(palette.id, palette);
      return palette;
    },
    removePalette: async (paletteId: PaletteId) => {
      const palette = palettes.get(paletteId);
      if (!palette) throw new Error(`NotFound: palette ${paletteId}`);
      if (palette.builtin) throw new Error(`InvalidState: ${paletteId} is builtin`);
      palettes.delete(paletteId);
    },
  };
}
