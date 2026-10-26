import { describe, expect, it, vi } from "vitest";

import { claimSingleInstance, surfaceWindow, type FocusableWindow } from "./instance.ts";

const fakeWindow = (minimized: boolean) => {
  const calls: Array<string> = [];
  const win: FocusableWindow = {
    isMinimized: () => minimized,
    restore: () => void calls.push("restore"),
    show: () => void calls.push("show"),
    focus: () => void calls.push("focus"),
  };
  return { win, calls };
};

describe("claimSingleInstance", () => {
  it("keeps the first launch and quits a second one", () => {
    const first = { requestSingleInstanceLock: () => true, quit: vi.fn() };
    expect(claimSingleInstance(first)).toBe(true);
    expect(first.quit).not.toHaveBeenCalled();

    const second = { requestSingleInstanceLock: () => false, quit: vi.fn() };
    expect(claimSingleInstance(second)).toBe(false);
    expect(second.quit).toHaveBeenCalledOnce();
  });
});

describe("surfaceWindow", () => {
  it("restores and focuses the first window", () => {
    const { win, calls } = fakeWindow(true);
    const open = vi.fn();
    surfaceWindow([win], open);
    expect(calls).toEqual(["restore", "show", "focus"]);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens a window when none is left", () => {
    const open = vi.fn();
    surfaceWindow([], open);
    expect(open).toHaveBeenCalledOnce();
  });
});
