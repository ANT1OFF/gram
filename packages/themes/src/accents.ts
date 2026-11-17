import type { Mode, Palette } from "./palette.ts";

/**
 * Accents a person can lay over any palette: one hue each, as a light value and a dark value made
 * to go together. The palette keeps its page, text and status colours; only the accent seeds
 * change, and the derivation still holds every accent-coloured token to the contrast targets.
 */
export const ACCENTS = [
  { id: "ink", name: "Ink", light: "#334155", dark: "#475569" },
  { id: "indigo", name: "Indigo", light: "#4338b8", dark: "#4c4cc4" },
  { id: "plum", name: "Plum", light: "#6b2f5f", dark: "#7a3a6e" },
  { id: "forest", name: "Forest", light: "#1f5c3e", dark: "#2a6649" },
  { id: "sage", name: "Sage", light: "#4a6250", dark: "#536b58" },
  { id: "clay", name: "Clay", light: "#9a452a", dark: "#9c4a2e" },
  { id: "ochre", name: "Ochre", light: "#7c5200", dark: "#80560a" },
  { id: "petrol", name: "Petrol", light: "#1d5563", dark: "#246676" },
  { id: "graphite", name: "Warm graphite", light: "#3f3a36", dark: "#57504a" },
  { id: "navy", name: "Muted navy", light: "#2c4a94", dark: "#3757a8" },
] as const satisfies readonly {
  readonly id: string;
  readonly name: string;
  readonly light: string;
  readonly dark: string;
}[];

export type AccentId = (typeof ACCENTS)[number]["id"];

export const ACCENT_IDS: readonly AccentId[] = ACCENTS.map((accent) => accent.id);

/** Between a palette's id and an accent's in the id of the palette with that accent laid over. */
export const ACCENT_SEPARATOR = "~";

export const isAccentId = (value: unknown): value is AccentId =>
  typeof value === "string" && (ACCENT_IDS as readonly string[]).includes(value);

/** The accent's value for a mode. */
export function accentColor(id: AccentId, mode: Mode): string {
  const accent = ACCENTS.find((entry) => entry.id === id)!;
  return mode === "light" ? accent.light : accent.dark;
}

/**
 * `palette` with the accent laid over it: its own id followed by `~<accent>`, and its pair's id
 * likewise, so switching mode keeps the accent.
 */
export function withAccent(palette: Palette, id: AccentId): Palette {
  const color = accentColor(id, palette.mode);
  return {
    ...palette,
    id: `${palette.id}${ACCENT_SEPARATOR}${id}`,
    ...(palette.pairId ? { pairId: `${palette.pairId}${ACCENT_SEPARATOR}${id}` } : {}),
    seeds: { ...palette.seeds, accent: color, accent2: color },
  };
}
