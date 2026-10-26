// @vitest-environment happy-dom
import type { ThreadId, WindowPlacement } from "@gram/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { focusOtherWindow } from "./open-thread";
import { useWindowPlacements } from "./window-placements";

const T = "t-flaky" as ThreadId;

const placements = (threadIds: string[]) =>
  [{ windowId: "win-2", name: "Window 2", threadIds }] as unknown as WindowPlacement[];

afterEach(() => {
  Reflect.deleteProperty(window, "gram");
  useWindowPlacements.setState({ windows: [] });
});

describe("focusOtherWindow", () => {
  it("brings forward the desktop window already showing the thread", async () => {
    const focusWindow = vi.fn(async () => true);
    Object.assign(window, { gram: { focusWindow } });
    useWindowPlacements.getState().setWindows(placements([T]));

    expect(focusOtherWindow(T)).toBe(true);
    await vi.waitFor(() => expect(focusWindow).toHaveBeenCalledWith("win-2", T));
  });

  it("opens here when no other window shows it, or in a browser tab", () => {
    const focusWindow = vi.fn(async () => true);
    Object.assign(window, { gram: { focusWindow } });
    useWindowPlacements.getState().setWindows(placements(["t-other"]));
    expect(focusOtherWindow(T)).toBe(false);

    Reflect.deleteProperty(window, "gram");
    useWindowPlacements.getState().setWindows(placements([T]));
    expect(focusOtherWindow(T)).toBe(false);
    expect(focusWindow).not.toHaveBeenCalled();
  });
});
