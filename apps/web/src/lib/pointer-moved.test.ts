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

/** The same, dispatched on `target`, so it bubbles up from what the pointer is over. */
const over = (target: Element, type: string, x: number, y: number, stamp: number) => {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(event, "timeStamp", { value: stamp });
  target.dispatchEvent(event);
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

  it("reads a pointer event's fractional spot and its mouse twin's rounded one as the same", () => {
    trackPointerMoves();
    at("pointermove", 885.0078125, 58, 1_000);
    at("mousemove", 885, 58, 1_000);
    // A tab appears under the resting pointer: the browser sends pointerover at the fractional
    // spot and mouseover at the rounded one. Neither is a move.
    at("pointerover", 885.0078125, 58, 4_000);
    expect(pointerMovedFor(at("mouseover", 885, 58, 4_000))).toBe(false);
    // A move of under a pixel is one, though its mouse twin rounds to the same spot: a pointer
    // that clicked a button and then hovers what took its place, a hair over, points at it.
    at("pointermove", 885.5, 58.25, 4_400);
    expect(pointerMovedFor(at("mousemove", 885, 58, 4_400))).toBe(true);
  });

  it("doesn't count a click's own move for what the click makes appear under the pointer", () => {
    trackPointerMoves();
    const button = document.createElement("button");
    const tab = document.createElement("span");
    const glyph = document.createElement("svg");
    tab.append(glyph);
    document.body.append(button, tab);
    // The pointer moves onto a button and clicks it at once, as a quick hand or a test does.
    over(button, "pointermove", 140, 40, 1_000);
    // A frame later the click has opened a tab under the resting pointer: still within the move's
    // time, but the move was onto the button, not the tab.
    expect(pointerMovedFor(over(tab, "mouseover", 140, 40, 1_016), tab)).toBe(false);
    // Moving within the tab, onto its glyph, is pointing at it.
    over(glyph, "pointermove", 141, 40, 1_400);
    expect(pointerMovedFor(over(tab, "mouseover", 141, 40, 1_401), tab)).toBe(true);
    button.remove();
    tab.remove();
  });

  it("lets an event with no position through, and anything that isn't a mouse event", () => {
    expect(pointerMovedFor(new MouseEvent("mouseenter"))).toBe(true);
    expect(pointerMovedFor(new FocusEvent("focus"))).toBe(true);
    expect(pointerMovedFor(undefined)).toBe(true);
  });
});
