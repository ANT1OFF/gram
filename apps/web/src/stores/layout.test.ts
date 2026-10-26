// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  assignPane,
  closePaneAt,
  cycleFocusIn,
  EMPTY_GRID,
  MIN_PANE_SHARE,
  moveFocusIn,
  openThreadIn,
  overviewFoldKey,
  resizeFractions,
  sanitizeWorkspacesView,
  swapPanes,
  toggleSplitIn,
  useLayoutStore,
  withPreset,
  type GridState,
} from "./layout";

const t = (id: string) => id as ThreadId;
const grid = (overrides: Partial<GridState>): GridState => ({ ...EMPTY_GRID, ...overrides });

describe("withPreset", () => {
  it("pads with empty panes when growing, keeps focus and resets fractions", () => {
    const next = withPreset(
      grid({ preset: "2c", panes: [t("a"), t("b")], focused: 1, colFr: [2, 1] }),
      "2x2",
    );
    expect(next).toMatchObject({ preset: "2x2", panes: ["a", "b", null, null], focused: 1 });
    expect(next.colFr).toBeUndefined();
  });

  it("keeps the focused thread when shrinking", () => {
    const next = withPreset(
      grid({ preset: "2x2", panes: [t("a"), null, t("b"), t("c")], focused: 3 }),
      "2c",
    );
    expect(next).toMatchObject({ panes: ["c", "a"], focused: 0 });
  });

  it("compacts threads when shrinking", () => {
    const next = withPreset(
      grid({ preset: "3c", panes: [null, t("a"), t("b")], focused: 1 }),
      "2c",
    );
    expect(next).toMatchObject({ panes: ["a", "b"], focused: 0 });
  });

  it("leaves maximize", () => {
    const start = grid({ preset: "2c", panes: [t("a"), null], maximized: true });
    expect(withPreset(start, "3c").maximized).toBe(false);
  });
});

describe("assigning threads", () => {
  it("loads a thread into the focused pane", () => {
    const next = openThreadIn(grid({ preset: "2c", panes: [t("a"), null], focused: 1 }), t("b"));
    expect(next).toMatchObject({ panes: ["a", "b"], focused: 1 });
  });

  it("focuses the pane that already shows the thread instead of duplicating it", () => {
    const start = grid({ preset: "2c", panes: [t("a"), t("b")], focused: 0 });
    expect(openThreadIn(start, t("b"))).toMatchObject({ panes: ["a", "b"], focused: 1 });
    expect(assignPane(start, 0, t("b"))).toMatchObject({ panes: ["a", "b"], focused: 1 });
  });

  it("drops into a pane and focuses it", () => {
    const start = grid({ preset: "2x2", panes: [t("a"), null, null, null] });
    expect(assignPane(start, 2, t("c"))).toMatchObject({
      panes: ["a", null, "c", null],
      focused: 2,
    });
  });

  it("ignores panes out of range", () => {
    const start = grid({ preset: "2c", panes: [t("a"), null] });
    expect(assignPane(start, 5, t("c"))).toBe(start);
    expect(closePaneAt(start, 5)).toBe(start);
  });

  it("empties a closed pane, moves focus to a pane with a thread and leaves maximize", () => {
    const start = grid({ preset: "2c", panes: [t("a"), t("b")], focused: 1, maximized: true });
    expect(closePaneAt(start, 1)).toMatchObject({
      panes: ["a", null],
      focused: 0,
      maximized: false,
    });
  });

  it("keeps focus when closing another pane", () => {
    const start = grid({ preset: "3c", panes: [t("a"), t("b"), t("c")], focused: 0 });
    expect(closePaneAt(start, 2)).toMatchObject({ panes: ["a", "b", null], focused: 0 });
  });

  it("focuses the nearest pane across the grid, then the next in reading order", () => {
    // 2×3: the pane below is one step away; the pane after it in reading order is two.
    const tall = grid({
      preset: "2x3",
      panes: [t("a"), t("b"), t("c"), null, null, t("f")],
      focused: 1,
    });
    expect(closePaneAt(tall, 1).focused).toBe(0);
    const square = grid({ preset: "2x2", panes: [t("a"), t("b"), t("c"), t("d")], focused: 1 });
    expect(closePaneAt(square, 1).focused).toBe(3);
    expect(
      closePaneAt(grid({ preset: "3c", panes: [t("a"), null, t("c")], focused: 2 }), 2),
    ).toMatchObject({ focused: 0 });
  });
});

describe("cycleFocusIn", () => {
  it("steps through the panes with a thread, wrapping around", () => {
    const start = grid({ preset: "2x2", panes: [t("a"), null, t("c"), t("d")], focused: 0 });
    expect(cycleFocusIn(start, 1).focused).toBe(2);
    expect(cycleFocusIn({ ...start, focused: 3 }, 1).focused).toBe(0);
    expect(cycleFocusIn(start, -1).focused).toBe(3);
    expect(cycleFocusIn({ ...start, focused: 1 }, -1).focused).toBe(0);
  });

  it("steps through every pane with fewer than two threads, and ignores a single pane", () => {
    const start = grid({ preset: "3c", panes: [t("a"), null, null], focused: 0 });
    expect(cycleFocusIn(start, 1).focused).toBe(1);
    expect(cycleFocusIn(start, -1).focused).toBe(2);
    const single = grid({ panes: [t("a")] });
    expect(cycleFocusIn(single, 1)).toBe(single);
  });
});

describe("swapPanes", () => {
  it("swaps two panes and focuses the moved thread", () => {
    const start = grid({ preset: "3c", panes: [t("a"), null, t("c")], focused: 0 });
    expect(swapPanes(start, 0, 1)).toMatchObject({ panes: [null, "a", "c"], focused: 1 });
    expect(swapPanes(start, 2, 0)).toMatchObject({ panes: ["c", null, "a"], focused: 0 });
    expect(swapPanes(start, 1, 1)).toBe(start);
    expect(swapPanes(start, 0, 7)).toBe(start);
  });
});

describe("moveFocusIn", () => {
  it("moves to neighbours and stops at the edges", () => {
    const start = grid({ preset: "2x3", panes: [null, null, null, null, null, null], focused: 0 });
    expect(moveFocusIn(start, "right").focused).toBe(1);
    expect(moveFocusIn(start, "left").focused).toBe(0);
    expect(moveFocusIn(start, "down").focused).toBe(2);
    expect(moveFocusIn({ ...start, focused: 5 }, "down").focused).toBe(5);
    expect(moveFocusIn({ ...start, focused: 5 }, "up").focused).toBe(3);
  });
});

describe("toggleSplitIn", () => {
  it("splits beside the candidate, then unsplits to the focused thread", () => {
    const split = toggleSplitIn(grid({ panes: [t("a")] }), t("b"));
    expect(split).toMatchObject({ preset: "2c", panes: ["a", "b"], focused: 0 });
    expect(toggleSplitIn({ ...split, focused: 1 }, undefined)).toMatchObject({
      preset: "1",
      panes: ["b"],
      focused: 0,
    });
  });
});

describe("resizeFractions", () => {
  it("moves the boundary between two neighbours and keeps their total", () => {
    expect(resizeFractions([1, 1, 1], 1, 0.75)).toEqual([1, 1.5, 0.5]);
  });

  it("clamps so no pane collapses", () => {
    const [a, b] = resizeFractions([1, 1], 0, 0);
    expect(a).toBeCloseTo(2 * MIN_PANE_SHARE);
    expect(a! + b!).toBeCloseTo(2);
  });
});

describe("layout store", () => {
  beforeEach(() => useLayoutStore.setState({ grid: EMPTY_GRID }));

  it("opens threads, switches presets, focuses panes, maximizes and resizes", () => {
    const s = useLayoutStore.getState;
    s().openThread(t("a"));
    s().setPreset("2c");
    s().openInPane(t("b"), 1);
    expect(s().grid).toMatchObject({ panes: ["a", "b"], focused: 1 });

    s().focusPane(0);
    s().toggleMaximize();
    expect(s().grid).toMatchObject({ focused: 0, maximized: true });

    s().setFractions("col", [3, 1]);
    expect(s().grid.colFr).toEqual([3, 1]);
    s().setFractions("col", [1, 1, 1]);
    expect(s().grid.colFr).toEqual([3, 1]);
    s().resetFractions();
    expect(s().grid.colFr).toBeUndefined();
  });

  it("doesn't maximize a single pane", () => {
    useLayoutStore.getState().openThread(t("a"));
    useLayoutStore.getState().toggleMaximize();
    expect(useLayoutStore.getState().grid.maximized).toBe(false);
  });
});

describe("an orchestrator's fold in the overview", () => {
  const key = overviewFoldKey("ws-1");
  beforeEach(() => useLayoutStore.setState({ workspacesCollapsedNodes: [] }));

  it("is listed while folded, beside the board's folds, and a forced side holds", () => {
    const s = useLayoutStore.getState;
    useLayoutStore.setState({ workspacesCollapsedNodes: ["board:ws-1/group:billing"] });
    s().toggleWorkspaceNode(key);
    expect(s().workspacesCollapsedNodes).toEqual(["board:ws-1/group:billing", "overview:ws-1"]);
    s().toggleWorkspaceNode(key, true);
    expect(s().workspacesCollapsedNodes).toEqual(["board:ws-1/group:billing", "overview:ws-1"]);
    s().toggleWorkspaceNode(key);
    expect(s().workspacesCollapsedNodes).toEqual(["board:ws-1/group:billing"]);
    s().toggleWorkspaceNode(key, false);
    expect(s().workspacesCollapsedNodes).toEqual(["board:ws-1/group:billing"]);
    // Each workspace keeps its own.
    expect(overviewFoldKey("ws-2")).not.toBe(key);
  });

  it("is kept across a reload with the rest of the layout", async () => {
    useLayoutStore.getState().toggleWorkspaceNode(key);
    const saved = localStorage.getItem("gram.layout") ?? "{}";
    const stored = JSON.parse(saved) as { state?: { workspacesCollapsedNodes?: unknown } };
    expect(stored.state?.workspacesCollapsedNodes).toEqual([key]);
    useLayoutStore.setState({ workspacesCollapsedNodes: [] });
    localStorage.setItem("gram.layout", saved);
    await useLayoutStore.persist.rehydrate();
    expect(useLayoutStore.getState().workspacesCollapsedNodes).toEqual([key]);
    expect(sanitizeWorkspacesView({ workspacesCollapsedNodes: [key, 7] })).toEqual({
      workspacesCollapsedNodes: [key],
    });
  });
});
