// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fitShell, PANEL_WIDTH, useLayoutStore } from "@/stores/layout";

import { placeShift, useAutoReviewFocus, useReviewRoom } from "./review-room";

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
  useReviewRoom.setState({ declined: false });
});
afterEach(cleanup);

/**
 * The panel's part: the hook that takes focus on its own, and the offer the action beside the tabs
 * makes while the review is too narrow beside the chat.
 */
function Room() {
  useAutoReviewFocus();
  const offered = useLayoutStore((s) => !s.reviewFocus && fitShell(s).reviewNarrow);
  return offered ? <span data-testid="review-room-offer" /> : null;
}

/** The review with room: Diff beside the chat in a wide window. */
const roomy = { windowWidth: 1728 };

describe("the Focus review offer", () => {
  it("is made while the review is held too narrow", () => {
    render(<Room />);
    expect(screen.getByTestId("review-room-offer")).toBeTruthy();
  });

  it("is made for a narrow review that could be dragged wider, without taking focus", () => {
    useLayoutStore.setState({ reviewWidth: 300 });
    render(<Room />);
    expect(screen.getByTestId("review-room-offer")).toBeTruthy();
    expect(useLayoutStore.getState().reviewFocus).toBe(false);
  });

  it("is not made while the review has room", () => {
    useLayoutStore.setState(roomy);
    render(<Room />);
    expect(screen.queryByTestId("review-room-offer")).toBeNull();
  });
});

/** Past the hook's settle delay, so a cramped review takes focus. */
const settle = () => act(() => vi.advanceTimersByTime(500));

describe("useAutoReviewFocus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useLayoutStore.setState(roomy);
  });
  afterEach(() => vi.useRealTimers());

  it("takes Focus review once the layout settles after the review runs too narrow", () => {
    render(<Room />);
    act(() => useLayoutStore.setState({ windowWidth: 1024 }));
    expect(useLayoutStore.getState().reviewFocus).toBe(false);
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(true);
    expect(screen.queryByTestId("review-room-offer")).toBeNull();
  });

  it("leaves a window that opens cramped as it is, with the offer", () => {
    useLayoutStore.setState(cramped);
    render(<Room />);
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(false);
    expect(screen.getByTestId("review-room-offer")).toBeTruthy();
  });

  it("waits while a drag holds the pointer down, and takes it once let go", () => {
    render(<Room />);
    fireEvent.pointerDown(window);
    act(() => useLayoutStore.setState({ windowWidth: 1024 }));
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(false);
    fireEvent.pointerUp(window);
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(true);
  });

  it("leaves the review side by side once the user leaves focus, with the offer, until it has room", () => {
    render(<Room />);
    act(() => useLayoutStore.setState({ windowWidth: 1024 }));
    settle();
    act(() => useLayoutStore.getState().setReviewFocus(false));
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(false);
    expect(screen.getByTestId("review-room-offer")).toBeTruthy();

    // Room again (the window widened), then short once more: focus is taken again.
    act(() => useLayoutStore.setState({ windowWidth: 1728 }));
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(false);
    act(() => useLayoutStore.setState({ windowWidth: 1024 }));
    settle();
    expect(useLayoutStore.getState().reviewFocus).toBe(true);
  });

  it("does nothing off a review", () => {
    useLayoutStore.setState({ panelTab: "terminal" });
    render(<Room />);
    act(() => useLayoutStore.setState({ windowWidth: 1024 }));
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
