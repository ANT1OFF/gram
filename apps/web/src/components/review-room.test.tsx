// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PANEL_WIDTH, useLayoutStore } from "@/stores/layout";

import { placeShift, ReviewRoomOffer } from "./review-room";

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

beforeEach(() => useLayoutStore.setState(cramped));
afterEach(cleanup);

describe("ReviewRoomOffer", () => {
  it("offers Focus review while the review is held too narrow, and takes it", () => {
    render(<ReviewRoomOffer />);
    expect(screen.getByTestId("review-room-offer").textContent).toContain(
      "Too narrow to read beside the conversation.",
    );
    fireEvent.click(screen.getByTestId("review-room-focus"));
    expect(useLayoutStore.getState().reviewFocus).toBe(true);
  });

  it("stays away once dismissed, until the review runs short again", () => {
    render(<ReviewRoomOffer />);
    fireEvent.click(screen.getByRole("button", { name: "Keep side by side" }));
    expect(screen.queryByTestId("review-room-offer")).toBeNull();
    // Room again (the window widened), then short once more: offered again.
    act(() => useLayoutStore.setState({ windowWidth: 1728 }));
    expect(screen.queryByTestId("review-room-offer")).toBeNull();
    act(() => useLayoutStore.setState({ windowWidth: 1024 }));
    expect(screen.getByTestId("review-room-offer")).toBeTruthy();
  });

  it("says nothing while the review has room", () => {
    useLayoutStore.setState({ reviewWidth: 300 });
    render(<ReviewRoomOffer />);
    expect(screen.queryByTestId("review-room-offer")).toBeNull();
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
