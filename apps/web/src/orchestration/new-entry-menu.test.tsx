// @vitest-environment happy-dom
import type { WorkspaceId } from "@gram/contracts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
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
  it("is one button that opens the New form, not a menu of destinations", () => {
    renderWithApi(<NewEntryMenu />, {});
    const add = screen.getByRole("button", { name: "New" });
    expect(add.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(add);
    expect(navigate).toHaveBeenCalledWith({ to: "/new-task", search: {} });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens on Who does it as it was last left", () => {
    useTaskDraftStore.setState({ entry: "worker" });
    renderWithApi(<NewEntryMenu />, {});
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/new-task", search: { way: "direct" } });

    cleanup();
    navigate.mockReset();
    useTaskDraftStore.setState({ entry: "oneOff" });
    renderWithApi(<NewEntryMenu />, {});
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/new" });
  });
});
