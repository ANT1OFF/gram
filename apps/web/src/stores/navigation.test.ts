// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { toggleOverviewSidebar } from "@/views/shell-layout";

import { useLayoutStore } from "./layout";
import {
  DEFAULT_NAVIGATION,
  hostNavigationPrefs,
  navigationLayout,
  navigationNow,
  useNavigationStore,
} from "./navigation";

afterEach(() => {
  useNavigationStore.setState({
    host: {},
    picked: {},
    revealed: false,
    shown: false,
    hideTick: 0,
    sheet: false,
  });
});

describe("the navigation's layout", () => {
  it("is Gram's own sidebar, always shown, with nothing set", () => {
    expect(DEFAULT_NAVIGATION).toEqual({ position: "side", autoHide: false });
    expect(navigationLayout({ host: {}, picked: {} })).toEqual(DEFAULT_NAVIGATION);
    expect(hostNavigationPrefs(undefined)).toEqual({});
    expect(hostNavigationPrefs({})).toEqual({});
  });

  it("takes the embedding app's dock and edge, bottom by default", () => {
    expect(hostNavigationPrefs({ position: "dock" })).toEqual({ position: "bottom" });
    expect(hostNavigationPrefs({ position: "dock", edge: "top" })).toEqual({ position: "top" });
    expect(hostNavigationPrefs({ position: "side", edge: "top" })).toEqual({ position: "side" });
    expect(hostNavigationPrefs({ autoHide: true })).toEqual({ autoHide: true });
    expect(
      hostNavigationPrefs({ position: "floating", autoHide: "yes" } as unknown as Parameters<
        typeof hostNavigationPrefs
      >[0]),
    ).toEqual({});
  });

  it("puts the person's pick over the embedding app's default", () => {
    const host = hostNavigationPrefs({ position: "dock", edge: "top", autoHide: true });
    expect(navigationLayout({ host, picked: {} })).toEqual({ position: "top", autoHide: true });
    expect(navigationLayout({ host, picked: { position: "side" } })).toEqual({
      position: "side",
      autoHide: true,
    });
    expect(navigationLayout({ host, picked: { autoHide: false } })).toEqual({
      position: "top",
      autoHide: false,
    });
  });

  it("keeps only the person's pick across launches, and drops what it doesn't know", async () => {
    const store = useNavigationStore;
    store.getState().setHost({ position: "dock" });
    store.getState().pick({ position: "top" });
    const saved = JSON.parse(localStorage.getItem("gram.navigation") ?? "{}") as {
      state: unknown;
    };
    expect(saved.state).toEqual({ picked: { position: "top" } });
    localStorage.setItem(
      "gram.navigation",
      JSON.stringify({ state: { picked: { position: "left", autoHide: 1 } }, version: 1 }),
    );
    await store.persist.rehydrate();
    expect(store.getState().picked).toEqual({});
    localStorage.removeItem("gram.navigation");
  });
});

describe("⌘B with the navigation away from the sidebar", () => {
  it("toggles the sidebar itself by default", () => {
    const before = useLayoutStore.getState().overviewSidebar;
    toggleOverviewSidebar();
    expect(useLayoutStore.getState().overviewSidebar).not.toBe(before);
    toggleOverviewSidebar();
    expect(useNavigationStore.getState().revealed).toBe(false);
    expect(useNavigationStore.getState().sheet).toBe(false);
  });

  it("shows an auto-hidden navigation, and hides it once it is in view", () => {
    useNavigationStore.getState().setHost({ autoHide: true });
    const sidebar = useLayoutStore.getState().overviewSidebar;
    toggleOverviewSidebar();
    expect(useNavigationStore.getState().revealed).toBe(true);
    useNavigationStore.getState().setShown(true);
    toggleOverviewSidebar();
    expect(useNavigationStore.getState().revealed).toBe(false);
    expect(useNavigationStore.getState().hideTick).toBe(1);
    expect(useLayoutStore.getState().overviewSidebar).toBe(sidebar);
  });

  it("opens and closes the dock's Overview", () => {
    useNavigationStore.getState().setHost({ position: "dock" });
    expect(navigationNow().position).toBe("bottom");
    toggleOverviewSidebar();
    expect(useNavigationStore.getState().sheet).toBe(true);
    toggleOverviewSidebar();
    expect(useNavigationStore.getState().sheet).toBe(false);
  });
});
