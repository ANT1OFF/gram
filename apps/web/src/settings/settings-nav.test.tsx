// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ALL_SETTINGS_PAGES, isSubpage, SETTINGS_GROUPS, subpagesOf } from "./pages";
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
  it("links the groups in order and marks the open one", () => {
    const onNavigate = vi.fn();
    render(<SettingsNav groups={SETTINGS_GROUPS} current="about" onNavigate={onNavigate} />);
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([
      "General",
      "Agents & models",
      "Usage",
      "Workspaces & merging",
      "Appearance",
      "Notifications",
      "Keyboard",
      "Voice",
      "About",
    ]);
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("About");
    expect(screen.getByRole("link", { name: "Appearance" }).getAttribute("href")).toBe(
      "/settings/appearance",
    );
    expect(screen.getByRole("link", { name: "General" }).getAttribute("aria-current")).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "General" }));
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("files every page under a group, and each group has a page of its own", () => {
    for (const group of SETTINGS_GROUPS) {
      const own = ALL_SETTINGS_PAGES.find((page) => page.id === group.id);
      expect(own?.path).toBe(group.path);
      expect(isSubpage(own!)).toBe(false);
    }
    const ids = new Set(SETTINGS_GROUPS.map((group) => group.id));
    for (const page of ALL_SETTINGS_PAGES) expect(ids.has(page.group)).toBe(true);
    // No catch-all group: each page opens from the group it is about.
    expect(ids.has("advanced" as never)).toBe(false);
    expect(
      Object.fromEntries(
        SETTINGS_GROUPS.map((g) => [g.id, subpagesOf(g.id, ALL_SETTINGS_PAGES).map((p) => p.id)]),
      ),
    ).toEqual({
      general: [],
      agents: ["ai-helpers", "connectors", "gateways"],
      usage: [],
      workspaces: ["routines", "review-bots", "storage"],
      appearance: ["terminal"],
      notifications: [],
      keyboard: [],
      "voice-input": [],
      about: ["diagnostics", "help"],
    });
  });

  it("lists the open group's own pages under it, the open one current", () => {
    const pages = subpagesOf("agents", ALL_SETTINGS_PAGES);
    render(
      <SettingsNav
        groups={SETTINGS_GROUPS}
        current="agents"
        subpages={pages}
        currentPage="gateways"
      />,
    );
    const under = screen.getByRole("list", { name: "More in Agents & models" });
    expect(
      within(under)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["AI helpers", "Connectors", "Gateways"]);
    expect(within(under).getByRole("link", { name: "Gateways" }).getAttribute("aria-current")).toBe(
      "page",
    );
    // The group stays marked, but only one link is the page.
    expect(screen.getByRole("link", { name: "Agents & models" }).getAttribute("aria-current")).toBe(
      "true",
    );
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("shows a group's badge", () => {
    render(
      <SettingsNav
        groups={SETTINGS_GROUPS}
        current="general"
        badges={{ about: <span data-testid="updates-badge" /> }}
      />,
    );
    expect(screen.getByRole("link", { name: "About" }).querySelector("[data-testid]")).toBeTruthy();
  });
});
