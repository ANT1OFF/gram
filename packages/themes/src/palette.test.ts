import { describe, expect, it } from "vitest";

import {
  ANSI_KEYS,
  derivePalette,
  paletteFromSeeds,
  SEED_TOKEN_KEYS,
  resolvePalette,
  SEMANTIC_COLOR_KEYS,
} from "./palette.ts";
import { PRESET_PALETTES } from "./presets.ts";

const HEX = /^#[0-9a-f]{6}$/;

describe("presets", () => {
  it("keeps the ten original presets first, then Minimal colourways and the six new pairs", () => {
    expect(PRESET_PALETTES.map((p) => p.id)).toEqual([
      "tokyo-night",
      "slate-dark",
      "tokyo-light",
      "dracula",
      "high-contrast",
      "night-owl",
      "catppuccin-latte",
      "catppuccin-frappe",
      "catppuccin-macchiato",
      "catppuccin-mocha",
      "minimal-ocean",
      "minimal-ocean-dark",
      "minimal-grape",
      "minimal-grape-dark",
      "minimal-forest",
      "minimal-forest-dark",
      "minimal-sunset",
      "minimal-sunset-dark",
      "minimal-vivid",
      "minimal-vivid-dark",
      "minimal-graphite",
      "minimal-graphite-dark",
      "neutral",
      "neutral-dark",
      "rose",
      "rose-dark",
      "forest",
      "forest-dark",
      "ocean",
      "ocean-dark",
      "ember",
      "ember-dark",
      "violet",
      "violet-dark",
    ]);
    for (const palette of PRESET_PALETTES) {
      expect(Object.keys(palette.seeds).toSorted()).toEqual(SEED_TOKEN_KEYS.toSorted());
      for (const hex of Object.values(palette.seeds)) expect(hex).toMatch(HEX);
    }
  });

  it("pairs light and dark variants symmetrically", () => {
    const pairs = PRESET_PALETTES.flatMap((p) => ("pairId" in p ? [[p.id, p.pairId]] : []));
    expect(pairs).toEqual([
      ["tokyo-night", "tokyo-light"],
      ["tokyo-light", "tokyo-night"],
      ["catppuccin-latte", "catppuccin-mocha"],
      ["catppuccin-mocha", "catppuccin-latte"],
      ["minimal-ocean", "minimal-ocean-dark"],
      ["minimal-ocean-dark", "minimal-ocean"],
      ["minimal-grape", "minimal-grape-dark"],
      ["minimal-grape-dark", "minimal-grape"],
      ["minimal-forest", "minimal-forest-dark"],
      ["minimal-forest-dark", "minimal-forest"],
      ["minimal-sunset", "minimal-sunset-dark"],
      ["minimal-sunset-dark", "minimal-sunset"],
      ["minimal-vivid", "minimal-vivid-dark"],
      ["minimal-vivid-dark", "minimal-vivid"],
      ["minimal-graphite", "minimal-graphite-dark"],
      ["minimal-graphite-dark", "minimal-graphite"],
      ["neutral", "neutral-dark"],
      ["neutral-dark", "neutral"],
      ["rose", "rose-dark"],
      ["rose-dark", "rose"],
      ["forest", "forest-dark"],
      ["forest-dark", "forest"],
      ["ocean", "ocean-dark"],
      ["ocean-dark", "ocean"],
      ["ember", "ember-dark"],
      ["ember-dark", "ember"],
      ["violet", "violet-dark"],
      ["violet-dark", "violet"],
    ]);
    for (const [id, pairId] of pairs) {
      const a = PRESET_PALETTES.find((p) => p.id === id)!;
      const b = PRESET_PALETTES.find((p) => p.id === pairId)!;
      expect(a.mode).not.toBe(b.mode);
    }
  });

  it("matches each preset's declared mode to its background", () => {
    for (const palette of PRESET_PALETTES) {
      expect(paletteFromSeeds(palette.seeds).mode).toBe(palette.mode);
    }
  });
});

describe("resolvePalette", () => {
  it("switches to the pair for the other mode", () => {
    expect(resolvePalette(PRESET_PALETTES, "tokyo-night", "light")?.id).toBe("tokyo-light");
    expect(resolvePalette(PRESET_PALETTES, "tokyo-light", "dark")?.id).toBe("tokyo-night");
    expect(resolvePalette(PRESET_PALETTES, "catppuccin-latte", "dark")?.id).toBe(
      "catppuccin-mocha",
    );
  });

  it("keeps single-mode palettes as they are", () => {
    expect(resolvePalette(PRESET_PALETTES, "dracula", "light")?.id).toBe("dracula");
    expect(resolvePalette(PRESET_PALETTES, "catppuccin-frappe", "light")?.id).toBe(
      "catppuccin-frappe",
    );
  });

  it("returns undefined for unknown ids", () => {
    expect(resolvePalette(PRESET_PALETTES, "nope", "dark")).toBeUndefined();
  });
});

describe("paletteFromSeeds", () => {
  const custom = {
    bg: "#FDF6E3",
    surface: "#eee8d5",
    text: "#586e75",
    muted: "#93a1a1",
    accent: "#268bd2",
    accent2: "#d33682",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    cyan: "#2aa198",
  };

  it("normalises seeds and infers the mode", () => {
    const palette = paletteFromSeeds(custom, {
      id: "custom:solarized",
      name: "Solarized",
    });
    expect(palette).toMatchObject({
      id: "custom:solarized",
      name: "Solarized",
      mode: "light",
    });
    expect(palette.seeds.bg).toBe("#fdf6e3");
  });

  it("rejects malformed tokens", () => {
    expect(() => paletteFromSeeds({ ...custom, accent: "blue" })).toThrow();
  });
});

describe("derivePalette", () => {
  it("emits every semantic colour and the full ANSI set as hex", () => {
    for (const palette of PRESET_PALETTES) {
      for (const contrast of ["standard", "more"] as const) {
        const resolved = derivePalette(palette, contrast);
        expect(Object.keys(resolved.colors)).toEqual([...SEMANTIC_COLOR_KEYS]);
        expect(Object.keys(resolved.ansi)).toEqual([...ANSI_KEYS]);
        for (const hex of [...Object.values(resolved.colors), ...Object.values(resolved.ansi)]) {
          expect(hex).toMatch(HEX);
        }
      }
    }
  });

  it("never alters the seeds", () => {
    for (const palette of PRESET_PALETTES) {
      const resolved = derivePalette(palette);
      expect(resolved.palette.seeds).toEqual(palette.seeds);
      expect(resolved.colors["surface-1"]).toBe(palette.seeds.surface);
      expect(resolved.colors["surface-2"]).toBe(palette.seeds.bg);
      expect(resolved.ansi.red).toBe(palette.seeds.red);
    }
  });
});
