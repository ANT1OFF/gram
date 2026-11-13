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
  type SeedTokens,
} from "@gram/themes";

import type { HostTheme } from "@/embed/contract";

// The look an app that mounts Gram gives it (`MountOptions.theme`, typed in the embed contract):
// its own palette in place of Gram's default one, and its fonts, radii and chart colours. A
// person's own choices still win: another palette picked in Settings, and the fonts setting. With
// no theme, nothing here applies.
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
    const palette = paletteFromSeeds(theme!.palettes![mode]! as SeedTokens, {
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
    parts.push(
      cssBlock([selector], { ...paletteVariables(derivePalette(palette)), ...over, ...chart }),
      // More contrast keeps the derived colours: the host's own are tuned for standard contrast.
      cssBlock([`${selector}[data-contrast="more"]`], {
        ...paletteVariables(derivePalette(palette, "more")),
        ...chart,
      }),
    );
  }
  // Charts follow the mode on Gram's own palettes too, when the host names no palette of its own.
  if (!theme.palettes) {
    for (const mode of ["dark", "light"] as const) {
      const chart = chartVariables(theme.chart?.[mode]);
      if (Object.keys(chart).length) parts.push(cssBlock([`:root[data-mode="${mode}"]`], chart));
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
  // Over the look's own block (`[data-look]`); the fonts setting is inline on `<html>` and wins.
  if (Object.keys(look).length) parts.push(cssBlock(["html[data-look]"], look));
  return parts.join("\n");
}

function colorVariables(colors: Readonly<Record<string, string>> | undefined) {
  const vars: CssVariables = {};
  for (const [key, value] of Object.entries(colors ?? {})) if (value) vars[`--${key}`] = value;
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
