import { describe, expect, it } from "vitest";

import { composite, contrastRatio } from "./color.ts";
import { derivePalette } from "./palette.ts";
import { PRESET_PALETTES } from "./presets.ts";
import {
  backdropLevels,
  SCENE_IDS,
  SCENE_SCRIM,
  scenePixels,
  sceneSvg,
  SURFACE_OPACITY,
  SURFACES_IDS,
} from "./scenes.ts";

describe("scenes", () => {
  it("lets no caller's text into the markup", () => {
    expect(sceneSvg("<img src=x onerror=alert(1)>" as never, false)).toBe("");
    const svg = sceneSvg("fjord", false, '"><script>alert(1)</script>');
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("alert(1)");
    expect(svg).toContain('id="scriptalert1scriptsky"');
  });

  it("draws a dawn and a night version of every scene", () => {
    for (const id of SCENE_IDS) {
      expect(sceneSvg(id, false)).toMatch(/^<svg /);
      expect(sceneSvg(id, true)).not.toBe(sceneSvg(id, false));
    }
  });

  // Text over a picture, on the page itself and on cards at every surface setting, against every
  // pixel of every scene, in every palette, at the levels the palette gets.
  it.each(PRESET_PALETTES.map((palette) => [palette.id, palette] as const))(
    "keeps text at the contrast target over every scene in %s",
    (_, palette) => {
      const { colors } = derivePalette(palette);
      const failures: string[] = [];
      for (const scene of SCENE_IDS) {
        const pixels = scenePixels(sceneSvg(scene, palette.mode === "dark"));
        for (const surfaces of SURFACES_IDS) {
          const { scrim, alpha } = backdropLevels(colors, palette.mode, scene, surfaces);
          for (const pixel of pixels) {
            const page = composite(colors["surface-2"], scrim, pixel);
            // Cards are surface-3; the sidebar and title bar are surface-1. Both take the opacity.
            const card = composite(colors["surface-3"], alpha, page);
            const chrome = composite(colors["surface-1"], alpha, page);
            for (const key of ["fg", "fg-muted"] as const)
              if (contrastRatio(colors[key], page) < 4.5) failures.push(`${scene} page ${key}`);
            for (const key of [
              "fg",
              "fg-muted",
              "fg-subtle",
              "accent-text",
              "danger-text",
            ] as const)
              for (const [where, under] of [
                ["card", card],
                ["chrome", chrome],
              ] as const)
                if (contrastRatio(colors[key], under) < 4.5)
                  failures.push(`${scene} ${surfaces} ${where} ${key}`);
          }
        }
      }
      expect([...new Set(failures)]).toEqual([]);
    },
  );

  it("never washes or thickens less than the levels asked for", () => {
    const { colors } = derivePalette(PRESET_PALETTES.find((p) => p.id === "petrol")!);
    for (const scene of SCENE_IDS) {
      const { scrim, alpha } = backdropLevels(colors, "light", scene, "clear");
      expect(scrim).toBeGreaterThanOrEqual(SCENE_SCRIM.light);
      expect(alpha).toBeGreaterThanOrEqual(SURFACE_OPACITY.clear);
    }
  });
});
