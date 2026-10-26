import {
  DEFAULT_LOOK_ID,
  DEFAULT_PALETTE_ID,
  LOOKS,
  PRESET_PALETTES,
  resolvePalette,
  type Contrast,
  type Density,
  type LookId,
  type Mode,
  type Palette,
} from "@gram/themes";

export type ModePref = "system" | Mode;
/** `system` is full motion unless the OS asks for less. */
export type MotionPref = "system" | "reduced" | "off";
export type ResolvedMotion = "full" | "reduced" | "off";
export type DensityPref = Density;
/** `system` is standard contrast unless the OS asks for more. */
export type ContrastPref = "system" | "more";

export interface ThemePrefs {
  look: LookId;
  palette: string;
  mode: ModePref;
  density: DensityPref;
  contrast: ContrastPref;
  motion: MotionPref;
}

export const DEFAULT_THEME: ThemePrefs = {
  look: DEFAULT_LOOK_ID,
  palette: DEFAULT_PALETTE_ID,
  mode: "dark",
  density: LOOKS[DEFAULT_LOOK_ID].density.default,
  contrast: "system",
  motion: "system",
};

export const MODE_PREFS = ["system", "light", "dark"] as const satisfies readonly ModePref[];
export const MOTION_PREFS = ["system", "reduced", "off"] as const satisfies readonly MotionPref[];
export const DENSITY_PREFS = ["comfortable", "compact"] as const satisfies readonly DensityPref[];
export const CONTRAST_PREFS = ["system", "more"] as const satisfies readonly ContrastPref[];

/** OS-level preferences the `system` settings follow. */
export interface SystemPrefs {
  prefersDark: boolean;
  prefersReducedMotion: boolean;
  prefersMoreContrast: boolean;
}

export const DEFAULT_SYSTEM_PREFS: SystemPrefs = {
  prefersDark: true,
  prefersReducedMotion: false,
  prefersMoreContrast: false,
};

/** `system` follows the OS reduced-motion preference, which maps to Reduced (not Off). */
export function resolveMotion(pref: MotionPref, prefersReducedMotion: boolean): ResolvedMotion {
  if (pref === "system") return prefersReducedMotion ? "reduced" : "full";
  return pref;
}

export function resolveMode(pref: ModePref, prefersDark: boolean): Mode {
  if (pref === "system") return prefersDark ? "dark" : "light";
  return pref;
}

export function resolveContrast(pref: ContrastPref, prefersMoreContrast: boolean): Contrast {
  if (pref === "system") return prefersMoreContrast ? "more" : "standard";
  return pref;
}

type ThemeAttributeName = `data-${"look" | "palette" | "mode" | "density" | "contrast" | "motion"}`;
export type ThemeAttributes = Record<ThemeAttributeName, string>;

/**
 * The `data-*` attributes for `<html>`. Everything is resolved: `data-palette` is the palette
 * actually rendered (after light/dark pairing) and `data-mode` is that palette's own mode, so a
 * dark-only palette stays dark even when Light is requested.
 */
export function themeAttributes(
  prefs: ThemePrefs,
  system: SystemPrefs,
  palettes: readonly Palette[] = PRESET_PALETTES,
): ThemeAttributes {
  const requestedMode = resolveMode(prefs.mode, system.prefersDark);
  const palette =
    resolvePalette(palettes, prefs.palette, requestedMode) ??
    resolvePalette(PRESET_PALETTES, DEFAULT_PALETTE_ID, requestedMode)!;
  return {
    "data-look": prefs.look,
    "data-palette": palette.id,
    "data-mode": palette.mode,
    "data-density": prefs.density,
    "data-contrast": resolveContrast(prefs.contrast, system.prefersMoreContrast),
    "data-motion": resolveMotion(prefs.motion, system.prefersReducedMotion),
  };
}

export function applyAttributes(root: Pick<Element, "setAttribute">, attrs: ThemeAttributes) {
  for (const [name, value] of Object.entries(attrs)) root.setAttribute(name, value);
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

/**
 * Keeps only the recognised fields of persisted or synced preferences. The server stores contrast
 * `system` as `standard`, which reads as `system` again.
 */
export function sanitizePrefs(input: unknown): Partial<ThemePrefs> {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const out: Partial<ThemePrefs> = {};
  if (raw["look"] === DEFAULT_LOOK_ID) out.look = DEFAULT_LOOK_ID;
  if (typeof raw["palette"] === "string" && raw["palette"]) out.palette = raw["palette"];
  if (oneOf(MODE_PREFS, raw["mode"])) out.mode = raw["mode"];
  if (oneOf(DENSITY_PREFS, raw["density"])) out.density = raw["density"];
  if (oneOf(CONTRAST_PREFS, raw["contrast"])) out.contrast = raw["contrast"];
  else if (raw["contrast"] === "standard") out.contrast = "system";
  if (oneOf(MOTION_PREFS, raw["motion"])) out.motion = raw["motion"];
  return out;
}
