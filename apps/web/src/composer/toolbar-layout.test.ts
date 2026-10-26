import { describe, expect, it } from "vitest";

import { sameLayout, toolbarLayout, type ToolbarBlock } from "./toolbar-layout";

const BLOCKS: readonly ToolbarBlock[] = [
  { id: "model", full: 120, icon: 40, foldable: false },
  { id: "steer", full: 32, icon: 32, foldable: true },
  { id: "effort", full: 110, icon: 44, foldable: true },
  { id: "mode", full: 80, icon: 44, foldable: true },
];
const OVERFLOW = 32;

const at = (space: number) => {
  const layout = toolbarLayout(space, BLOCKS, OVERFLOW);
  return { labelled: [...layout.labelled].toSorted(), folded: layout.folded };
};

describe("toolbarLayout", () => {
  it("keeps every label when everything fits", () => {
    expect(at(342)).toEqual({ labelled: ["effort", "mode", "model"], folded: [] });
  });

  it("drops labels from the right first, one at a time", () => {
    expect(at(341)).toEqual({ labelled: ["effort", "model"], folded: [] });
    expect(at(306)).toEqual({ labelled: ["effort", "model"], folded: [] });
    expect(at(305)).toEqual({ labelled: ["model"], folded: [] });
    expect(at(239)).toEqual({ labelled: [], folded: [] });
  });

  it("folds from the right once every label is gone, leaving room for the … button", () => {
    // Glyphs alone: 40 + 32 + 44 + 44 = 160.
    expect(at(160)).toEqual({ labelled: [], folded: [] });
    // Folding mode frees 44 but the … button takes 32: 148.
    expect(at(159)).toEqual({ labelled: [], folded: ["mode"] });
    expect(at(147)).toEqual({ labelled: [], folded: ["effort", "mode"] });
    expect(at(103)).toEqual({ labelled: [], folded: ["steer", "effort", "mode"] });
  });

  it("never folds the model picker, and settles on the narrowest when nothing fits", () => {
    expect(at(10)).toEqual({ labelled: [], folded: ["steer", "effort", "mode"] });
  });

  it("gives no label to a block without one", () => {
    expect(toolbarLayout(1000, BLOCKS, OVERFLOW).labelled.has("steer")).toBe(false);
  });

  it("treats layouts that render the same as the same", () => {
    const a = toolbarLayout(200, BLOCKS, OVERFLOW);
    expect(sameLayout(a, toolbarLayout(200, BLOCKS, OVERFLOW))).toBe(true);
    expect(sameLayout(a, toolbarLayout(1000, BLOCKS, OVERFLOW))).toBe(false);
    expect(sameLayout(a, toolbarLayout(120, BLOCKS, OVERFLOW))).toBe(false);
  });
});
