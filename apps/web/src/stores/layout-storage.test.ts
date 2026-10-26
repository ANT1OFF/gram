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
