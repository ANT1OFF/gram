import {
  GRID_SHAPES,
  overviewSectionsValue,
  type Palette as ContractPalette,
  type GridLayout,
  type LayoutSettings,
  type OverviewOptionalSection,
  type OverviewSidebar,
  type PaletteId,
  type PanelTab,
  type Settings,
  type SettingsPatch,
  type ThreadId,
} from "@gram/contracts";
import type { Palette } from "@gram/themes";

import type { GridState } from "@/stores/layout";
import { sanitizePrefs, DEFAULT_THEME, type ThemePrefs } from "@/theme/theme";

export type Appearance = Settings["appearance"];

/** The server stores concrete values where the client can follow the OS: contrast `system` is saved as `standard`. */
export function appearanceFromPrefs(prefs: ThemePrefs): Appearance {
  return {
    look: prefs.look,
    paletteId: prefs.palette as PaletteId,
    mode: prefs.mode,
    density: prefs.density,
    contrast: prefs.contrast === "system" ? "standard" : prefs.contrast,
    motion: prefs.motion,
  };
}

/** The inverse of `appearanceFromPrefs`: a saved `standard` contrast reads as `system` again. */
export function prefsFromAppearance(appearance: Appearance): ThemePrefs {
  return {
    ...DEFAULT_THEME,
    ...sanitizePrefs({ ...appearance, palette: appearance.paletteId }),
  };
}

/** The slice of settings the client edits and keeps in sync. */
export interface SyncedSettings {
  appearance: Appearance;
  sidebarWidth: number;
  panelOpen: boolean;
  panelWidth: number;
  panelTab: PanelTab;
  focusMode: boolean;
  /** `undefined` is automatic. */
  overviewSidebar: OverviewSidebar | undefined;
  /** The overview's optional sections turned off, in the column's order. */
  overviewHidden: readonly OverviewOptionalSection[];
}

const panelPatch = (prev: SyncedSettings, next: SyncedSettings) => {
  const panel = {
    ...(next.panelOpen !== prev.panelOpen ? { open: next.panelOpen } : {}),
    ...(next.panelWidth !== prev.panelWidth ? { width: next.panelWidth } : {}),
    ...(next.panelTab !== prev.panelTab ? { tab: next.panelTab } : {}),
  };
  return Object.keys(panel).length > 0 ? { panel } : {};
};

// Absent on the server means off, so turning focus mode off clears the field.
const focusModePatch = (prev: SyncedSettings, next: SyncedSettings) =>
  next.focusMode !== prev.focusMode ? { layout: { focusMode: next.focusMode ? true : null } } : {};

// Absent on the server means automatic.
const overviewPatch = (prev: SyncedSettings, next: SyncedSettings) =>
  next.overviewSidebar !== prev.overviewSidebar
    ? { layout: { overviewSidebar: next.overviewSidebar ?? null } }
    : {};

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

// Only what differs from the default is stored; with every section at its default, the field is cleared.
const overviewSectionsPatch = (prev: SyncedSettings, next: SyncedSettings) =>
  sameList(next.overviewHidden, prev.overviewHidden)
    ? {}
    : { layout: { overviewSections: overviewSectionsValue(next.overviewHidden) } };

const sidebarPatch = (prev: SyncedSettings, next: SyncedSettings) =>
  next.sidebarWidth !== prev.sidebarWidth ? { sidebar: { width: next.sidebarWidth } } : {};

const mergeLayout = (
  ...patches: readonly { layout?: NonNullable<SettingsPatch["layout"]> }[]
): Pick<SettingsPatch, "layout"> => {
  const layout = Object.assign({}, ...patches.map((patch) => patch.layout ?? {}));
  return Object.keys(layout).length > 0 ? { layout } : {};
};

/** A patch holding only what changed between `prev` and `next`; `undefined` when nothing did. */
export function settingsPatch(
  prev: SyncedSettings,
  next: SyncedSettings,
): SettingsPatch | undefined {
  const appearance: Partial<Appearance> = {};
  for (const key of Object.keys(next.appearance) as (keyof Appearance)[]) {
    if (next.appearance[key] !== prev.appearance[key]) {
      Object.assign(appearance, { [key]: next.appearance[key] });
    }
  }
  const patch: SettingsPatch = {
    ...(Object.keys(appearance).length > 0 ? { appearance } : {}),
    ...sidebarPatch(prev, next),
    ...panelPatch(prev, next),
    ...mergeLayout(
      focusModePatch(prev, next),
      overviewPatch(prev, next),
      overviewSectionsPatch(prev, next),
    ),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

// ---------------------------------------------------------------------------------------------
// Palettes

export const toThemePalette = (palette: ContractPalette): Palette => ({
  id: palette.id,
  name: palette.name,
  mode: palette.mode,
  ...(palette.pairId ? { pairId: palette.pairId } : {}),
  seeds: { ...palette.seeds },
});

const toContractPalette = (palette: Palette): ContractPalette => ({
  id: palette.id as PaletteId,
  name: palette.name,
  mode: palette.mode,
  ...(palette.pairId ? { pairId: palette.pairId as PaletteId } : {}),
  seeds: {
    bg: palette.seeds.bg,
    surface: palette.seeds.surface,
    text: palette.seeds.text,
    muted: palette.seeds.muted,
    accent: palette.seeds.accent,
    accent2: palette.seeds.accent2,
    red: palette.seeds.red,
    green: palette.seeds.green,
    yellow: palette.seeds.yellow,
    cyan: palette.seeds.cyan,
  },
});

export interface PaletteOps {
  upsert: ContractPalette[];
  remove: PaletteId[];
}

/** The `palettes.upsert` / `palettes.remove` calls that turn `synced` into `local`. */
export function paletteOps(synced: readonly Palette[], local: readonly Palette[]): PaletteOps {
  const key = (p: Palette) => JSON.stringify(toContractPalette(p));
  const before = new Map(synced.map((p) => [p.id, key(p)]));
  const after = new Set(local.map((p) => p.id));
  return {
    upsert: local.filter((p) => before.get(p.id) !== key(p)).map(toContractPalette),
    remove: synced.filter((p) => !after.has(p.id)).map((p) => p.id as PaletteId),
  };
}

// ---------------------------------------------------------------------------------------------
// Pane grid

const validFractions = (fr: readonly number[] | undefined, length: number) =>
  fr !== undefined && fr.length === length && fr.every((f) => Number.isFinite(f) && f > 0)
    ? [...fr]
    : undefined;

/**
 * The grid to restore: the saved grid. Threads that no longer exist or repeat become empty panes.
 */
export function restoreGrid(
  layout: LayoutSettings | undefined,
  exists: (threadId: ThreadId) => boolean,
): GridState | undefined {
  const saved = layout?.grid;
  if (!saved) return undefined;
  const { cols, rows } = GRID_SHAPES[saved.preset];
  const seen = new Set<ThreadId>();
  const panes = Array.from({ length: cols * rows }, (_, i): ThreadId | null => {
    const id = saved.panes[i] ?? null;
    if (id === null || !exists(id) || seen.has(id)) return null;
    seen.add(id);
    return id;
  });
  const focused = saved.focused !== undefined && saved.focused < panes.length ? saved.focused : 0;
  return {
    preset: saved.preset,
    panes,
    colFr: validFractions(saved.colFr, cols),
    rowFr: validFractions(saved.rowFr, rows),
    focused,
    maximized: false,
  };
}

/** The persisted form of `grid`; maximize stays local. */
export function gridLayout(grid: GridState): GridLayout {
  return {
    preset: grid.preset,
    panes: [...grid.panes],
    ...(grid.colFr ? { colFr: [...grid.colFr] } : {}),
    ...(grid.rowFr ? { rowFr: [...grid.rowFr] } : {}),
    focused: grid.focused,
  };
}
