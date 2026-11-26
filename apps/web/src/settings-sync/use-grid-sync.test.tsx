// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type Settings, type ThreadId } from "@gram/contracts";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetCurrentWindow } from "@/desktop/window-identity";
import { EMPTY_SHELL, useEmbedShell } from "@/embed/store";
import { renderInRouter } from "@/panels/test-utils";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { useServerSettings } from "./store";
import { useGridSync } from "./use-grid-sync";

const FOCUSED = "t-last-focused" as ThreadId;

/** Settings whose saved grid has one pane, the thread this person last focused. */
const savedSettings: Settings = {
  ...DEFAULT_SETTINGS,
  layout: { ...DEFAULT_SETTINGS.layout, grid: { preset: "1", panes: [FOCUSED], focused: 0 } },
};

const updateSettings = vi.fn(() => Promise.resolve(savedSettings));

const GridSync = () => {
  useGridSync();
  return null;
};

/** The threads are loaded and the saved settings are in, as on a launch at `path`. */
const launch = (path = "/") => {
  useThreadsStore.setState({
    ready: true,
    byId: { [FOCUSED]: { id: FOCUSED } } as unknown as ReturnType<
      typeof useThreadsStore.getState
    >["byId"],
  });
  useServerSettings.setState({ settings: savedSettings });
  return renderInRouter(<GridSync />, { path, api: { updateSettings } });
};

/** Mounted by an app in front of Gram that supplies its own home at `/`. */
const embedWithHome = () =>
  useEmbedShell.setState({ hosted: true, home: () => null, titles: { "/": "Home" } });

beforeEach(() => {
  resetCurrentWindow();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  updateSettings.mockClear();
  useEmbedShell.setState(EMPTY_SHELL);
  useLayoutStore.setState({ grid: EMPTY_GRID });
  useServerSettings.setState({ settings: undefined });
  useThreadsStore.setState({ ready: false, byId: {} });
});

describe("useGridSync", () => {
  it("on its own, restores the saved grid and opens its focused thread on a launch at /", async () => {
    const { router } = await launch();

    expect(useLayoutStore.getState().grid.panes).toEqual([FOCUSED]);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/t/${FOCUSED}`));
  });

  it("on its own, saves a changed grid to the server's settings", async () => {
    await launch();
    vi.useFakeTimers();
    act(() => useLayoutStore.getState().setGrid(EMPTY_GRID));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(updateSettings).toHaveBeenCalledWith({
      layout: { grid: expect.objectContaining({ panes: [null] }) },
    });
  });

  it("under an embedding app's home, a launch at / restores the grid and stays home", async () => {
    embedWithHome();
    const { router } = await launch();

    expect(router.state.location.pathname).toBe("/");
    expect(useLayoutStore.getState().grid.panes).toEqual([FOCUSED]);
  });

  it("under an embedding app with no home of its own, a launch at / opens the saved focus", async () => {
    useEmbedShell.setState({ hosted: true });
    const { router } = await launch();

    await waitFor(() => expect(router.state.location.pathname).toBe(`/t/${FOCUSED}`));
  });

  it("under an embedding app, a thread's address opens that thread in the restored grid", async () => {
    embedWithHome();
    const { router } = await launch("/t/t-linked");

    expect(router.state.location.pathname).toBe("/t/t-linked");
    expect(useLayoutStore.getState().grid.panes).toEqual(["t-linked"]);
  });

  it("under an embedding app, a changed grid is saved as the person's own", async () => {
    embedWithHome();
    await launch();
    vi.useFakeTimers();
    act(() => useLayoutStore.getState().openThread("t-mine" as ThreadId));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(updateSettings).toHaveBeenCalledWith({
      layout: { grid: expect.objectContaining({ panes: ["t-mine"] }) },
    });
  });
});
