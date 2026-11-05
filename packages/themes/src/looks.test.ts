import { describe, expect, it } from "vitest";

import { LOOK_IDS, LOOKS, TYPE_STEPS } from "./looks.ts";
import { MIN_SURFACE_ALPHA } from "./palette.ts";

const range = (id: (typeof LOOK_IDS)[number]) => {
  const { fast, slow } = LOOKS[id].motion.durations;
  return [fast, slow];
};

describe("looks", () => {
  it("defines Glass as the only look", () => {
    expect(LOOK_IDS).toEqual(["glass"]);
    for (const id of LOOK_IDS) expect(LOOKS[id].id).toBe(id);
  });

  it("keeps chrome at least as opaque as palette derivation assumes", () => {
    for (const id of LOOK_IDS) {
      expect(LOOKS[id].surfaces.alpha).toBeGreaterThanOrEqual(MIN_SURFACE_ALPHA);
      expect(LOOKS[id].surfaces.alpha).toBeLessThanOrEqual(1);
    }
  });

  it("matches Glass's motion character", () => {
    expect(range("glass")).toEqual([220, 320]);
  });

  it("keeps Glass's typography", () => {
    expect(LOOKS.glass.fonts.ui).toContain("Inter Variable");
  });

  it("keeps the type scale ascending, readable and on the 4 px grid", () => {
    for (const id of LOOK_IDS) {
      const sizes = TYPE_STEPS.map((step) => LOOKS[id].type[step].size);
      expect(sizes).toEqual(sizes.toSorted((a, b) => a - b));
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11);
      for (const step of TYPE_STEPS) {
        const { size, lineHeight } = LOOKS[id].type[step];
        expect(lineHeight % 4, step).toBe(0);
        expect(lineHeight, step).toBeGreaterThan(size);
      }
    }
  });

  it("keeps each step apart from the next, and metadata a step above caption", () => {
    for (const id of LOOK_IDS) {
      const { type } = LOOKS[id];
      // Body-strong is body at a heavier weight; every other step is a size of its own.
      const sizes = TYPE_STEPS.filter((step) => step !== "body-strong").map((s) => type[s].size);
      for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]!);
      expect(type.meta.size - type.caption.size).toBeGreaterThanOrEqual(2);
      expect(type.title.size - type.reading.size).toBeGreaterThanOrEqual(2);
    }
  });
});
