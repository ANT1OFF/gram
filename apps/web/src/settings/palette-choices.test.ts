import { paletteFromSeeds, PRESET_PALETTES } from "@gram/themes";
import { describe, expect, it } from "vitest";

import { paletteToRender } from "@/theme/look-defaults";

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

  it.each(["petrol", "petrol-dark"])("keeps saved %s available only while selected", (id) => {
    expect(paletteChoices("neutral-dark", []).some((choice) => choice.ids.includes(id))).toBe(
      false,
    );
    const saved = paletteChoices(id, []).filter((choice) => choice.ids.includes(id));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.ids).toEqual(["petrol", "petrol-dark"]);
  });

  it.each([undefined, "ocean-dark", "ocean", "petrol-dark"])(
    "renders the palette of each card picked, with the app's default palette %s",
    (appDefault) => {
      const defaults = appDefault ? { palette: appDefault } : undefined;
      for (const active of ["neutral-dark", "neutral", "ocean-dark", "dracula"]) {
        const choices = paletteChoices(active, [], undefined, appDefault);
        expect(new Set(choices.map((c) => c.name)).size).toBe(choices.length);
        for (const choice of choices) {
          for (const picked of choice.ids) {
            expect(choice.ids).toContain(paletteToRender(picked, undefined, defaults));
          }
        }
      }
    },
  );

  it("offers an app's default palette in the place of Gram's default pair", () => {
    const choices = paletteChoices("neutral-dark", [], undefined, "ocean-dark");
    expect(choices[0]).toMatchObject({ name: "Ocean", ids: ["ocean", "ocean-dark"] });
    expect(choices.map((c) => c.name)).not.toContain("Neutral");
    expect(paletteChoices("neutral-dark", [], undefined, "petrol-dark")[0]?.name).toBe("Petrol");
  });
});
