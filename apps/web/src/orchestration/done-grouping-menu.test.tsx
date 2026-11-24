// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLayoutStore } from "@/stores/layout";

import { DoneGroupingMenu } from "./done-grouping-menu";

// The menu's own trigger opens on the pointer going down, from the next animation frame, and lets
// the click after it go by. A page busy enough to hold that frame back showed nothing for the
// press, so the click opens it too.

/** A pointer's press as a browser sends it: down, up, then the click. */
const press = (element: HTMLElement) => {
  fireEvent.pointerDown(element, { button: 0, pointerType: "mouse" });
  fireEvent.mouseDown(element, { button: 0 });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse" });
  fireEvent.mouseUp(element, { button: 0 });
  fireEvent.click(element, { button: 0 });
};

const menu = () => screen.queryByTestId("done-grouping-menu");
const trigger = () => screen.getByTestId("done-grouping");

describe("History's grouping control", () => {
  let held: FrameRequestCallback[] = [];
  beforeEach(() => {
    held = [];
    useLayoutStore.setState({ doneGrouping: "date" });
    // A main thread too busy to draw: no frame runs until the test lets it.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      held.push(callback);
      return held.length;
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const drawFrames = () =>
    act(() => {
      for (let i = 0; i < 5 && held.length > 0; i++) {
        const now = held;
        held = [];
        for (const callback of now) callback(performance.now());
      }
    });

  it("opens on its first press while the page draws no frame", () => {
    render(<DoneGroupingMenu />);
    act(() => press(trigger()));
    expect(menu()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("stays open when the held frame comes in after the click", () => {
    render(<DoneGroupingMenu />);
    act(() => press(trigger()));
    drawFrames();
    expect(menu()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("opens from the keyboard, whose click has no press before it", () => {
    render(<DoneGroupingMenu />);
    act(() => {
      fireEvent.keyDown(trigger(), { key: "Enter" });
      fireEvent.click(trigger());
    });
    drawFrames();
    expect(menu()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("closes on a press while open, and a pick changes the grouping", () => {
    render(<DoneGroupingMenu />);
    act(() => press(trigger()));
    drawFrames();
    act(() => press(trigger()));
    drawFrames();
    expect(trigger().getAttribute("aria-expanded")).not.toBe("true");

    act(() => press(trigger()));
    drawFrames();
    act(() => {
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Group by orchestrator" }));
    });
    drawFrames();
    expect(useLayoutStore.getState().doneGrouping).toBe("orchestrator");
  });
});
