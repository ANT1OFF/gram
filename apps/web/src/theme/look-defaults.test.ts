import { PRESET_PALETTES, type Palette } from "@gram/themes";
import { afterEach, describe, expect, it } from "vitest";

import { lookCss, renderedPalette } from "./backdrop";
import {
  effectivePrefs,
  installLookDefaults,
  lookDefaults,
  paletteToRender,
} from "./look-defaults";
import { DEFAULT_THEME } from "./theme";

const presets: readonly Palette[] = PRESET_PALETTES;

const attrs = (palette: string, backdrop = "off", surfaces = "solid") => ({
  "data-palette": palette,
  "data-backdrop": backdrop,
  "data-surfaces": surfaces,
});

describe("the embedding app's defaults", () => {
  afterEach(() => installLookDefaults(undefined));

  it("stand in for Gram's default palette until the person picks one", () => {
    const defaults = { palette: "petrol-dark" };
    expect(paletteToRender("neutral-dark", undefined, defaults)).toBe("petrol-dark");
    expect(paletteToRender("neutral", undefined, defaults)).toBe("petrol-dark");
    expect(paletteToRender("dracula", undefined, defaults)).toBe("dracula");
  });

  it("give way to a host theme's palette, which holds as before", () => {
    const host = { palettes: { dark: PRESET_PALETTES.find((p) => p.id === "rose-dark")!.seeds } };
    expect(paletteToRender("neutral-dark", host, { palette: "petrol-dark" })).toBe("host-dark");
  });

  it("fill only the parts the person hasn't chosen", () => {
    const defaults = { accent: "petrol", sidebar: "inset", backdrop: "fjord" } as const;
    const prefs = effectivePrefs({ ...DEFAULT_THEME, sidebar: "flush" }, undefined, defaults);
    expect(prefs).toMatchObject({ accent: "petrol", sidebar: "flush", backdrop: "fjord" });
  });

  it("ignore a palette that isn't built in", () => {
    installLookDefaults({ palette: "#123456", sidebar: "inset" });
    expect(lookDefaults()).toEqual({ sidebar: "inset" });
  });
});

describe("the look's run-time stylesheet", () => {
  it("writes nothing for a plain palette with no picture", () => {
    expect(lookCss(attrs("petrol"), presets)).toBe("");
  });

  it("writes the accented palette's block, built from the chosen palette's seeds", () => {
    expect(renderedPalette(attrs("neutral~forest"), presets)?.seeds.accent).toBe("#1f5c3e");
    expect(lookCss(attrs("neutral~forest"), presets)).toContain('[data-palette="neutral~forest"]');
  });

  it("clears the page and makes surfaces see-through over a picture", () => {
    const css = lookCss(attrs("petrol", "fjord", "clear"), presets);
    expect(css).toContain(':root[data-backdrop="fjord"]');
    expect(css).toContain("--thread-bg: transparent");
    expect(css).toContain("--surface-alpha: 0.62");
    expect(css).toContain("--backdrop-scrim: rgba(243, 241, 236, 0.6)");
  });
});
