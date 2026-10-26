import {
  CONTRAST_TARGETS,
  contrastRatio,
  DEFAULT_PALETTE_ID,
  paletteFromSeeds,
  type SeedTokenKey,
  type SeedTokens,
  type Palette,
} from "@gram/themes";

/** What each palette seed colours. */
export const TOKEN_LABELS: Record<SeedTokenKey, { label: string; hint: string }> = {
  bg: { label: "Background", hint: "App and terminal background" },
  surface: { label: "Panels", hint: "Sidebar, cards and raised surfaces" },
  text: { label: "Text", hint: "Primary text and terminal foreground" },
  muted: { label: "Dim text", hint: "Secondary text, hints and borders" },
  accent: { label: "Accent", hint: "Buttons, links and focus" },
  accent2: { label: "Highlight", hint: "Worktree tags and section labels" },
  red: { label: "Errors", hint: "Danger actions and diff removals" },
  green: { label: "Success", hint: "Success states and diff additions" },
  yellow: { label: "Attention", hint: "The needs-you indicator" },
  cyan: { label: "Info", hint: "Info states and terminal cyan" },
};

export const isHex = (value: string): boolean => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());

/** The palette `id` names, else the default preset, else the first one. */
export const findPalette = (palettes: readonly Palette[], id: string): Palette | undefined =>
  palettes.find((p) => p.id === id) ??
  palettes.find((p) => p.id === DEFAULT_PALETTE_ID) ??
  palettes[0];

/** A custom palette id from its name, unique among `taken`. */
export function customPaletteId(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "palette";
  let id = `custom:${slug}`;
  for (let n = 2; taken.has(id); n++) id = `custom:${slug}-${n}`;
  return id;
}

/** Why `name` can't be used, or `undefined`. The palette being edited may keep its own name. */
export function nameProblem(
  name: string,
  palettes: readonly Palette[],
  editingId?: string,
): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Give the palette a name";
  if (trimmed.length > 40) return "Keep the name under 40 characters";
  const clash = palettes.find(
    (p) => p.id !== editingId && p.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  return clash ? `“${clash.name}” already exists` : undefined;
}

export interface ContrastWarning {
  readonly label: string;
  readonly ratio: number;
  readonly target: number;
}

const PAIRS: ReadonlyArray<{
  fg: SeedTokenKey;
  bg: SeedTokenKey;
  label: string;
  kind: "text" | "ui";
}> = [
  { fg: "text", bg: "bg", label: "Text on background", kind: "text" },
  { fg: "text", bg: "surface", label: "Text on panels", kind: "text" },
  { fg: "muted", bg: "bg", label: "Dim text on background", kind: "ui" },
  { fg: "accent", bg: "bg", label: "Accent on background", kind: "ui" },
  { fg: "red", bg: "bg", label: "Errors on background", kind: "ui" },
  { fg: "green", bg: "bg", label: "Success on background", kind: "ui" },
  { fg: "yellow", bg: "bg", label: "Attention on background", kind: "ui" },
];

/**
 * Seed pairs below the WCAG floors. Derived tokens are shifted until they pass, so these only
 * warn that the rendered colours will differ from the chosen ones.
 */
export const contrastWarnings = (seeds: SeedTokens): ContrastWarning[] =>
  PAIRS.flatMap(({ fg, bg, label, kind }) => {
    const target = CONTRAST_TARGETS.standard[kind];
    const ratio = contrastRatio(seeds[fg], seeds[bg]);
    return ratio < target ? [{ label, ratio, target }] : [];
  });

export const buildPalette = (id: string, name: string, seeds: SeedTokens): Palette =>
  paletteFromSeeds(seeds, { id, name: name.trim() });
