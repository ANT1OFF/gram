import { PRESET_PALETTES } from "@gram/themes";
import { describe, expect, it } from "vitest";

import { contrastWarnings, customPaletteId, isHex, nameProblem } from "./palette-editor-model";

const LEGIBLE = {
  bg: "#000000",
  surface: "#111111",
  text: "#ffffff",
  muted: "#aaaaaa",
  accent: "#4cc2ff",
  accent2: "#e08bff",
  red: "#ff6168",
  green: "#5cff8f",
  yellow: "#ffd24c",
  cyan: "#4cf0ff",
};

describe("customPaletteId", () => {
  it("slugs the name and stays unique", () => {
    expect(customPaletteId("Night Shift!", new Set())).toBe("custom:night-shift");
    expect(customPaletteId("Night shift", new Set(["custom:night-shift"]))).toBe(
      "custom:night-shift-2",
    );
    expect(customPaletteId("✨", new Set())).toBe("custom:palette");
  });
});

describe("nameProblem", () => {
  it("requires a short, unused name", () => {
    expect(nameProblem("  ", PRESET_PALETTES)).toBe("Give the palette a name");
    expect(nameProblem("x".repeat(41), PRESET_PALETTES)).toBe("Keep the name under 40 characters");
    expect(nameProblem("dracula", PRESET_PALETTES)).toBe("“Dracula” already exists");
    expect(nameProblem("Dracula", PRESET_PALETTES, "dracula")).toBeUndefined();
    expect(nameProblem("Night shift", PRESET_PALETTES)).toBeUndefined();
  });
});

describe("contrastWarnings", () => {
  it("flags seed pairs below the WCAG floors", () => {
    expect(contrastWarnings(LEGIBLE)).toEqual([]);
    expect(contrastWarnings({ ...LEGIBLE, text: "#000000", muted: "#222222" })).toEqual([
      { label: "Text on background", ratio: 1, target: 4.5 },
      expect.objectContaining({ label: "Text on panels", target: 4.5 }),
      expect.objectContaining({ label: "Dim text on background", target: 3 }),
    ]);
  });
});

describe("isHex", () => {
  it("accepts 3- and 6-digit hex only", () => {
    expect(isHex("#abc")).toBe(true);
    expect(isHex("#A1B2C3")).toBe(true);
    expect(isHex("abc")).toBe(false);
    expect(isHex("#abcd")).toBe(false);
  });
});
