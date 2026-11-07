import { describe, expect, it } from "vitest";

import { clearRightEdge, type Box } from "./clear-of-cards";

const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

// A 1728 × 1095 window: the meter in the chat column's title bar, the right panel from 1000 px.
const base = {
  trigger: box(860, 8, 120, 28),
  width: 380,
  viewportWidth: 1728,
  viewportHeight: 1095,
};

describe("clearRightEdge", () => {
  it("keeps the popover under its trigger while no card is in the way", () => {
    expect(clearRightEdge({ ...base, cards: [] })).toBeUndefined();
    // A card in the column's left half, clear of the popover's span.
    expect(clearRightEdge({ ...base, cards: [box(200, 300, 350, 200)] })).toBeUndefined();
    // A card above the popover's top is no matter.
    expect(clearRightEdge({ ...base, cards: [box(700, 0, 300, 6)] })).toBeUndefined();
  });

  it("moves to the window's right edge, over the side panel, when the card is under the trigger", () => {
    const card = box(330, 330, 650, 220);
    expect(clearRightEdge({ ...base, cards: [card] })).toBe(1720);
  });

  it("moves to the left edge when the right is taken too, and stays put when nothing is clear", () => {
    const wide = box(500, 300, 1200, 200);
    expect(clearRightEdge({ ...base, cards: [wide] })).toBe(388);
    const everywhere = box(0, 300, 1728, 200);
    expect(clearRightEdge({ ...base, cards: [everywhere] })).toBeUndefined();
  });

  it("weighs the trigger's spot as the positioner keeps it on screen", () => {
    // A trigger at the window's left: the popover's right edge is pushed out to its width.
    const left = { ...base, trigger: box(10, 8, 28, 28) };
    expect(clearRightEdge({ ...left, cards: [box(300, 200, 50, 50)] })).toBe(1720);
    expect(clearRightEdge({ ...left, cards: [box(500, 200, 50, 50)] })).toBeUndefined();
  });
});
