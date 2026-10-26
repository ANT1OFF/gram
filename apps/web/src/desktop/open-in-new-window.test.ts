// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useThreadsStore } from "@/stores/threads";

import { focusWindowShowing } from "./open-in-new-window";
import { currentWindow, resetCurrentWindow } from "./window-identity";
import { useWindowPlacements } from "./window-placements";

const T1 = "t1" as ThreadId;
const T2 = "t2" as ThreadId;

beforeEach(() => {
  window.sessionStorage.clear();
  resetCurrentWindow();
  const self = currentWindow();
  useWindowPlacements.setState({
    windows: [
      { windowId: self.id, name: self.name, threadIds: [T2] },
      { windowId: "w2", name: "Window 2", threadIds: [T1] },
    ],
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "gram");
  resetCurrentWindow();
  vi.restoreAllMocks();
});

describe("focusWindowShowing", () => {
  it("brings the desktop window forward instead of opening a duplicate", async () => {
    const focusWindow = vi.fn(async () => true);
    Object.assign(window, { gram: { platform: "darwin", focusWindow } });
    expect(await focusWindowShowing(T1)).toBe(true);
    expect(focusWindow).toHaveBeenCalledWith("w2", "t1");
    expect(await focusWindowShowing(T2)).toBe(false);
  });

  it("says which tab shows the thread in a browser", async () => {
    const notify = vi.spyOn(useThreadsStore.getState(), "applyEvent").mockImplementation(() => {});
    expect(await focusWindowShowing(T1)).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "info", title: "Open in Window 2" }),
    );
  });
});
