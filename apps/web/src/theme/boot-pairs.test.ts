import { readFileSync } from "node:fs";

import { PRESET_PALETTES, type Palette } from "@gram/themes";
import { expect, it } from "vitest";

// index.html's inline boot script pairs a stored palette with the requested mode before any module
// loads, so it carries its own copy of the presets' pairs. This keeps that copy in step.
it("index.html's boot script pairs every preset dark palette with its light partner", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  // The object literal as written, trailing comma and all.
  const literal = html.match(/var lightOf = (\{[^}]*\});/)![1]!;
  const copy = new Function(`return ${literal}`)() as Record<string, string>;
  const pairs = Object.fromEntries(
    (PRESET_PALETTES as readonly Palette[]).flatMap((palette) =>
      palette.mode === "dark" && palette.pairId !== undefined ? [[palette.id, palette.pairId]] : [],
    ),
  );
  expect(copy).toEqual(pairs);
});
