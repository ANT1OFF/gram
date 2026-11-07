// @vitest-environment happy-dom
import type { WorkspaceId } from "@gram/contracts";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";

import { newEntryRoute } from "./new-entry";
import { NewEntryMenu, newEntryOf } from "./new-entry-menu";
import { useTaskDraftStore } from "./task-draft-store";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const studio = "w-studio" as WorkspaceId;

beforeEach(() => {
  navigate.mockReset();
  useTaskDraftStore.setState({ last: undefined, entry: undefined, workers: {} });
  useLayoutStore.setState({ grid: { ...EMPTY_GRID, panes: [null] } });
});
afterEach(cleanup);

describe("newEntryRoute", () => {
  it("lands each choice on its existing route", () => {
    expect(newEntryRoute("task")).toEqual({ to: "/new-task", search: {} });
    expect(newEntryRoute("task", studio)).toEqual({
      to: "/new-task",
      search: { workspace: studio },
    });
    expect(newEntryRoute("worker", studio)).toEqual({
      to: "/new-task",
      search: { way: "direct", workspace: studio },
    });
    expect(newEntryRoute("oneOff", studio)).toEqual({ to: "/new" });
    expect(newEntryRoute("workspace")).toEqual({ to: "/new-workspace" });
  });

  it("opens on the orchestrator until another choice was used", () => {
    expect(newEntryOf(undefined)).toBe("task");
    expect(newEntryOf("workspace")).toBe("task");
    expect(newEntryOf("worker")).toBe("worker");
    expect(newEntryOf("oneOff")).toBe("oneOff");
  });
});

describe("NewEntryMenu", () => {
  it("is an icon that opens a menu of Task, Team and Chat, each with its shortcut", async () => {
    renderWithApi(<NewEntryMenu />, {});
    const add = screen.getByRole("button", { name: "New" });
    expect(add.getAttribute("aria-haspopup")).toBe("menu");
    expect(add.textContent).toBe("");
    fireEvent.click(add);
    const menu = await screen.findByRole("menu", { name: "New" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("data-who"))).toEqual([
      "worker",
      "orchestrator",
      "me",
    ]);
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Task.+N$/),
      expect.stringMatching(/^Team.+N$/),
      expect.stringMatching(/^Chat.+T$/),
    ]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("opens the New form on the choice picked", async () => {
    for (const [who, route] of [
      ["Task", { to: "/new-task", search: { way: "direct" } }],
      ["Team", { to: "/new-task", search: {} }],
      ["Chat", { to: "/new" }],
    ] as const) {
      navigate.mockReset();
      renderWithApi(<NewEntryMenu />, {});
      fireEvent.click(screen.getByRole("button", { name: "New" }));
      const menu = await screen.findByRole("menu", { name: "New" });
      fireEvent.click(within(menu).getByRole("menuitem", { name: new RegExp(`^${who}`) }));
      expect(navigate).toHaveBeenCalledWith(route);
      cleanup();
    }
  });
});
