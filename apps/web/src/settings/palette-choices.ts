import { PRESET_PALETTES, type Palette } from "@gram/themes";

/** One card in the Appearance palette picker: a light/dark pair, or a palette of one mode. */
export interface PaletteChoice {
  /** The palette chosen; pairing renders its partner when the other mode is requested. */
  readonly id: string;
  /** Every palette id the card stands for, light first, so either half of a pair shows it selected. */
  readonly ids: readonly string[];
  readonly name: string;
  readonly swatch: readonly string[];
  /** Under the name, for a palette that can't follow Mode. */
  readonly note?: string;
}

/**
 * The presets the picker offers, one per light/dark pair, under the family's own name. The rest
 * stay built in, so a saved choice keeps rendering, and show only while chosen.
 */
export const FEATURED_PALETTES: readonly { readonly id: string; readonly name: string }[] = [
  { id: "neutral-dark", name: "Neutral" },
  { id: "minimal-graphite-dark", name: "Graphite" },
  { id: "ocean-dark", name: "Ocean" },
  { id: "forest-dark", name: "Forest" },
  { id: "rose-dark", name: "Rose" },
  { id: "ember-dark", name: "Ember" },
  { id: "violet-dark", name: "Violet" },
  { id: "tokyo-night", name: "Tokyo" },
  { id: "catppuccin-mocha", name: "Catppuccin" },
];

const byId = (palettes: readonly Palette[], id: string | undefined) =>
  id === undefined ? undefined : palettes.find((p) => p.id === id);

function choiceOf(palette: Palette, palettes: readonly Palette[], name = palette.name) {
  const pair = byId(palettes, palette.pairId);
  const halves = !pair ? [palette] : palette.mode === "light" ? [palette, pair] : [pair, palette];
  const swatch = halves.flatMap(({ seeds }) =>
    pair
      ? [seeds.bg, seeds.accent, seeds.accent2, seeds.green]
      : [
          seeds.bg,
          seeds.surface,
          seeds.text,
          seeds.accent,
          seeds.accent2,
          seeds.green,
          seeds.yellow,
          seeds.red,
        ],
  );
  return {
    id: palette.id,
    ids: halves.map((p) => p.id),
    name,
    swatch,
    ...(pair ? {} : { note: `${palette.mode} only` }),
  } satisfies PaletteChoice;
}

/**
 * The picker's cards: the featured pairs, then the user's own palettes, with the active preset
 * added when it isn't one of the featured.
 */
export function paletteChoices(
  activeId: string,
  customPalettes: readonly Palette[],
): PaletteChoice[] {
  const palettes = [...PRESET_PALETTES, ...customPalettes];
  const featured = FEATURED_PALETTES.flatMap(({ id, name }) => {
    const palette = byId(palettes, id);
    return palette ? [choiceOf(palette, palettes, name)] : [];
  });
  const covered = new Set(featured.flatMap((c) => c.ids));
  const active = byId(PRESET_PALETTES, activeId);
  const extra = active && !covered.has(active.id) ? [choiceOf(active, palettes)] : [];
  return [...featured, ...extra, ...customPalettes.map((p) => choiceOf(p, palettes))];
}
