// @vitest-environment happy-dom
import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { holdStill } from "./transcript-scroll";

/**
 * A list as a browser lays it out: 200 px tall, scrolled no further than its content allows, and
 * telling the virtualizer where it is after each scroll that moved it.
 */
function list(height: number) {
  const element = document.createElement("div");
  let content = height;
  let top = 0;
  Object.defineProperties(element, {
    clientHeight: { get: () => 200 },
    clientWidth: { get: () => 800 },
    scrollHeight: { get: () => content },
    scrollTop: { get: () => top },
  });
  element.scrollTo = (options?: ScrollToOptions | number) => {
    const wanted = typeof options === "number" ? options : (options?.top ?? top);
    const next = Math.max(0, Math.min(wanted, content - 200));
    if (next === top) return;
    top = next;
    element.dispatchEvent(new Event("scroll"));
  };
  return {
    element,
    grow: (to: number) => {
      content = to;
    },
  };
}

afterEach(cleanup);

/** The transcript's virtualizer over `element`; each rerender is an update of the transcript. */
function virtualized(element: HTMLElement) {
  return renderHook(() =>
    useVirtualizer<HTMLElement, HTMLElement>({
      count: 3,
      getScrollElement: () => element,
      estimateSize: () => 100,
      scrollToFn: elementScroll,
      observeElementRect: (_, report) => {
        report({ width: 800, height: 200 });
        return () => {};
      },
      observeElementOffset: (_, report) => {
        const onScroll = () => report(element.scrollTop, false);
        element.addEventListener("scroll", onScroll);
        return () => element.removeEventListener("scroll", onScroll);
      },
    }),
  );
}

describe("holdStill", () => {
  it("keeps a clamped correction from landing on the update a press causes", () => {
    // Three rows of 100 px; the reader is at the end, 100 px down.
    const { element, grow } = list(300);
    const { result, rerender } = virtualized(element);
    const virtualizer = result.current;
    element.scrollTo({ top: 100 });
    // The first row grows by 50 px before the list does: the correction asks for 150 and the list
    // stops it at 100.
    virtualizer.resizeItem(0, 150);
    expect(element.scrollTop).toBe(100);
    // The list grows, nothing moves yet, and the reader presses on what they see.
    grow(350);
    holdStill(virtualizer, element);
    // The press re-renders the transcript: the virtualizer's next update.
    rerender();
    expect(element.scrollTop).toBe(100);
  });
});
