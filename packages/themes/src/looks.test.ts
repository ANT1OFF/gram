import { describe, expect, it } from "vitest";

import { LOOK_IDS, LOOKS } from "./looks.ts";
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
});
