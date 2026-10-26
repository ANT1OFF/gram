// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COUNT_UP_MS, COUNT_UP_STEP_MS, countUpAt, useCountUp } from "./count-up";

describe("countUpAt", () => {
  it("starts on the old value, ends exactly on the new one, and eases out in between", () => {
    expect(countUpAt(100, 200, 0)).toBe(100);
    expect(countUpAt(100, 200, 1)).toBe(200);
    expect(countUpAt(100, 200, 7)).toBe(200);
    expect(countUpAt(100, 200, -1)).toBe(100);
    const half = countUpAt(100, 200, 0.5);
    expect(half).toBeGreaterThan(150);
    expect(half).toBeLessThan(200);
    // Down works the same way: a rewound thread reports less.
    expect(countUpAt(200, 100, 0.5)).toBeLessThan(150);
  });
});

function Shown({ value, enabled }: { value: number; enabled: boolean }) {
  return <output>{useCountUp(value, enabled)}</output>;
}
/** The hook anchored to its own element, whose visibility the test decides through `seen`. */
function Anchored({ value, seen }: { value: number; seen: { current: boolean } }) {
  const anchor = useRef<HTMLOutputElement>(null);
  const shownValue = useCountUp(value, true, anchor);
  return (
    <output
      ref={(element) => {
        anchor.current = element;
        if (element) element.checkVisibility = () => seen.current;
      }}
    >
      {shownValue}
    </output>
  );
}
const shown = () => Number(screen.getByRole("status").textContent);

describe("useCountUp", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] }));
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the first value as it is, then runs through the values to the next", () => {
    const view = render(<Shown value={1000} enabled />);
    expect(shown()).toBe(1000);

    view.rerender(<Shown value={2000} enabled />);
    act(() => void vi.advanceTimersByTime(COUNT_UP_STEP_MS * 4));
    const midway = shown();
    expect(midway).toBeGreaterThan(1000);
    expect(midway).toBeLessThan(2000);

    // A new report mid-way carries on from what is showing, never back from the old target.
    view.rerender(<Shown value={3000} enabled />);
    act(() => void vi.advanceTimersByTime(COUNT_UP_STEP_MS));
    expect(shown()).toBeGreaterThanOrEqual(midway);

    act(() => void vi.advanceTimersByTime(COUNT_UP_MS + COUNT_UP_STEP_MS));
    expect(shown()).toBe(3000);
  });

  it("doesn't run out of sight: a hidden pane gets the value and no timer", () => {
    const seen = { current: false };
    const view = render(<Anchored value={1000} seen={seen} />);
    view.rerender(<Anchored value={2000} seen={seen} />);
    expect(shown()).toBe(2000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes at once when its pane is hidden mid-way, and replays nothing on return", () => {
    const seen = { current: true };
    const view = render(<Anchored value={1000} seen={seen} />);
    view.rerender(<Anchored value={2000} seen={seen} />);
    act(() => void vi.advanceTimersByTime(COUNT_UP_STEP_MS * 2));
    expect(shown()).toBeLessThan(2000);

    seen.current = false;
    act(() => void vi.advanceTimersByTime(COUNT_UP_STEP_MS));
    expect(shown()).toBe(2000);
    expect(vi.getTimerCount()).toBe(0);

    seen.current = true;
    act(() => void vi.advanceTimersByTime(COUNT_UP_MS));
    expect(shown()).toBe(2000);
  });

  it("jumps when it is off, as it is below Full motion", () => {
    const view = render(<Shown value={10} enabled={false} />);
    view.rerender(<Shown value={500} enabled={false} />);
    expect(shown()).toBe(500);
  });
});
