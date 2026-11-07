import { describe, expect, it } from "vitest";

import { sameLayout, toolbarLayout, type ToolbarBlock, type ToolbarLayout } from "./toolbar-layout";

/** Model · effort · mode · speed, as the toolbar orders them; speed's one word is its only one. */
const BLOCKS: readonly ToolbarBlock[] = [
  { id: "model", full: 120, short: 70, icon: 40, foldable: false },
  { id: "effort", full: 110, short: 70, icon: 44, foldable: true },
  { id: "mode", full: 80, short: 60, icon: 44, foldable: true },
  { id: "speed", full: 32, short: 32, icon: 32, foldable: true },
];
const OVERFLOW = 32;

/** Each block's size in toolbar order, what folded, and whether the blocks have their own row. */
const shape = (layout: ToolbarLayout) => ({
  sizes: BLOCKS.filter((block) => !layout.folded.includes(block.id)).map(
    (block) => layout.sizes.get(block.id) ?? "full",
  ),
  folded: layout.folded,
  wrapped: layout.wrapped,
});

const at = (space: number, room = 0, row?: number) =>
  shape(toolbarLayout(space, BLOCKS, OVERFLOW, room, row));

const FULL = ["full", "full", "full", "full"];
const SHORT = ["short", "short", "short", "short"];
const ICONS = ["icon", "icon", "icon", "icon"];

describe("toolbarLayout", () => {
  it("says every value in full when everything fits", () => {
    expect(at(342)).toEqual({ sizes: FULL, folded: [], wrapped: false });
  });

  it("takes compact words from the right first, one at a time", () => {
    // Speed's one word is as wide either way, so mode is the first to change.
    expect(at(341).sizes).toEqual(["full", "full", "short", "short"]);
    expect(at(322).sizes).toEqual(["full", "full", "short", "short"]);
    expect(at(321).sizes).toEqual(["full", "short", "short", "short"]);
    expect(at(281).sizes).toEqual(SHORT);
    expect(at(232).sizes).toEqual(SHORT);
  });

  it("drops to glyphs only past the compact words, from the right", () => {
    expect(at(231).sizes).toEqual(["short", "short", "icon", "icon"]);
    // 70 + 44 + 44 + 32 = 190.
    expect(at(190).sizes).toEqual(["short", "icon", "icon", "icon"]);
    expect(at(189).sizes).toEqual(ICONS);
    expect(at(160)).toEqual({ sizes: ICONS, folded: [], wrapped: false });
  });

  it("folds from the right once every word is gone, leaving room for the … button", () => {
    // Folding speed frees 32 but the … button takes 32; folding mode too frees 44 more.
    expect(at(159)).toEqual({ sizes: ["icon", "icon"], folded: ["mode", "speed"], wrapped: false });
    expect(at(10)).toEqual({
      sizes: ["icon"],
      folded: ["effort", "mode", "speed"],
      wrapped: false,
    });
  });

  it("keeps room free beside words, and none for glyphs alone", () => {
    expect(at(362, 20).sizes).toEqual(FULL);
    expect(at(361, 20).sizes).toEqual(["full", "full", "short", "short"]);
    expect(at(252, 20).sizes).toEqual(SHORT);
    expect(at(160, 20).sizes).toEqual(ICONS);
  });

  it("moves the pickers to a row of their own before giving up their words", () => {
    // Too narrow for compact words beside Send (232 + 20), but a row of their own holds them all.
    expect(at(200, 20, 400)).toEqual({ sizes: FULL, folded: [], wrapped: true });
    expect(at(200, 20, 300)).toEqual({
      sizes: ["full", "short", "short", "short"],
      folded: [],
      wrapped: true,
    });
    expect(at(200, 20, 232)).toEqual({ sizes: SHORT, folded: [], wrapped: true });
  });

  it("stays on one row, as glyphs, when even a row of their own can't hold the compact words", () => {
    expect(at(200, 20, 231)).toEqual({ sizes: ICONS, folded: [], wrapped: false });
  });

  it("prefers compact words on one row to a second row", () => {
    expect(at(260, 20, 400)).toEqual({ sizes: SHORT, folded: [], wrapped: false });
  });

  // The narrow composer showed "Effort" and "Speed" with no value (round 12, 124): tighter than
  // compact words, a picker keeps its value alone beside its glyph before it gives up its words.
  describe("with values alone narrower than compact words", () => {
    const VALUED: readonly ToolbarBlock[] = BLOCKS.map((block) =>
      block.id === "effort"
        ? { ...block, value: 54 }
        : block.id === "mode"
          ? { ...block, value: 50 }
          : block,
    );
    const fit = (space: number, room = 0, row?: number) => {
      const layout = toolbarLayout(space, VALUED, OVERFLOW, room, row);
      return {
        sizes: VALUED.map((block) => layout.sizes.get(block.id) ?? "full"),
        wrapped: layout.wrapped,
      };
    };

    it("keeps values alone on one row, from the right, before any glyph", () => {
      // Compact words take 70 + 70 + 60 + 32 = 232; speed's one word is its value already, so
      // mode's value alone is the first to free room, 10.
      expect(fit(232).sizes).toEqual(SHORT);
      expect(fit(231).sizes).toEqual(["short", "short", "value", "short"]);
      // 70 + 54 + 50 + 32 = 206; the model's short name is its value, so it keeps it.
      expect(fit(206).sizes).toEqual(["short", "value", "value", "short"]);
      // Past that, glyphs from the right, the blocks before them keeping their values:
      // 70 + 54 + 44 + 32 = 200.
      expect(fit(205).sizes).toEqual(["short", "value", "icon", "icon"]);
    });

    it("keeps values alone on a row of their own before dropping to glyphs on one", () => {
      expect(fit(200, 20, 232)).toEqual({ sizes: SHORT, wrapped: true });
      expect(fit(200, 20, 231)).toEqual({
        sizes: ["short", "short", "value", "short"],
        wrapped: true,
      });
      // Short of even that, one row: words there keep 20 free beside them, so glyphs alone.
      expect(fit(200, 20, 205)).toEqual({ sizes: ICONS, wrapped: false });
    });
  });

  it("treats layouts that render the same as the same", () => {
    const a = toolbarLayout(200, BLOCKS, OVERFLOW);
    expect(sameLayout(a, toolbarLayout(200, BLOCKS, OVERFLOW))).toBe(true);
    expect(sameLayout(a, toolbarLayout(1000, BLOCKS, OVERFLOW))).toBe(false);
    expect(sameLayout(a, toolbarLayout(120, BLOCKS, OVERFLOW))).toBe(false);
    expect(sameLayout(a, toolbarLayout(200, BLOCKS, OVERFLOW, 0, 400))).toBe(false);
  });
});
