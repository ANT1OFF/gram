// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PANEL_WIDTH, useLayoutStore } from "@/stores/layout";

import { placeShift, ReviewRoomOffer, useAutoReviewFocus, useReviewRoom } from "./review-room";

const cramped = {
  windowWidth: 1024,
  overviewSidebar: "compact" as const,
  sidebarPeek: false,
  focusMode: false,
  threadInView: true,
  threadQuiet: false,
  chatBusy: false,
  panelOpen: true,
  panelPeek: false,
  panelExpanded: false,
  panelTab: "diff" as const,
  panelWidth: PANEL_WIDTH.default,
  reviewWidth: 600,
  reviewFocus: false,
};

beforeEach(() => {
  useLayoutStore.setState(cramped);
  useReviewRoom.setState({ declined: false, dismissed: false });
});
afterEach(cleanup);

/** The panel's part: the hook that takes focus on its own, and the offer under the tabs. */
function Room({ auto = true }: { auto?: boolean }) {
  useAutoReviewFocus(auto);
  return useLayoutStore((s) => s.reviewFocus) ? null : <ReviewRoomOffer />;
}

describe("ReviewRoomOffer", () => {
  it("offers Focus review while the review is held too narrow, and takes it", () => {
    render(<Room auto={false} />);
    expect(screen.getByTestId("review-room-offer").textContent).toContain(
      "Too narrow to read beside the conversation.",
    );
    fireEvent.click(screen.getByTestId("review-room-focus"));
    expect(useLayoutStore.getState().reviewFocus).toBe(true);
  });

  it("says nothing while the review has room", () => {
    useLayoutStore.setState({ reviewWidth: 300 });
    render(<Room auto={false} />);
    expect(screen.queryByTestId("review-room-offer")).toBeNull();
    expect(useLayoutStore.getState().reviewFocus).toBe(false);
  });
});

/** Past the hook's settle delay, so a cramped review takes focus. */
const settle = () => act(() => vi.advanceTimersByTime(500));

describe("useAutoReviewFocus", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("takes Focus review on its own once the layout settles too narrow to read", () => {
    render(<Room />);
    expect(useLayoutStore.getState().reviewFocus).toBe(false);
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(true);
    expect(screen.queryByTestId("review-room-offer")).toBeNull();
  });

  it("waits while a drag holds the pointer down, and takes it once let go", () => {
    render(<Room />);
    fireEvent.pointerDown(window);
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(false);
    fireEvent.pointerUp(window);
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(true);
  });

  it("leaves the review side by side once the user leaves focus, with the offer, until it has room", () => {
    render(<Room />);
    settle();
    act(() => useLayoutStore.getState().setReviewFocus(false));
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(false);
    expect(screen.getByTestId("review-room-offer")).toBeTruthy();

    // Kept side by side, the offer goes too.
    fireEvent.click(screen.getByRole("button", { name: "Keep side by side" }));
    expect(screen.queryByTestId("review-room-offer")).toBeNull();
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(false);

    // Room again (the window widened), then short once more: focus is taken again.
    act(() => useLayoutStore.setState({ windowWidth: 1728 }));
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(false);
    act(() => useLayoutStore.setState({ windowWidth: 1024 }));
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(true);
  });

  it("does nothing off a review", () => {
    render(<Room auto={false} />);
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(false);
  });
});

describe("placeShift", () => {
  it("scrolls by how far the read element moved from where it started", () => {
    const element = { getBoundingClientRect: () => ({ top: 260 }) } as unknown as Element;
    // It started 20 px under the scroller's top (100); it is now 160 px under: scroll 140 on.
    expect(placeShift({ element, offset: 20 }, 100)).toBe(140);
    expect(placeShift({ element, offset: 160 }, 100)).toBe(0);
  });
});
