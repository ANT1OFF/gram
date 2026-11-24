import {
  cssBlock,
  DEFAULT_PALETTE_ID,
  derivePalette,
  paletteFromSeeds,
  paletteVariables,
  PRESET_PALETTES,
  resolvePalette,
  type CssVariables,
  type Mode,
  type Palette,
} from "@gram/themes";

import type { HostTheme } from "@/embed/contract";

export type { HostTheme };

/** The ids the host's palettes take. They stand in for Gram's default pair while a theme is set. */
export const HOST_PALETTE_IDS: Readonly<Record<Mode, string>> = {
  dark: "host-dark",
  light: "host-light",
};

const PRESETS: readonly Palette[] = PRESET_PALETTES;
const DEFAULT_PAIR: ReadonlySet<string> = new Set(
  PRESETS.filter((p) => p.id === DEFAULT_PALETTE_ID || p.pairId === DEFAULT_PALETTE_ID).map(
    (p) => p.id,
  ),
);

/** The host's palettes, paired with each other when it gives both modes. */
export function hostPalettes(theme: HostTheme | undefined): Palette[] {
  const modes = (["dark", "light"] as const).filter((mode) => theme?.palettes?.[mode]);
  return modes.map((mode) => {
    const palette = paletteFromSeeds(theme!.palettes![mode]!, {
      id: HOST_PALETTE_IDS[mode],
      name: theme?.name ?? "Default",
    });
    const other = mode === "dark" ? "light" : "dark";
    return {
      ...palette,
      mode,
      ...(modes.includes(other) ? { pairId: HOST_PALETTE_IDS[other] } : {}),
    };
  });
}

/**
 * The palette id to render for a person's choice: Gram's default pair means the host's palette
 * when it gives one, so a person who never picked a palette sees the host's. Any other choice holds.
 */
export function hostPaletteFor(chosen: string, theme: HostTheme | undefined): string {
  const palettes = hostPalettes(theme);
  if (!palettes.length || !DEFAULT_PAIR.has(chosen)) return chosen;
  const chosenMode = PRESETS.find((p) => p.id === chosen)?.mode ?? "dark";
  return (resolvePalette(palettes, HOST_PALETTE_IDS[chosenMode], chosenMode) ?? palettes[0]!).id;
}

const px = (n: number) => `${n}px`;

/** The stylesheet for a host theme: its palettes, then the look's values it sets. */
export function hostThemeCss(theme: HostTheme | undefined): string {
  if (!theme) return "";
  const parts: string[] = [];
  for (const palette of hostPalettes(theme)) {
    const selector = `[data-palette="${palette.id}"]`;
    const over = colorVariables(theme.colors?.[palette.mode]);
    const chart = chartVariables(theme.chart?.[palette.mode]);
    const sidebar = sidebarColorVariables(theme.sidebar, palette.mode);
    parts.push(
      cssBlock([selector], { ...paletteVariables(derivePalette(palette)), ...over, ...chart }),
      cssBlock([`${selector}[data-contrast="more"]`], {
        ...paletteVariables(derivePalette(palette, "more")),
        ...chart,
      }),
    );
    if (Object.keys(sidebar).length) parts.push(cssBlock([`html${selector}`], sidebar));
  }
  if (!theme.palettes) {
    for (const mode of ["dark", "light"] as const) {
      const vars = {
        ...chartVariables(theme.chart?.[mode]),
        ...sidebarColorVariables(theme.sidebar, mode),
      };
      if (Object.keys(vars).length) parts.push(cssBlock([`:root[data-mode="${mode}"]`], vars));
    }
  }
  const look: CssVariables = {};
  if (theme.fonts?.ui) look["--font-ui"] = theme.fonts.ui;
  if (theme.fonts?.mono) look["--font-mono"] = theme.fonts.mono;
  if (theme.fonts?.display) look["--font-display"] = theme.fonts.display;
  for (const [step, value] of Object.entries(theme.radii ?? {})) {
    if (typeof value === "number") look[`--radius-${step}`] = px(value);
  }
  if (theme.shadows === "none") {
    look["--shadow-raised"] = "none";
    look["--shadow-overlay"] = "0 0 0 var(--hairline) var(--border-subtle)";
  }
  Object.assign(look, sidebarShapeVariables(theme.sidebar));
  if (Object.keys(look).length) parts.push(cssBlock(["html[data-look]"], look));
  return parts.join("\n");
}

function colorVariables(colors: Readonly<Record<string, string>> | undefined) {
  const vars: CssVariables = {};
  for (const [key, value] of Object.entries(colors ?? {})) if (value) vars[`--${key}`] = value;
  return vars;
}

/** The inset sidebar's margin from the window's edges when the host gives none, in pixels. */
export const SIDEBAR_INSET_MARGIN = 8;

function sidebarShapeVariables(sidebar: HostTheme["sidebar"]) {
  const vars: CssVariables = {};
  if (sidebar?.mode === "inset") {
    vars["--sidebar-inset"] = px(sidebar.margin ?? SIDEBAR_INSET_MARGIN);
    vars["--sidebar-radius"] = "var(--radius-lg)";
    vars["--sidebar-edge"] = "1px";
  }
  if (typeof sidebar?.radius === "number") vars["--sidebar-radius"] = px(sidebar.radius);
  return vars;
}

function sidebarColorVariables(sidebar: HostTheme["sidebar"], mode: Mode) {
  const vars: CssVariables = {};
  const icon = sidebar?.icon?.[mode];
  const background = sidebar?.background?.[mode];
  if (icon) vars["--sidebar-icon"] = icon;
  if (background) vars["--sidebar-bg"] = background;
  return vars;
}

function chartVariables(colors: readonly string[] | undefined) {
  const vars: CssVariables = {};
  (colors ?? []).forEach((color, index) => {
    vars[`--chart-${index + 1}`] = color;
  });
  return vars;
}

const STYLE_ID = "gram-host-theme";
let current: HostTheme | undefined;

/** The theme the page was mounted with, if any. */
export const hostTheme = (): HostTheme | undefined => current;

/** Sets the host's theme for the page: its stylesheet, and the default palette it stands for. */
export function installHostTheme(doc: Document, theme: HostTheme | undefined): void {
  current = theme;
  const css = hostThemeCss(theme);
  let style = doc.getElementById(STYLE_ID);
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = doc.createElement("style");
    style.id = STYLE_ID;
    doc.head.append(style);
  }
  style.textContent = css;
}
