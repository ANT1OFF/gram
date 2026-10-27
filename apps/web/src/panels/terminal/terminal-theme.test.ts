import { PRESET_PALETTES } from "@gram/themes";
import { describe, expect, it } from "vitest";

import { terminalSearchColors } from "./terminal-theme";

const system = { prefersDark: false, prefersReducedMotion: false, prefersMoreContrast: false };

describe("terminal find highlights", () => {
  // e2e paints one palette's highlights; every preset in both modes keeps the two apart here.
  it.each(PRESET_PALETTES.map((palette) => palette.id))(
    "%s tells the active match from the others in light and dark",
    (palette) => {
      for (const mode of ["light", "dark"] as const) {
        const colors = terminalSearchColors({ palette, mode, contrast: "system" }, [], system);
        expect(colors.match, `${palette} ${mode}`).not.toBe(colors.activeMatch);
        expect(colors.activeMatchBorder, `${palette} ${mode}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    },
  );
});
