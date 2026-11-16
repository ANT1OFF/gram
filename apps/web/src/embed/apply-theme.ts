import { PRESET_PALETTES } from "@gram/themes";

import { hostPaletteFor, hostPalettes, installHostTheme } from "@/theme/host-theme";
import { syncCustomPaletteStyle } from "@/theme/sync";
import {
  applyAttributes,
  DEFAULT_THEME,
  sanitizePalettes,
  sanitizePrefs,
  themeAttributes,
  type SystemPrefs,
} from "@/theme/theme";

import type { HostTheme } from "./contract";

/** Where Gram keeps the person's theme, as its theme store persists it. */
const STORAGE_KEY = "gram.theme";

/** The persisted state, or nothing where storage can't be read or holds no theme. */
function storedState(): Record<string, unknown> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as {
      state?: unknown;
    };
    return stored.state !== null && typeof stored.state === "object"
      ? (stored.state as Record<string, unknown>)
      : {};
  } catch {
    // A private window, blocked site data or a damaged value: the defaults.
    return {};
  }
}

/** Whether the OS asks for `query`; no where the browser can't say. */
const matches = (query: string) =>
  typeof window.matchMedia === "function" && window.matchMedia(query).matches;

/** The OS's preferences, read once, as the page opens. */
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
 * a change. The same pure steps as Gram's own theme sync, without its stores.
 */
export function applyGramTheme(theme?: HostTheme): void {
  if (typeof document === "undefined") return;
  const state = storedState();
  const prefs = { ...DEFAULT_THEME, ...sanitizePrefs(state) };
  const custom = sanitizePalettes(state["customPalettes"]);
  installHostTheme(document, theme);
  syncCustomPaletteStyle(document, custom);
  const palettes = [...PRESET_PALETTES, ...custom, ...hostPalettes(theme)];
  const root = document.documentElement;
  // No transitions until the theme has painted, so nothing fades into it from the page's default.
  root.setAttribute("data-theme-booting", "");
  applyAttributes(
    root,
    themeAttributes(
      { ...prefs, palette: hostPaletteFor(prefs.palette, theme) },
      systemPrefs(),
      palettes,
    ),
  );
  // Two frames on, as Gram's own `ThemeRoot` clears it once the synced theme has painted.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.removeAttribute("data-theme-booting")),
  );
}
