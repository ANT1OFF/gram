// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { useLayoutStore } from "./layout";

describe("layout storage", () => {
  it("persists panel width and rehydrates it from browser storage", async () => {
    expect(useLayoutStore.persist.getOptions().storage).toBeDefined();
    useLayoutStore.getState().setPanelWidth(420);
    const saved = window.localStorage.getItem("gram.layout")!;
    expect(JSON.parse(saved).state.panelWidth).toBe(420);
    useLayoutStore.getState().setPanelWidth(320);
    window.localStorage.setItem("gram.layout", saved);
    await useLayoutStore.persist.rehydrate();
    expect(useLayoutStore.getState().panelWidth).toBe(420);
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
});
