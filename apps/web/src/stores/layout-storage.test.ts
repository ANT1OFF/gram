// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useLayoutStore } from "./layout";

beforeEach(() => {
  expect(window.localStorage.length).toBe(0);
  expect(window.sessionStorage.length).toBe(0);
});

describe("layout browser storage fixture", () => {
  it("persists panel width and rehydrates it from browser storage", async () => {
    expect(useLayoutStore.persist.getOptions().storage).toBeDefined();
    useLayoutStore.getState().setPanelWidth(420);
    const saved = window.localStorage.getItem("gram.layout")!;
    expect(JSON.parse(saved).state.panelWidth).toBe(420);
    useLayoutStore.getState().setPanelWidth(320);
    window.localStorage.setItem("gram.layout", saved);
    await useLayoutStore.persist.rehydrate();
    expect(useLayoutStore.getState().panelWidth).toBe(420);
    window.sessionStorage.setItem("owned-session", "previous test");
  });

  it("opens a board saved on the lanes on the grid, and forgets the old layout", async () => {
    window.localStorage.setItem(
      "gram.layout",
      JSON.stringify({
        state: { boardLayout: "lanes", boardArchivedShown: ["w-1"], panelWidth: 400 },
        version: 1,
      }),
    );
    await useLayoutStore.persist.rehydrate();
    const state = useLayoutStore.getState() as unknown as Record<string, unknown>;
    expect(state["boardLayout"]).toBeUndefined();
    expect(state["boardArchivedShown"]).toEqual(["w-1"]);
    expect(state["panelWidth"]).toBe(400);
    // The next write leaves the old field out of storage.
    useLayoutStore.getState().toggleBoardArchived("w-2");
    const saved = JSON.parse(window.localStorage.getItem("gram.layout")!).state;
    expect(saved).not.toHaveProperty("boardLayout");
    expect(saved.boardArchivedShown).toEqual(["w-1", "w-2"]);
  });

  it("starts with empty storage and uses actual Web Storage keys, strings and removal", () => {
    const storage = window.localStorage;
    storage.setItem("owned-key", "value");
    storage.setItem("owned-key", "replacement");
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe("owned-key");
    expect(storage.key(1)).toBeNull();
    expect(storage.getItem("owned-key")).toBe("replacement");
    storage.removeItem("owned-key");
    expect(storage.getItem("owned-key")).toBeNull();
    storage.setItem("owned-leak-sentinel", "next test must not inherit this");
    window.sessionStorage.setItem("owned-leak-sentinel", "session too");
  });

  it("keeps an intentionally denied storage getter observable", () => {
    const denied = new Error("Owned synthetic storage refusal");
    const getter = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw denied;
    });
    try {
      expect(() => window.localStorage).toThrow(denied);
    } finally {
      getter.mockRestore();
    }
  });
});
