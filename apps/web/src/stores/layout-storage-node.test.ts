import { describe, expect, it, vi } from "vitest";

import { useLayoutStore } from "./layout";

describe("intentional Node storage opt-out", () => {
  it("keeps Node without a window and reports unavailable persistence", () => {
    expect(typeof window).toBe("undefined");
    expect(useLayoutStore.persist).toBeUndefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      useLayoutStore.getState().setPanelWidth(420);
      expect(useLayoutStore.getState().panelWidth).toBe(420);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "[zustand persist middleware] Unable to update item 'gram.layout', the given storage is currently unavailable.",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
