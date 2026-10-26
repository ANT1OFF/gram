import { describe, expect, it } from "vitest";

import {
  apcaContrast,
  composite,
  contrastRatio,
  ensureContrast,
  hexToOklch,
  minContrast,
  mix,
  normalizeHex,
  oklchToHex,
} from "./color.ts";
import { SEED_TOKEN_KEYS } from "./palette.ts";
import { PRESET_PALETTES } from "./presets.ts";

describe("normalizeHex", () => {
  it("expands short hex and lowercases", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex(" #1A1B26 ")).toBe("#1a1b26");
  });

  it("rejects non-hex input", () => {
    expect(() => normalizeHex("red")).toThrow();
    expect(() => normalizeHex("#12345")).toThrow();
  });
});

describe("OKLCH conversion", () => {
  it("round-trips every preset seed exactly", () => {
    for (const palette of PRESET_PALETTES) {
      for (const key of SEED_TOKEN_KEYS) {
        const hex = palette.seeds[key];
        expect(oklchToHex(hexToOklch(hex))).toBe(hex);
      }
    }
  });

  it("maps out-of-gamut colours back into sRGB", () => {
    expect(oklchToHex({ l: 0.7, c: 0.5, h: 150 })).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("contrast", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("matches the APCA reference values", () => {
    expect(apcaContrast("#000000", "#ffffff")).toBeCloseTo(106.04, 1);
    expect(apcaContrast("#ffffff", "#000000")).toBeCloseTo(-107.88, 1);
  });
});

describe("ensureContrast", () => {
  it("leaves passing colours alone", () => {
    expect(ensureContrast("#ffffff", ["#000000"], 4.5, "lighter")).toBe("#ffffff");
  });

  it("moves lightness only as far as needed", () => {
    const out = ensureContrast("#565f89", ["#16161e"], 4.5, "lighter");
    expect(minContrast(out, ["#16161e"])).toBeGreaterThanOrEqual(4.5);
    expect(minContrast(out, ["#16161e"])).toBeLessThan(4.7);
    // Hue survives up to 8-bit rounding.
    expect(Math.abs(hexToOklch(out).h - hexToOklch("#565f89").h)).toBeLessThan(2);
  });
});

describe("mix and composite", () => {
  it("returns the endpoints at 0 and 1", () => {
    expect(mix("#1a1b26", "#c0caf5", 0)).toBe("#1a1b26");
    expect(mix("#1a1b26", "#c0caf5", 1)).toBe("#c0caf5");
  });

  it("composites in sRGB", () => {
    expect(composite("#ffffff", 0.5, "#000000")).toBe("#808080");
  });
});
