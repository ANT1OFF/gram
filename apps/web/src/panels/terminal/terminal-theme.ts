import {
  DEFAULT_PALETTE_ID,
  derivePalette,
  PRESET_PALETTES,
  resolvePalette,
  type Palette,
} from "@gram/themes";

import { useThemeStore } from "@/theme/store";
import { useSystemPrefs } from "@/theme/system";
import { resolveContrast, resolveMode, type SystemPrefs, type ThemePrefs } from "@/theme/theme";

import type { TerminalSearchColors, TerminalTheme } from "./ghostty-loader";
import { terminalFont } from "./terminal-font";

/** The active palette after light/dark pairing and the contrast preference. */
const activePalette = (
  prefs: Pick<ThemePrefs, "palette" | "mode" | "contrast">,
  customPalettes: readonly Palette[],
  system: SystemPrefs,
) => {
  const mode = resolveMode(prefs.mode, system.prefersDark);
  const palette =
    resolvePalette([...PRESET_PALETTES, ...customPalettes], prefs.palette, mode) ??
    resolvePalette(PRESET_PALETTES, DEFAULT_PALETTE_ID, mode)!;
  return derivePalette(palette, resolveContrast(prefs.contrast, system.prefersMoreContrast));
};

/** The terminal theme for the active palette: its derived ANSI-16 set, after light/dark pairing. */
export function terminalTheme(
  prefs: Pick<ThemePrefs, "palette" | "mode" | "contrast">,
  customPalettes: readonly Palette[],
  system: SystemPrefs,
): TerminalTheme {
  const { ansi } = activePalette(prefs, customPalettes, system);
  return {
    background: ansi.background,
    foreground: ansi.foreground,
    cursor: ansi.cursor,
    cursorAccent: ansi.background,
    selectionBackground: ansi.selection,
    black: ansi.black,
    red: ansi.red,
    green: ansi.green,
    yellow: ansi.yellow,
    blue: ansi.blue,
    magenta: ansi.magenta,
    cyan: ansi.cyan,
    white: ansi.white,
    brightBlack: ansi.brightBlack,
    brightRed: ansi.brightRed,
    brightGreen: ansi.brightGreen,
    brightYellow: ansi.brightYellow,
    brightBlue: ansi.brightBlue,
    brightMagenta: ansi.brightMagenta,
    brightCyan: ansi.brightCyan,
    brightWhite: ansi.brightWhite,
  };
}

export function useTerminalTheme(): TerminalTheme {
  const palette = useThemeStore((s) => s.palette);
  const mode = useThemeStore((s) => s.mode);
  const contrast = useThemeStore((s) => s.contrast);
  const customPalettes = useThemeStore((s) => s.customPalettes);
  const system = useSystemPrefs();
  return terminalTheme({ palette, mode, contrast }, customPalettes, system);
}

/**
 * Find highlights for the active palette, translucent because they lie over the text rather than
 * under it: the warning colour on every match, the accent on the active one.
 */
export function terminalSearchColors(
  prefs: Pick<ThemePrefs, "palette" | "mode" | "contrast">,
  customPalettes: readonly Palette[],
  system: SystemPrefs,
): TerminalSearchColors {
  const { colors } = activePalette(prefs, customPalettes, system);
  return {
    match: `color-mix(in srgb, ${colors.warning} 35%, transparent)`,
    activeMatch: `color-mix(in srgb, ${colors.accent} 45%, transparent)`,
    activeMatchBorder: colors.accent,
  };
}

export function useTerminalSearchColors(): TerminalSearchColors {
  const palette = useThemeStore((s) => s.palette);
  const mode = useThemeStore((s) => s.mode);
  const contrast = useThemeStore((s) => s.contrast);
  const customPalettes = useThemeStore((s) => s.customPalettes);
  const system = useSystemPrefs();
  return terminalSearchColors({ palette, mode, contrast }, customPalettes, system);
}

/** The look's mono font stack, from the live `--font-mono` token. */
export const monoFont = () =>
  terminalFont(
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
      "ui-monospace, monospace",
  );
