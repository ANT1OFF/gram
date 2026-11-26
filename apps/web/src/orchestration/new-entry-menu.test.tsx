// @vitest-environment happy-dom
import type { WorkspaceId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderInRouter } from "@/panels/test-utils";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";

import { newEntryRoute } from "./new-entry";
import { useEmbedShell } from "@/embed/store";
import { NewEntryMenu, newEntryOf } from "./new-entry-menu";
import { useTaskDraftStore } from "./task-draft-store";

const studio = "w-studio" as WorkspaceId;

beforeEach(() => {
  useTaskDraftStore.setState({ last: undefined, entry: undefined });
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
    expect(newEntryRoute("oneOff", studio)).toEqual({ to: "/new" });
    expect(newEntryRoute("workspace")).toEqual({ to: "/new-workspace" });
  });

  it("opens on the orchestrator until another choice was used", () => {
    expect(newEntryOf(undefined)).toBe("task");
    expect(newEntryOf("workspace")).toBe("task");
    // A worker straight away, remembered from before New had two choices, is the orchestrator's.
    expect(newEntryOf("worker")).toBe("task");
    expect(newEntryOf("oneOff")).toBe("oneOff");
  });
});

describe("NewEntryMenu", () => {
  it("is New task, a menu of Team and Chat, each with its shortcut", async () => {
    const { router } = await renderInRouter(<NewEntryMenu />, { api: {} });
    const add = screen.getByRole("button", { name: "New task" });
    expect(add.getAttribute("aria-haspopup")).toBe("menu");
    // Its words, which the header shows where it has room for them beside its icons.
    expect(add.textContent).toBe("New task");
    fireEvent.click(add);
    const menu = await screen.findByRole("menu", { name: "New" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("data-who"))).toEqual(["orchestrator", "me"]);
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Team.+N$/),
      expect.stringMatching(/^Chat.+T$/),
    ]);
    expect(router.state.location.pathname).toBe("/");
  });

  it("opens the New form on the choice picked", async () => {
    for (const [who, pathname] of [
      ["Team", "/new-task"],
      ["Chat", "/new"],
    ] as const) {
      const { router } = await renderInRouter(<NewEntryMenu />, { api: {} });
      fireEvent.click(screen.getByRole("button", { name: "New task" }));
      const menu = await screen.findByRole("menu", { name: "New" });
      fireEvent.click(within(menu).getByRole("menuitem", { name: new RegExp(`^${who}`) }));
      await waitFor(() => expect(router.state.location.pathname).toBe(pathname));
      expect(router.state.location.search).toEqual({});
      cleanup();
    }
  });

  it("is one plain button of the embedding app's when it names what New starts", async () => {
    useEmbedShell.setState({ newEntry: { label: "New agent", to: "/agents" } });
    try {
      const { router } = await renderInRouter(<NewEntryMenu />, { api: {} });
      const add = screen.getByRole("button", { name: "New agent" });
      expect(add.getAttribute("aria-haspopup")).toBeNull();
      expect(add.textContent).toBe("New agent");
      fireEvent.click(add);
      await waitFor(() => expect(router.state.location.pathname).toBe("/agents"));
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      useEmbedShell.setState({ newEntry: undefined });
    }
  });
});
