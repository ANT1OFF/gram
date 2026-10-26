import {
  DEFAULT_LOOK_ID,
  LOOK_IDS,
  LOOKS,
  type Easing,
  type Look,
  type LookId,
  type MotionPreset,
} from "./looks.ts";
import {
  ANSI_KEYS,
  derivePalette,
  resolvePalette,
  SEMANTIC_COLOR_KEYS,
  SEED_TOKEN_KEYS,
  type Contrast,
  type Mode,
  type Palette,
  type ResolvedPalette,
} from "./palette.ts";
import { DEFAULT_PALETTE_ID, PRESET_PALETTES } from "./presets.ts";

export type CssVariables = Record<`--${string}`, string>;

export function easingCss(easing: Easing): string {
  return easing.type === "bezier"
    ? `cubic-bezier(${easing.points.join(", ")})`
    : `steps(${easing.count}, ${easing.position})`;
}

const round = (v: number, digits = 3) => Number(v.toFixed(digits));

/**
 * Samples a spring's step response into a CSS `linear()` easing plus the time it takes to settle,
 * so CSS transitions can share the look's spring character.
 */
export function springToCss(spring: Extract<MotionPreset, { type: "spring" }>): {
  easing: string;
  duration: number;
} {
  const dt = 1 / 600;
  const samples: number[] = [];
  let x = 0;
  let v = 0;
  let t = 0;
  while (t < 3) {
    samples.push(x);
    const a = (-spring.stiffness * (x - 1) - spring.damping * v) / spring.mass;
    v += a * dt;
    x += v * dt;
    t += dt;
    if (Math.abs(x - 1) < 0.001 && Math.abs(v) < 0.01) break;
  }
  samples.push(1);
  const points = 24;
  const step = (samples.length - 1) / points;
  const stops = Array.from({ length: points + 1 }, (_, i) => round(samples[Math.round(i * step)]!));
  return { easing: `linear(${stops.join(", ")})`, duration: Math.round(t * 1000) };
}

function presetCss(preset: MotionPreset): { easing: string; duration: number } {
  return preset.type === "spring"
    ? springToCss(preset)
    : { easing: easingCss(preset.easing), duration: preset.duration };
}

/** Structural tokens for a look: type, shape, density, surface treatment, motion character. */
export function lookVariables(look: Look): CssVariables {
  const { surfaces, motion } = look;
  const spring = presetCss(motion.springs.gentle);
  return {
    "--font-ui": look.fonts.ui,
    "--font-display": look.fonts.display,
    "--font-mono": look.fonts.mono,
    "--font-label": look.fonts.label,
    "--radius-xs": `${look.radii.xs}px`,
    "--radius-sm": `${look.radii.sm}px`,
    "--radius-md": `${look.radii.md}px`,
    "--radius-lg": `${look.radii.lg}px`,
    "--radius-xl": `${look.radii.xl}px`,
    "--composer-radius": `${look.radii.composer}px`,
    "--row-compact": `${look.density.rowHeight.compact / 16}rem`,
    "--row-comfortable": `${look.density.rowHeight.comfortable / 16}rem`,
    "--space-row": `var(--row-${look.density.default})`,
    "--hairline": `${surfaces.hairline}px`,
    "--card-border-width": surfaces.treatment === "rule" ? "0px" : "var(--hairline)",
    "--rule-width": surfaces.treatment === "rule" ? "var(--hairline)" : "0px",
    "--shadow-raised": surfaces.shadowRaised,
    "--shadow-overlay": surfaces.shadowOverlay,
    "--surface-alpha": `${surfaces.alpha}`,
    "--surface-blur": `${surfaces.blur}px`,
    "--wash-strength": `${surfaces.wash}`,
    "--scanline-alpha": `${surfaces.scanline}`,
    "--icon-stroke": `${look.iconStroke}`,
    "--dur-fast-base": `${motion.durations.fast}ms`,
    "--dur-base-base": `${motion.durations.base}ms`,
    "--dur-slow-base": `${motion.durations.slow}ms`,
    "--dur-spring-base": `${spring.duration}ms`,
    "--ease-out": easingCss(motion.easing.out),
    "--ease-in-out": easingCss(motion.easing.inOut),
    "--ease-spring": spring.easing,
    "--stagger": `${motion.staggerMs}ms`,
  };
}

/** Colour tokens: seed primitives (`--p-*`), semantic colours, and the terminal set (`--ansi-*`). */
export function paletteVariables(resolved: ResolvedPalette): CssVariables {
  const vars: CssVariables = {};
  for (const key of SEED_TOKEN_KEYS) vars[`--p-${key}`] = resolved.palette.seeds[key];
  for (const key of SEMANTIC_COLOR_KEYS) vars[`--${key}`] = resolved.colors[key];
  for (const key of ANSI_KEYS) {
    vars[`--ansi-${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`] = resolved.ansi[key];
  }
  return vars;
}

export interface ThemeSelection {
  look: LookId;
  palette: string;
  mode: Mode;
  contrast: Contrast;
}

/** All custom properties for one look × palette × mode × contrast, after light/dark pairing. */
export function themeVariables(
  selection: ThemeSelection,
  palettes: readonly Palette[] = PRESET_PALETTES,
): CssVariables {
  const palette =
    resolvePalette(palettes, selection.palette, selection.mode) ??
    resolvePalette(PRESET_PALETTES, DEFAULT_PALETTE_ID, selection.mode)!;
  return {
    ...lookVariables(LOOKS[selection.look]),
    ...paletteVariables(derivePalette(palette, selection.contrast)),
  };
}

/** Matches the repo formatter (oxfmt), so generated files pass `bun run fmt:check` unchanged. */
const PRINT_WIDTH = 100;

function declaration(name: string, value: string): string {
  const line = `  ${name}: ${value};`;
  const call = /^([a-z-]+)\((.*)\)$/.exec(value);
  if (line.length <= PRINT_WIDTH || !call) return line;
  const args = call[2]!.split(", ").map((arg) => `    ${arg}`);
  return `  ${name}: ${call[1]}(\n${args.join(",\n")}\n  );`;
}

export function cssBlock(selectors: readonly string[], vars: CssVariables): string {
  const body = Object.entries(vars)
    .map(([name, value]) => declaration(name, value))
    .join("\n");
  return `${selectors.join(",\n")} {\n${body}\n}\n`;
}

function hiDpiBlock(look: Look, selectors: readonly string[]): string {
  if (look.surfaces.hairlineHiDpi === look.surfaces.hairline) return "";
  const block = cssBlock(selectors, { "--hairline": `${look.surfaces.hairlineHiDpi}px` });
  return `@media (min-resolution: 2dppx) {\n${block.replace(/^/gm, "  ").trimEnd()}\n}\n`;
}

/** A single `:root` block for one selection — for previews, snapshots and debugging. */
export function generateThemeCss(
  selection: ThemeSelection,
  palettes: readonly Palette[] = PRESET_PALETTES,
): string {
  const look = LOOKS[selection.look];
  return cssBlock([":root"], themeVariables(selection, palettes)) + hiDpiBlock(look, [":root"]);
}

/** The `[data-palette]` blocks for a palette at standard and more contrast. */
export function paletteCss(palette: Palette, { isDefault = false } = {}): string {
  const selector = `[data-palette="${palette.id}"]`;
  return (
    cssBlock(
      // A fallback must not override an explicit palette earlier in the stylesheet.
      isDefault ? [":where(:root)", selector] : [selector],
      paletteVariables(derivePalette(palette)),
    ) +
    cssBlock(
      [`${selector}[data-contrast="more"]`],
      paletteVariables(derivePalette(palette, "more")),
    )
  );
}

/**
 * The static stylesheet for every look and preset palette, keyed by the `data-look`,
 * `data-density`, `data-palette` and `data-contrast` attributes. The controller sets
 * `data-palette` to the already-paired palette, so mode needs no selector of its own.
 */
export function generateStylesheet(palettes: readonly Palette[] = PRESET_PALETTES): string {
  const parts = [
    "/* Generated by @gram/themes (generateStylesheet). Do not edit; regenerate with `bun run test -u`. */\n",
  ];
  for (const id of LOOK_IDS) {
    const look = LOOKS[id];
    const selectors =
      id === DEFAULT_LOOK_ID ? [":root", `[data-look="${id}"]`] : [`[data-look="${id}"]`];
    parts.push(cssBlock(selectors, lookVariables(look)), hiDpiBlock(look, [`[data-look="${id}"]`]));
  }
  parts.push(
    cssBlock(['[data-density="compact"]'], { "--space-row": "var(--row-compact)" }),
    cssBlock(['[data-density="comfortable"]'], { "--space-row": "var(--row-comfortable)" }),
  );
  for (const palette of palettes) {
    parts.push(paletteCss(palette, { isDefault: palette.id === DEFAULT_PALETTE_ID }));
  }
  return parts.filter(Boolean).join("\n");
}
