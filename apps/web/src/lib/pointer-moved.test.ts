// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { pointerMovedFor, resetPointerMoves, trackPointerMoves } from "./pointer-moved";

/** A mouse event at (x, y), dispatched on the window as the browser would, stamped at `at`. */
const at = (type: string, x: number, y: number, stamp: number) => {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(event, "timeStamp", { value: stamp });
  window.dispatchEvent(event);
  return event;
};

describe("pointerMovedFor", () => {
  afterEach(resetPointerMoves);

  it("counts a hover the pointer moved into, and not one that came to a resting pointer", () => {
    trackPointerMoves();
    at("mousemove", 100, 40, 1_000);
    // The pointer arrives over a tab: its own move.
    at("mousemove", 140, 40, 1_016);
    expect(pointerMovedFor(at("mouseover", 140, 40, 1_017))).toBe(true);
    // Later the layout changes under it, a tab appearing where it rests: the browser says the
    // pointer is over the new tab, at the same spot.
    expect(pointerMovedFor(at("mouseover", 140, 40, 5_000))).toBe(false);
    // Moving within the tab is pointing at it.
    expect(pointerMovedFor(at("mousemove", 142, 41, 5_400))).toBe(true);
  });

  it("lets an event with no position through, and anything that isn't a mouse event", () => {
    expect(pointerMovedFor(new MouseEvent("mouseenter"))).toBe(true);
    expect(pointerMovedFor(new FocusEvent("focus"))).toBe(true);
    expect(pointerMovedFor(undefined)).toBe(true);
  });
});
