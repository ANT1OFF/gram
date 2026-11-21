// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { layOut, TreeChart } from "./tree-chart";
import type { TreeNode } from "./tree-list";

afterEach(cleanup);

const TREE: readonly TreeNode[] = [
  {
    id: "lead",
    label: "Lead",
    children: [
      {
        id: "a",
        label: "A",
        children: [
          { id: "a1", label: "A1" },
          { id: "a2", label: "A2" },
        ],
      },
      { id: "b", label: "B" },
    ],
  },
];

describe("TreeChart", () => {
  it("puts each parent over the middle of its open children and leaves folded ones out", () => {
    const all = layOut(TREE, () => true, 100, 40);
    const at = new Map(all.placed.map((entry) => [entry.node.id, entry]));
    expect([at.get("a1")!.x, at.get("a2")!.x, at.get("b")!.x]).toEqual([0, 116, 232]);
    expect(at.get("a")!.x).toBe(58);
    expect(at.get("lead")!.x).toBe((58 + 232) / 2);
    expect(at.get("a1")!.y).toBe(160);
    const folded = layOut(TREE, (id) => id === "lead", 100, 40);
    expect(folded.placed.map((entry) => entry.node.id)).toEqual(["lead", "a", "b"]);
    expect(folded.placed.find((entry) => entry.node.id === "a")!.hidden).toBe(2);
  });

  it("stands children that open nothing in one column under their box", () => {
    const stacked = layOut(TREE, (id) => id === "lead", 100, 40, true);
    const at = new Map(stacked.placed.map((entry) => [entry.node.id, entry]));
    expect(at.get("a")!.x).toBe(at.get("b")!.x);
    expect(at.get("a")!.x).toBeGreaterThan(at.get("lead")!.x);
    expect(at.get("b")!.y).toBeGreaterThan(at.get("a")!.y);
    expect(at.get("a")!.stacked).toBe(true);
    const mixed = layOut(TREE, () => true, 100, 40, true);
    const by = new Map(mixed.placed.map((entry) => [entry.node.id, entry]));
    expect(by.get("a")!.stacked).toBeUndefined();
    expect(by.get("a")!.parent).toEqual({ x: by.get("lead")!.x, y: 0 });
    expect(by.get("a1")!.stacked).toBe(true);
  });

  it("starts with the top open, and opens a box's children with the button under it", () => {
    render(<TreeChart label="People" nodes={TREE} />);
    expect(screen.queryByText("A1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open A" }));
    expect(screen.getByText("A1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fold Lead" }));
    expect(screen.queryByText("A")).toBeNull();
  });
});
