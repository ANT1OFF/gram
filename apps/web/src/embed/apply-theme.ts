import { PRESET_PALETTES } from "@gram/themes";

import { hostPalettes, installHostTheme } from "@/theme/host-theme";
import { paletteToRender } from "@/theme/look-defaults";
import { syncCustomPaletteStyle } from "@/theme/sync";
import {
  applyAttributes,
  DEFAULT_THEME,
  sanitizePalettes,
  sanitizePrefs,
  themeAttributes,
  type SystemPrefs,
} from "@/theme/theme";

import type { HostTheme, LookDefaults } from "./contract";

const STORAGE_KEY = "gram.theme";

function storedState(): Record<string, unknown> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    const state =
      typeof stored === "object" && stored !== null && "state" in stored ? stored.state : undefined;
    return typeof state === "object" && state !== null ? { ...state } : {};
  } catch {
    return {};
  }
}

const matches = (query: string) =>
  typeof window.matchMedia === "function" && window.matchMedia(query).matches;

function systemPrefs(): SystemPrefs {
  return {
    prefersDark: matches("(prefers-color-scheme: dark)"),
    prefersReducedMotion: matches("(prefers-reduced-motion: reduce)"),
    prefersMoreContrast: matches("(prefers-contrast: more)"),
  };
}

/**
 * Puts Gram's look on the page before Gram mounts, as mounting does: the person's stored mode,
 * palette (their own palettes included), contrast, density and motion, resolved against the OS's
 * preferences, on `<html>`, and your app's own `theme` (the one you mount with) over them. For a
 * page of yours drawn with the light kit (sign-in, a landing page) that should look as Gram will
 * once it mounts. The OS's preferences are read once, as the page opens; call it again to follow
 * a change. The same pure steps as Gram's own theme sync, without its stores. With `defaults` (the
 * ones you mount with), their palette stands in until the person picks one; their accent, picture
 * and sidebar are Gram's once it mounts.
 */
export function applyGramTheme(theme?: HostTheme, defaults?: LookDefaults): void {
  if (typeof document === "undefined") return;
  const state = storedState();
  const prefs = { ...DEFAULT_THEME, ...sanitizePrefs(state) };
  const custom = sanitizePalettes(state["customPalettes"]);
  installHostTheme(document, theme);
  syncCustomPaletteStyle(document, custom);
  const palettes = [...PRESET_PALETTES, ...custom, ...hostPalettes(theme)];
  const root = document.documentElement;
  root.setAttribute("data-theme-booting", "");
  applyAttributes(
    root,
    themeAttributes(
      { ...prefs, palette: paletteToRender(prefs.palette, theme, defaults) },
      systemPrefs(),
      palettes,
    ),
  );
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.removeAttribute("data-theme-booting")),
  );
}
