// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMPTY_SHELL, useEmbedShell } from "@/embed/store";
import { useHistoryStore } from "@/history/history-view";
import { useInboxStore } from "@/inbox/inbox-store";
import { useLayoutStore } from "@/stores/layout";

import { PhoneDrawer, PhoneMenuButton, usePhoneDrawer } from "./phone-drawer";

// The phone's drawer: the overview's content over the page, opened from the header's menu and
// closed by Escape, a tap on its scrim, or a pick in it (a new page, or a sheet it opened).

const route = vi.hoisted(() => ({ pathname: "/t/a" }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: route.pathname } }),
}));

vi.mock("@/shell/phone-menu", () => ({
  ROUND: "round",
  PhoneMenu: () => <aside data-testid="phone-menu-stub" />,
}));

vi.mock("@/orchestration/overview-sidebar", () => ({
  OverviewSidebar: ({ phone }: { phone?: boolean }) => (
    <aside data-testid="overview-stub" data-phone={phone || undefined} />
  ),
}));

const Shell = () => (
  <>
    <PhoneMenuButton />
    <PhoneDrawer />
  </>
);

const drawer = () => screen.queryByTestId("phone-drawer");

const openDrawer = () => fireEvent.click(screen.getByRole("button", { name: "Threads" }));

afterEach(() => {
  cleanup();
  route.pathname = "/t/a";
  usePhoneDrawer.setState({ open: false });
  useLayoutStore.setState({ paletteOpen: false });
  useHistoryStore.setState({ open: false });
  useInboxStore.setState({ open: false });
  useEmbedShell.setState(EMPTY_SHELL);
});

/** The roomy look, with one place that counts `count`. */
const roomy = (count: number) =>
  useEmbedShell.setState({
    sidebar: { look: "roomy" },
    threads: "hidden",
    navigation: [{ id: "home", items: [{ id: "inbox", label: "Inbox", to: "/inbox", count }] }],
  });

describe("PhoneDrawer", () => {
  it("opens from the menu button with the overview in its phone form", () => {
    render(<Shell />);
    expect(drawer()).toBeNull();
    openDrawer();
    expect(drawer()).not.toBeNull();
    expect(drawer()!.hasAttribute("data-phone-drawer")).toBe(true);
    expect(screen.getByTestId("overview-stub").dataset.phone).toBe("true");
    // The page behind it, its menu button too, is out of reach while it is open.
    expect(screen.getByTestId("phone-menu").getAttribute("aria-expanded")).toBe("true");
  });

  it("closes when the phone layout goes away, so it doesn't come back open", () => {
    const { rerender } = render(<Shell />);
    openDrawer();
    rerender(<PhoneMenuButton />);
    expect(usePhoneDrawer.getState().open).toBe(false);
  });

  it("closes on Escape", () => {
    render(<Shell />);
    openDrawer();
    fireEvent.keyDown(drawer()!, { key: "Escape" });
    expect(usePhoneDrawer.getState().open).toBe(false);
  });

  it("closes on a tap on the scrim", () => {
    render(<Shell />);
    openDrawer();
    const scrim = screen.getByTestId("phone-drawer-scrim");
    fireEvent.pointerDown(scrim);
    fireEvent.mouseDown(scrim);
    fireEvent.pointerUp(scrim);
    fireEvent.mouseUp(scrim);
    fireEvent.click(scrim);
    expect(usePhoneDrawer.getState().open).toBe(false);
  });

  it("closes once a row picked in it moves to another page", () => {
    const { rerender } = render(<Shell />);
    openDrawer();
    route.pathname = "/t/b";
    rerender(<Shell />);
    expect(usePhoneDrawer.getState().open).toBe(false);
  });

  it.each([
    ["Search", () => useLayoutStore.setState({ paletteOpen: true })],
    ["History", () => useHistoryStore.setState({ open: true })],
    ["Needs you", () => useInboxStore.setState({ open: true })],
  ])("closes once %s opens from it", (_, show) => {
    render(<Shell />);
    openDrawer();
    act(show);
    expect(usePhoneDrawer.getState().open).toBe(false);
  });

  it("stays open while nothing was picked", () => {
    const { rerender } = render(<Shell />);
    openDrawer();
    rerender(<Shell />);
    expect(usePhoneDrawer.getState().open).toBe(true);
  });

  describe("in the roomy look", () => {
    it("holds the plain menu in place of the overview", () => {
      roomy(0);
      render(<Shell />);
      fireEvent.click(screen.getByRole("button", { name: "Menu" }));
      expect(screen.getByTestId("phone-menu-stub")).not.toBeNull();
      expect(screen.queryByTestId("overview-stub")).toBeNull();
    });

    it("marks its button while a place in it counts something, and says what", () => {
      roomy(5);
      render(<PhoneMenuButton />);
      expect(screen.getByTestId("phone-menu-dot")).not.toBeNull();
      expect(screen.getByRole("button", { name: "Menu, Inbox 5" })).not.toBeNull();
    });

    it("has no dot while nothing is counted", () => {
      roomy(0);
      render(<PhoneMenuButton />);
      expect(screen.queryByTestId("phone-menu-dot")).toBeNull();
    });
  });
});
