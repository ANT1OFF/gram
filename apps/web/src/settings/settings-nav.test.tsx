// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ALL_SETTINGS_PAGES, isSubpage, SETTINGS_GROUPS } from "./pages";
import { SettingsNav } from "./settings-nav";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => Promise.resolve(),
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

describe("SettingsNav", () => {
  it("links the six groups in order and marks the open one", () => {
    const onNavigate = vi.fn();
    render(<SettingsNav groups={SETTINGS_GROUPS} current="advanced" onNavigate={onNavigate} />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["General", "Agents", "Workspaces", "Appearance", "Notifications", "Advanced"]);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Advanced");
    expect(screen.getByRole("link", { name: "Appearance" }).getAttribute("href")).toBe(
      "/settings/appearance",
    );
    expect(screen.getByRole("link", { name: "General" }).getAttribute("aria-current")).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "General" }));
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("files every page under one of the six, and each group has a page of its own", () => {
    for (const group of SETTINGS_GROUPS) {
      const own = ALL_SETTINGS_PAGES.find((page) => page.id === group.id);
      expect(own?.path).toBe(group.path);
      expect(isSubpage(own!)).toBe(false);
    }
    const ids = new Set(SETTINGS_GROUPS.map((group) => group.id));
    for (const page of ALL_SETTINGS_PAGES) expect(ids.has(page.group)).toBe(true);
    // Everything that isn't one of the six opens from Advanced.
    expect(ALL_SETTINGS_PAGES.filter(isSubpage).every((page) => page.group === "advanced")).toBe(
      true,
    );
  });

  it("shows a group's badge", () => {
    render(
      <SettingsNav
        groups={SETTINGS_GROUPS}
        current="general"
        badges={{ advanced: <span data-testid="updates-badge" /> }}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Advanced" }).querySelector("[data-testid]"),
    ).toBeTruthy();
  });
});
