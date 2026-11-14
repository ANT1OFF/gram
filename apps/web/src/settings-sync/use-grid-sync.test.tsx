// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type Settings, type ThreadId } from "@gram/contracts";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { resetCurrentWindow } from "@/desktop/window-identity";
import { EMPTY_SHELL, useEmbedShell } from "@/embed/store";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { useServerSettings } from "./store";
import { useGridSync } from "./use-grid-sync";

const router = vi.hoisted(() => ({
  navigate: vi.fn(),
  pathname: "/",
  params: {} as Record<string, string>,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => router.navigate,
  useLocation: ({ select }: { select: (location: { pathname: string }) => string }) =>
    select({ pathname: router.pathname }),
  useParams: () => router.params,
}));

const FOCUSED = "t-last-focused" as ThreadId;

/** Settings whose saved grid has one pane, the thread this person last focused. */
const savedSettings: Settings = {
  ...DEFAULT_SETTINGS,
  layout: { ...DEFAULT_SETTINGS.layout, grid: { preset: "1", panes: [FOCUSED], focused: 0 } },
};

const updateSettings = vi.fn(() => Promise.resolve(savedSettings));
const api = { updateSettings } as unknown as Api;
const wrapper = ({ children }: { children: ReactNode }) => (
  <ApiProvider api={api}>{children}</ApiProvider>
);

/** The threads are loaded and the saved settings are in, as on a launch. */
const launch = () => {
  useThreadsStore.setState({
    ready: true,
    byId: { [FOCUSED]: { id: FOCUSED } } as unknown as ReturnType<
      typeof useThreadsStore.getState
    >["byId"],
  });
  useServerSettings.setState({ settings: savedSettings });
  return renderHook(() => useGridSync(), { wrapper });
};

/** Mounted by an app in front of Gram that supplies its own home at `/`. */
const embedWithHome = () =>
  useEmbedShell.setState({ hosted: true, home: () => null, titles: { "/": "Home" } });

beforeEach(() => {
  vi.useFakeTimers();
  resetCurrentWindow();
  router.pathname = "/";
  router.params = {};
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  router.navigate.mockReset();
  updateSettings.mockClear();
  useEmbedShell.setState(EMPTY_SHELL);
  useLayoutStore.setState({ grid: EMPTY_GRID });
  useServerSettings.setState({ settings: undefined });
  useThreadsStore.setState({ ready: false, byId: {} });
});

describe("useGridSync", () => {
  it("on its own, restores the saved grid and opens its focused thread on a launch at /", () => {
    launch();

    expect(useLayoutStore.getState().grid.panes).toEqual([FOCUSED]);
    expect(router.navigate).toHaveBeenCalledWith({
      to: "/t/$threadId",
      params: { threadId: FOCUSED },
    });
  });

  it("on its own, saves a changed grid to the server's settings", () => {
    launch();
    act(() => useLayoutStore.getState().setGrid(EMPTY_GRID));
    act(() => vi.advanceTimersByTime(1_000));

    expect(updateSettings).toHaveBeenCalledWith({
      layout: { grid: expect.objectContaining({ panes: [null] }) },
    });
  });

  it("under an embedding app's home, a launch at / restores the grid and stays home", () => {
    embedWithHome();
    launch();

    expect(router.navigate).not.toHaveBeenCalled();
    expect(useLayoutStore.getState().grid.panes).toEqual([FOCUSED]);
  });

  it("under an embedding app with no home of its own, a launch at / opens the saved focus", () => {
    useEmbedShell.setState({ hosted: true });
    launch();

    expect(router.navigate).toHaveBeenCalledWith({
      to: "/t/$threadId",
      params: { threadId: FOCUSED },
    });
  });

  it("under an embedding app, a thread's address opens that thread in the restored grid", () => {
    embedWithHome();
    router.pathname = "/t/t-linked";
    router.params = { threadId: "t-linked" };
    launch();

    expect(router.navigate).not.toHaveBeenCalled();
    expect(useLayoutStore.getState().grid.panes).toEqual(["t-linked"]);
  });

  it("under an embedding app, a changed grid is saved as the person's own", () => {
    embedWithHome();
    launch();
    act(() => useLayoutStore.getState().openThread("t-mine" as ThreadId));
    act(() => vi.advanceTimersByTime(1_000));

    expect(updateSettings).toHaveBeenCalledWith({
      layout: { grid: expect.objectContaining({ panes: ["t-mine"] }) },
    });
  });
});
