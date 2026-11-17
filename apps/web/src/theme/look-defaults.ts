import { DEFAULT_PALETTE_ID, PRESET_PALETTES, type Palette } from "@gram/themes";

import type { LookDefaults } from "@/embed/contract";

import { hostPaletteFor, type HostTheme } from "./host-theme";
import type { ThemePrefs } from "./theme";

// What an app that mounts Gram gives as the look a person sees until they choose their own
// (`MountOptions.defaults`): a built-in palette by its id, an accent, a picture, the surfaces and
// the sidebar's shape and icons, by name only. A person's own choice in Settings always wins.

const PRESETS: readonly Palette[] = PRESET_PALETTES;
const DEFAULT_PAIR: ReadonlySet<string> = new Set(
  PRESETS.filter((p) => p.id === DEFAULT_PALETTE_ID || p.pairId === DEFAULT_PALETTE_ID).map(
    (p) => p.id,
  ),
);

/** The look's parts a person chooses, which an app's defaults fill until then. */
type LookPart = "accent" | "backdrop" | "surfaces" | "sidebar" | "sidebarIcons";

let current: LookDefaults | undefined;

/** The defaults the page was mounted with, if any. */
export const lookDefaults = (): LookDefaults | undefined => current;

/** Sets the app's defaults for the page. A palette that isn't built in is left out. */
export function installLookDefaults(defaults: LookDefaults | undefined): void {
  if (defaults?.palette !== undefined && !PRESETS.some((p) => p.id === defaults.palette)) {
    const { palette: _unknown, ...rest } = defaults;
    current = rest;
  } else current = defaults;
}

/**
 * The palette to render for a person's choice: while it is still Gram's default pair, a host
 * theme's palette if it gives one, else the app's default palette. Any other choice holds.
 */
export function paletteToRender(
  chosen: string,
  host: HostTheme | undefined,
  defaults: LookDefaults | undefined = current,
): string {
  const hosted = hostPaletteFor(chosen, host);
  return hosted === chosen && DEFAULT_PAIR.has(chosen) && defaults?.palette
    ? defaults.palette
    : hosted;
}

/**
 * The preferences to render: the person's own, with what they haven't chosen taken from the app's
 * defaults. A palette counts as not chosen while it is Gram's default pair; a host theme's palette
 * takes that place before a default palette does.
 */
export function effectivePrefs<T extends ThemePrefs>(
  prefs: T,
  host: HostTheme | undefined = undefined,
  defaults: LookDefaults | undefined = current,
): T {
  const pick = <K extends LookPart>(key: K) => {
    const value = prefs[key] ?? defaults?.[key];
    return value === undefined ? {} : { [key]: value };
  };
  return {
    ...prefs,
    palette: paletteToRender(prefs.palette, host, defaults),
    ...pick("accent"),
    ...pick("backdrop"),
    ...pick("surfaces"),
    ...pick("sidebar"),
    ...pick("sidebarIcons"),
  };
}
