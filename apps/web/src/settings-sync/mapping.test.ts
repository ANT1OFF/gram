import type { PaletteId, ThreadId } from "@gram/contracts";
import type { Palette } from "@gram/themes";
import { describe, expect, it } from "vitest";

import { DEFAULT_THEME } from "@/theme/theme";

import {
  appearanceFromPrefs,
  gridLayout,
  paletteOps,
  prefsFromAppearance,
  restoreGrid,
  settingsPatch,
  type SyncedSettings,
} from "./mapping";

const seeds = {
  bg: "#101010",
  surface: "#141414",
  text: "#eeeeee",
  muted: "#777777",
  accent: "#7aa2f7",
  accent2: "#bb9af7",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  cyan: "#7dcfff",
};
const palette = (id: string, name = id): Palette => ({ id, name, mode: "dark", seeds });
const ids = (...values: string[]) => values as ThreadId[];

describe("appearance mapping", () => {
  it("saves Glass, the chosen density, and system contrast as standard", () => {
    expect(appearanceFromPrefs(DEFAULT_THEME)).toMatchObject({
      look: "glass",
      density: "comfortable",
      contrast: "standard",
    });
  });

  it("round-trips, reading a saved standard contrast as system", () => {
    expect(prefsFromAppearance(appearanceFromPrefs(DEFAULT_THEME))).toEqual(DEFAULT_THEME);
    const compact = { ...DEFAULT_THEME, density: "compact" as const, contrast: "more" as const };
    expect(prefsFromAppearance(appearanceFromPrefs(compact))).toEqual(compact);
  });
});

describe("settingsPatch", () => {
  const base: SyncedSettings = {
    appearance: appearanceFromPrefs(DEFAULT_THEME),
    sidebarWidth: 280,
    panelOpen: true,
    panelWidth: 352,
    panelTab: "diff",
    focusMode: false,
    overviewSidebar: undefined,
    overviewHidden: [],
  };

  it("saves the right panel and focus mode, clearing focus mode when it's off", () => {
    const hidden: SyncedSettings = {
      ...base,
      panelOpen: false,
      panelWidth: 400,
      panelTab: "pr",
      focusMode: true,
    };
    expect(settingsPatch(base, hidden)).toEqual({
      panel: { open: false, width: 400, tab: "pr" },
      layout: { focusMode: true },
    });
    expect(settingsPatch(hidden, { ...hidden, focusMode: false })).toEqual({
      layout: { focusMode: null },
    });
  });

  it("saves the overview sidebar's pick, clearing it for automatic", () => {
    const hidden: SyncedSettings = { ...base, overviewSidebar: "hidden" };
    expect(settingsPatch(base, hidden)).toEqual({
      layout: { overviewSidebar: "hidden" },
    });
    expect(settingsPatch(hidden, base)).toEqual({
      layout: { overviewSidebar: null },
    });
    expect(settingsPatch(hidden, { ...hidden, overviewSidebar: "open" })).toEqual({
      layout: { overviewSidebar: "open" },
    });
    expect(settingsPatch(hidden, { ...hidden })).toBeUndefined();
  });

  it("saves the overview sections turned off, only them, and clears the field with all on", () => {
    const off: SyncedSettings = { ...base, overviewHidden: ["solo", "usage"] };
    expect(settingsPatch(base, off)).toEqual({
      layout: { overviewSections: { solo: false, usage: false } },
    });
    expect(settingsPatch(off, base)).toEqual({ layout: { overviewSections: null } });
    expect(settingsPatch(off, { ...off, overviewHidden: ["solo", "usage"] })).toBeUndefined();
    // With another layout change, both go in the one layout patch.
    expect(settingsPatch(base, { ...off, focusMode: true })).toEqual({
      layout: { focusMode: true, overviewSections: { solo: false, usage: false } },
    });
  });

  it("persists the Notifications tab through the existing panel settings contract", () => {
    expect(settingsPatch(base, { ...base, panelTab: "notifications" })).toEqual({
      panel: { tab: "notifications" },
    });
  });

  it("holds only the changed fields and sections", () => {
    const next: SyncedSettings = {
      ...base,
      appearance: { ...base.appearance, mode: "light" },
      sidebarWidth: 300,
    };
    expect(settingsPatch(base, next)).toEqual({
      appearance: { mode: "light" },
      sidebar: { width: 300 },
    });
  });

  it("saves the overview's width", () => {
    expect(settingsPatch(base, { ...base, sidebarWidth: 312 })).toEqual({
      sidebar: { width: 312 },
    });
  });

  it("is undefined when nothing changed", () => {
    expect(settingsPatch(base, { ...base, appearance: { ...base.appearance } })).toBeUndefined();
  });
});

describe("paletteOps", () => {
  it("upserts new and edited palettes and removes deleted ones", () => {
    const ops = paletteOps([palette("a"), palette("b")], [palette("b", "Renamed"), palette("c")]);
    expect(ops.upsert.map((p) => [p.id, p.name])).toEqual([
      ["b", "Renamed"],
      ["c", "c"],
    ]);
    expect(ops.remove).toEqual(["a" as PaletteId]);
  });

  it("does nothing for identical palettes", () => {
    expect(paletteOps([palette("a")], [palette("a")])).toEqual({ upsert: [], remove: [] });
  });
});

describe("pane grid", () => {
  it("restores the saved grid, emptying unknown and repeated threads", () => {
    const known = new Set(["a", "b"]);
    const restored = restoreGrid(
      {
        grid: {
          preset: "2x2",
          panes: ids("a", "x", "a", "b"),
          colFr: [2, 1],
          rowFr: [1, 0],
          focused: 3,
        },
      },
      (id) => known.has(id),
    );
    expect(restored).toEqual({
      preset: "2x2",
      panes: ["a", null, null, "b"],
      colFr: [2, 1],
      rowFr: undefined,
      focused: 3,
      maximized: false,
    });
  });

  it("falls back to the first pane when focus is out of range", () => {
    const outOfRange = { grid: { preset: "2c" as const, panes: ids("a", "b"), focused: 7 } };
    expect(restoreGrid(outOfRange, () => true)?.focused).toBe(0);
    expect(restoreGrid(undefined, () => true)).toBeUndefined();
  });

  it("persists the grid without maximize or absent fractions", () => {
    const grid = {
      preset: "2c" as const,
      panes: ["a" as ThreadId, null],
      colFr: undefined,
      rowFr: [1],
      focused: 1,
      maximized: true,
    };
    expect(gridLayout(grid)).toEqual({ preset: "2c", panes: ["a", null], rowFr: [1], focused: 1 });
  });
});
