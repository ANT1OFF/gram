import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { CHEVRON } from "./use-toolbar-layout";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// The toolbar's layout counts a trigger's chevron as a constant it can't measure while it isn't
// drawn. A chevron of another size makes its full and short estimates disagree with what is drawn,
// and the row flips between them until React stops it ("Maximum update depth exceeded").
it("draws the toolbar triggers' chevrons at the size the layout counts", () => {
  expect(CHEVRON).toBe(14 + 6);
  for (const file of ["./model-picker.tsx", "../components/ui/select.tsx"]) {
    const drawn = source(file).match(/<ChevronDownIcon[^>]*className="[^"]*"/g) ?? [];
    expect(drawn.length, file).toBeGreaterThan(0);
    for (const each of drawn) expect(each, file).toContain("size-icon-chip");
  }
});
