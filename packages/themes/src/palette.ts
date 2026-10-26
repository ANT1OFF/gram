import {
  composite,
  contrastRatio,
  ensureContrast,
  hexToOklch,
  luminance,
  minContrast,
  mix,
  normalizeHex,
  shiftLightness,
} from "./color.ts";

/** The ten seed tokens every palette (preset or custom) defines. */
export const SEED_TOKEN_KEYS = [
  "bg",
  "surface",
  "text",
  "muted",
  "accent",
  "accent2",
  "red",
  "green",
  "yellow",
  "cyan",
] as const;
export type SeedTokenKey = (typeof SEED_TOKEN_KEYS)[number];
export type SeedTokens = Record<SeedTokenKey, string>;

export type Mode = "light" | "dark";
export type Contrast = "standard" | "more";

export interface Palette {
  id: string;
  name: string;
  /** The mode the seeds were designed for; a palette never renders in the other mode. */
  mode: Mode;
  /** The palette to switch to when the other mode is requested. */
  pairId?: string;
  seeds: SeedTokens;
}

export const SEMANTIC_COLOR_KEYS = [
  "surface-1",
  "surface-2",
  "surface-3",
  "surface-hover",
  "fg",
  "fg-muted",
  "fg-subtle",
  "border-subtle",
  "border-strong",
  "accent",
  "accent-hover",
  "on-accent",
  "accent-text",
  "highlight",
  "danger",
  "success",
  "warning",
  "info",
  "danger-text",
  "success-text",
  "warning-text",
  "info-text",
  "status-needs",
  "status-working",
  "status-idle",
  "merged",
  "provider-anthropic",
  "provider-openai",
  "focus-ring",
  "selection",
  "diff-add-bg",
  "diff-del-bg",
  "diff-add-fg",
  "diff-del-fg",
] as const;
export type SemanticColorKey = (typeof SEMANTIC_COLOR_KEYS)[number];
export type SemanticColors = Record<SemanticColorKey, string>;

export const ANSI_KEYS = [
  "background",
  "foreground",
  "cursor",
  "selection",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
export type AnsiKey = (typeof ANSI_KEYS)[number];
/** The terminal colour set: ANSI-16 plus background, foreground, cursor and selection. */
export type AnsiTheme = Record<AnsiKey, string>;

export interface ResolvedPalette {
  palette: Palette;
  contrast: Contrast;
  colors: SemanticColors;
  ansi: AnsiTheme;
}

/** WCAG 2.2 floors per contrast level: `text` for body text, `ui` for glyphs, borders and focus. */
export const CONTRAST_TARGETS: Record<Contrast, { text: number; ui: number }> = {
  standard: { text: 4.5, ui: 3 },
  more: { text: 7, ui: 4.5 },
};

/** The most translucent any look may make chrome surfaces; derivation stays legible down to it. */
export const MIN_SURFACE_ALPHA = 0.85;

/**
 * GitHub's merged purple, per mode. The one colour no palette seeds: a merged PR should read as
 * merged at a glance to anyone who knows GitHub, whatever the theme's accents are.
 */
const GITHUB_MERGED = { dark: "#a371f7", light: "#8250df" } as const;

/**
 * The providers' brand colours, per mode, as `provider-*` tokens: Anthropic's orange, and OpenAI's
 * black and white (white on a dark surface, near-black on a light one). Like merged, no palette
 * seeds them, so a provider keeps its colour in every theme; a value moves only as far as the `ui`
 * floor needs on the surfaces.
 */
const PROVIDER_BRAND = {
  anthropic: { dark: "#d97757", light: "#c4522a" },
  openai: { dark: "#ffffff", light: "#0a0a0a" },
} as const;

/**
 * How strongly a sidebar section's count tints its pill with the section's hue (web tokens.css
 * `--section-tint-strength` mirrors it).
 */
export const SECTION_TINT = 0.14;

/** Lightness above which a background reads as light. */
const LIGHT_BG_THRESHOLD = 0.6;

/** Only the newly added families opt into text-grade SGR colors; existing presets stay unchanged. */
const TEXT_GRADE_ANSI_IDS = new Set(
  ["neutral", "rose", "forest", "ocean", "ember", "violet"].flatMap((id) => [id, `${id}-dark`]),
);

/**
 * Expands a palette's 10 seeds into semantic colours and an ANSI set.
 *
 * Seeds are never altered. Derived foreground tokens are lightness-shifted in OKLCH (hue kept) only
 * as far as needed to meet {@link CONTRAST_TARGETS} against every surface they can sit on —
 * including chrome composited at {@link MIN_SURFACE_ALPHA} — so any preset or custom palette
 * renders at WCAG AA or better.
 */
export function derivePalette(palette: Palette, contrast: Contrast = "standard"): ResolvedPalette {
  const s = normalizeSeeds(palette.seeds);
  const dark = palette.mode === "dark";
  const toward = dark ? "lighter" : "darker";
  const target = CONTRAST_TARGETS[contrast];

  const surface1 = s.surface;
  const surface2 = s.bg;
  const lighterSurface = luminance(surface1) > luminance(surface2) ? surface1 : surface2;
  const surface3 = dark
    ? shiftLightness(lighterSurface, 0.035)
    : mix(lighterSurface, "#ffffff", 0.5);
  const surfaceHover = mix(surface2, s.text, 0.07);
  const backdrop = dark ? "#000000" : "#ffffff";
  const surfaces = [
    surface1,
    surface2,
    surface3,
    surfaceHover,
    composite(surface1, MIN_SURFACE_ALPHA, backdrop),
    composite(surface1, MIN_SURFACE_ALPHA, surface2),
  ];

  const text = (color: string) => ensureContrast(color, surfaces, target.text, toward);
  const ui = (color: string) => ensureContrast(color, surfaces, target.ui, toward);

  const accent = deriveAccent(s, surfaces, target);
  const onAccent = pickOnAccent(accent, s, target.text) ?? "#000000";
  const warning = ui(s.yellow);
  const fgSubtle = ui(s.muted);
  const diffAddBg = mix(surface2, s.green, 0.13);
  const diffDelBg = mix(surface2, s.red, 0.13);
  // Hunk rows show page text and line numbers on the add/remove tints; the text shifts to hold its
  // floor there, so the tint stays strong enough to read as added or removed.
  const onDiff = (color: string) =>
    ensureContrast(color, [diffAddBg, diffDelBg], target.text, toward);
  const fg = onDiff(text(s.text));
  // Text drawn on a tint of itself holds its floor there too, the tint made as `tintOf` makes it.
  // The tint follows every shift, so it takes a few passes to settle. More contrast drops the tints
  // (web tokens.css).
  const tintedText = (
    seed: string,
    strengths: readonly number[],
    under: readonly string[],
    tintOf: (bg: string, color: string, strength: number) => string,
  ) => {
    let color = text(seed);
    if (contrast === "more") return color;
    for (let pass = 0; pass < 12; pass++) {
      const tints = under.flatMap((bg) => strengths.map((strength) => tintOf(bg, color, strength)));
      if (tints.every((tint) => contrastRatio(color, tint) >= target.text)) break;
      color = ensureContrast(color, [...surfaces, ...tints], target.text * 1.02, toward);
    }
    return color;
  };
  // Destructive badges and buttons: error text on its tint (web tokens.css: 10%, 15% on hover).
  const dangerText = (seed: string) =>
    tintedText(seed, [0.1, 0.15], [surface1, surface2, surface3], mix);
  // A sidebar section's count is its hue on a tint of it (web tokens.css --section-tint-strength),
  // over the sidebar and the section head's hover. The pill is `color-mix(in srgb, …, transparent)`,
  // which the browser composites in gamma-encoded sRGB, not OKLab as `mix` blends.
  const sectionText = (seed: string) =>
    tintedText(
      seed,
      [SECTION_TINT],
      [surface1, surface2, surface3, surfaceHover],
      (bg, color, strength) => composite(color, strength, bg),
    );
  // Selected text keeps the text floor: the tint backs off where the accent would take it below.
  const selection =
    [0.3, 0.24, 0.18, 0.12, 0.08, 0.04]
      .map((strength) => mix(surface2, s.accent, strength))
      .find((tint) => contrastRatio(fg, tint) >= target.text) ?? surface2;

  const colors: SemanticColors = {
    "surface-1": surface1,
    "surface-2": surface2,
    "surface-3": surface3,
    "surface-hover": surfaceHover,
    fg,
    "fg-muted": onDiff(text(mix(s.text, s.muted, contrast === "more" ? 0.25 : 0.5))),
    "fg-subtle": fgSubtle,
    "border-subtle": mix(surface2, s.text, dark ? 0.1 : 0.12),
    "border-strong": ui(mix(surface2, s.muted, 0.7)),
    accent,
    "accent-hover": shiftLightness(accent, dark ? 0.05 : -0.05),
    "on-accent": onAccent,
    "accent-text": text(accent),
    highlight: ui(s.accent2),
    danger: ui(s.red),
    success: ui(s.green),
    warning,
    info: ui(s.cyan),
    "danger-text": dangerText(s.red),
    "success-text": sectionText(s.green),
    "warning-text": text(s.yellow),
    "info-text": sectionText(s.cyan),
    // Statuses label rows, notices and count badges as text, so they're text-grade.
    "status-needs": sectionText(s.yellow),
    "status-working": sectionText(accent),
    "status-idle": sectionText(s.muted),
    merged: text(dark ? GITHUB_MERGED.dark : GITHUB_MERGED.light),
    "provider-anthropic": ui(dark ? PROVIDER_BRAND.anthropic.dark : PROVIDER_BRAND.anthropic.light),
    "provider-openai": ui(dark ? PROVIDER_BRAND.openai.dark : PROVIDER_BRAND.openai.light),
    "focus-ring": accent,
    selection,
    "diff-add-bg": diffAddBg,
    "diff-del-bg": diffDelBg,
    "diff-add-fg": ensureContrast(s.green, [diffAddBg, surface2], target.text, toward),
    "diff-del-fg": ensureContrast(s.red, [diffDelBg, surface2], target.text, toward),
  };

  return {
    palette: { ...palette, seeds: s },
    contrast,
    colors,
    ansi: deriveAnsi(
      s,
      colors,
      dark,
      TEXT_GRADE_ANSI_IDS.has(palette.id) ? target.text : undefined,
    ),
  };
}

function normalizeSeeds(seeds: SeedTokens): SeedTokens {
  const out = {} as SeedTokens;
  for (const key of SEED_TOKEN_KEYS) out[key] = normalizeHex(seeds[key]);
  return out;
}

/** Candidates for text on the accent, in order of preference (palette-harmonious first). */
const onAccentCandidates = (s: SeedTokens) => [s.bg, s.text, "#ffffff", "#000000"];

function pickOnAccent(accent: string, s: SeedTokens, target: number): string | undefined {
  return onAccentCandidates(s).find((c) => contrastRatio(c, accent) >= target);
}

/**
 * The accent must reach `ui` contrast against surfaces and leave some on-accent colour at `text`
 * contrast. Tries each on-accent candidate and keeps the accent that moved least from the seed.
 */
function deriveAccent(
  s: SeedTokens,
  surfaces: readonly string[],
  target: { text: number; ui: number },
): string {
  const dark = luminance(s.bg) < luminance(s.text);
  const base = ensureContrast(s.accent, surfaces, target.ui, dark ? "lighter" : "darker");
  if (pickOnAccent(base, s, target.text)) return base;
  const seedL = hexToOklch(s.accent).l;
  let best: { color: string; delta: number } | undefined;
  for (const candidate of onAccentCandidates(s)) {
    const away = luminance(candidate) > luminance(base) ? "darker" : "lighter";
    const color = ensureContrast(base, [candidate], target.text, away);
    if (contrastRatio(color, candidate) < target.text) continue;
    if (minContrast(color, surfaces) < target.ui) continue;
    const delta = Math.abs(hexToOklch(color).l - seedL);
    if (!best || delta < best.delta) best = { color, delta };
  }
  return best?.color ?? base;
}

function deriveAnsi(
  s: SeedTokens,
  colors: SemanticColors,
  dark: boolean,
  textFloor?: number,
): AnsiTheme {
  const bright = (hex: string) => shiftLightness(hex, dark ? 0.06 : -0.06);
  const ansi: AnsiTheme = {
    background: s.bg,
    foreground: colors.fg,
    cursor: colors.fg,
    selection: colors.selection,
    black: dark ? shiftLightness(s.bg, -0.04) : shiftLightness(s.surface, -0.12),
    red: s.red,
    green: s.green,
    yellow: s.yellow,
    blue: s.accent,
    magenta: s.accent2,
    cyan: s.cyan,
    white: mix(s.text, s.muted, 0.35),
    brightBlack: s.muted,
    brightRed: bright(s.red),
    brightGreen: bright(s.green),
    brightYellow: bright(s.yellow),
    brightBlue: bright(s.accent),
    brightMagenta: bright(s.accent2),
    brightCyan: bright(s.cyan),
    brightWhite: s.text,
  };
  if (textFloor !== undefined) {
    const text = (hex: string) =>
      ensureContrast(hex, [s.bg], textFloor, dark ? "lighter" : "darker");
    for (const key of ANSI_KEYS) {
      if (key === "background" || key === "selection" || key === "foreground" || key === "cursor")
        continue;
      ansi[key] = text(ansi[key]);
    }
    // Preserve the brightness step after raising a dim normal color to the text floor.
    for (const key of ["red", "green", "yellow", "blue", "magenta", "cyan"] as const) {
      const brightKey = `bright${key[0]!.toUpperCase()}${key.slice(1)}` as AnsiKey;
      ansi[brightKey] = text(bright(ansi[key]));
    }
  }
  return ansi;
}

/** Turns seed tokens into a palette; the mode follows the background. */
export function paletteFromSeeds(
  tokens: SeedTokens,
  options: { id?: string; name?: string } = {},
): Palette {
  const seeds = normalizeSeeds(tokens);
  return {
    id: options.id ?? "custom",
    name: options.name ?? "Custom",
    mode: hexToOklch(seeds.bg).l < LIGHT_BG_THRESHOLD ? "dark" : "light",
    seeds,
  };
}

/**
 * The palette to render for a chosen palette and requested mode: its pair when the pair matches the
 * mode, otherwise the palette itself (single-mode palettes ignore the request).
 */
export function resolvePalette(
  palettes: readonly Palette[],
  id: string,
  mode: Mode,
): Palette | undefined {
  const palette = palettes.find((p) => p.id === id);
  if (!palette || palette.mode === mode || !palette.pairId) return palette;
  const pair = palettes.find((p) => p.id === palette.pairId);
  return pair?.mode === mode ? pair : palette;
}
