import { describe, expect, it } from "vitest";

import { generateStylesheet, generateThemeCss, springToCss, themeVariables } from "./css.ts";
import { LOOK_IDS, LOOKS } from "./looks.ts";
import { PRESET_PALETTES } from "./presets.ts";

describe("generateThemeCss", () => {
  it.each(LOOK_IDS)("matches the snapshot for %s", async (look) => {
    const css = generateThemeCss({
      look,
      palette: "tokyo-night",
      mode: "dark",
      contrast: "standard",
    });
    await expect(css).toMatchFileSnapshot(`./__snapshots__/look-${look}.css`);
  });

  it("never emits empty or non-finite values", () => {
    for (const look of LOOK_IDS) {
      const vars = themeVariables({
        look,
        palette: "catppuccin-latte",
        mode: "light",
        contrast: "more",
      });
      for (const [name, value] of Object.entries(vars)) {
        expect(value, name).not.toMatch(/undefined|NaN|Infinity|^$/);
      }
    }
  });

  it("falls back to the default palette for unknown ids", () => {
    const vars = themeVariables({
      look: "glass",
      palette: "gone",
      mode: "dark",
      contrast: "standard",
    });
    expect(vars["--p-bg"]).toBe("#0a0a0a");
  });
});

describe("generateStylesheet", () => {
  const css = generateStylesheet();

  it("covers every look, density and palette selector", () => {
    for (const look of LOOK_IDS) expect(css).toContain(`[data-look="${look}"] {`);
    expect(css).toContain('[data-density="compact"]');
    expect(css).toContain('[data-density="comfortable"]');
    for (const palette of PRESET_PALETTES) {
      expect(css).toContain(`[data-palette="${palette.id}"] {`);
      expect(css).toContain(`[data-palette="${palette.id}"][data-contrast="more"] {`);
    }
  });

  it("makes Glass and Neutral Dark the root defaults without overriding saved palettes", () => {
    expect(css).toContain(':root,\n[data-look="glass"] {');
    expect(css).toContain(':where(:root),\n[data-palette="neutral-dark"] {');
    expect(css).not.toContain(':root,\n[data-palette="tokyo-night"] {');
  });
});

describe("springToCss", () => {
  it("samples from 0 to 1 and settles in a sensible time", () => {
    const preset = LOOKS.glass.motion.springs.gentle;
    if (preset.type !== "spring") throw new Error("expected a spring");
    const { easing, duration } = springToCss(preset);
    expect(easing).toMatch(/^linear\(0, .*, 1\)$/);
    expect(duration).toBeGreaterThan(100);
    expect(duration).toBeLessThan(1000);
  });
});
