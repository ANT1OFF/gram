import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PALETTE_DATA_COMMAND, paletteDataJson } from "./palette-data.ts";
import { SEMANTIC_COLOR_KEYS } from "./palette.ts";

const published = readFileSync(new URL("../palette.json", import.meta.url), "utf8");

describe("palette.json", () => {
  it("is the palette the sources derive", () => {
    expect(
      published === paletteDataJson(),
      `palette.json is out of date: run ${PALETTE_DATA_COMMAND}.`,
    ).toBe(true);
  });

  it("holds only #rrggbb colours, one for every semantic colour", () => {
    const data = JSON.parse(published) as Record<
      "light" | "dark",
      { colors: Record<string, string> }
    >;
    for (const mode of ["light", "dark"] as const) {
      expect(Object.keys(data[mode].colors)).toEqual([...SEMANTIC_COLOR_KEYS]);
      for (const colour of Object.values(data[mode].colors))
        expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
