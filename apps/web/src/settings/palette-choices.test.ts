import { paletteFromSeeds, PRESET_PALETTES } from "@gram/themes";
import { describe, expect, it } from "vitest";

import { FEATURED_PALETTES, paletteChoices } from "./palette-choices";

describe("paletteChoices", () => {
  it("offers one card per featured light/dark pair, under the family name", () => {
    const choices = paletteChoices("neutral-dark", []);
    expect(choices.map((c) => c.name)).toEqual(FEATURED_PALETTES.map((f) => f.name));
    expect(choices[0]).toMatchObject({ id: "neutral-dark", ids: ["neutral", "neutral-dark"] });
    for (const choice of choices) {
      expect(choice.ids).toHaveLength(2);
      expect(choice.note).toBeUndefined();
    }
  });

  it("names only presets that exist", () => {
    const ids = new Set<string>(PRESET_PALETTES.map((p) => p.id));
    expect(FEATURED_PALETTES.filter((f) => !ids.has(f.id))).toEqual([]);
  });

  it("keeps a hidden preset and the user's own palettes on show", () => {
    const mine = paletteFromSeeds(PRESET_PALETTES[3]!.seeds, { id: "custom:mine", name: "Mine" });
    const choices = paletteChoices("dracula", [mine]);
    expect(choices.slice(-2)).toMatchObject([
      { id: "dracula", name: "Dracula", note: "dark only" },
      { id: "custom:mine", name: "Mine" },
    ]);
    expect(paletteChoices("tokyo-light", []).map((c) => c.id)).not.toContain("tokyo-light");
  });
});
