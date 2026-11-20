// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TreeList, type TreeNode } from "./tree-list";

afterEach(cleanup);

const TREE: readonly TreeNode[] = [
  {
    id: "eng",
    label: "Engineering",
    children: [
      { id: "platform", label: "Platform", children: [{ id: "jonas", label: "Jonas" }] },
      { id: "data", label: "Data" },
    ],
  },
];

const visible = (name: string) => screen.getByText(name).closest("ul")?.hidden !== true;

describe("TreeList", () => {
  it("opens every entry by default and folds an entry's children with its button", () => {
    render(<TreeList label="Teams" nodes={TREE} />);
    const platform = screen.getByRole("button", { name: "Platform" });
    expect(platform.getAttribute("aria-expanded")).toBe("true");
    expect(visible("Jonas")).toBe(true);
    fireEvent.click(platform);
    expect(platform.getAttribute("aria-expanded")).toBe("false");
    expect(visible("Jonas")).toBe(false);
    expect(visible("Data")).toBe(true);
  });

  it("starts with only the listed entries open, and opens one added later as asked", () => {
    const { rerender } = render(<TreeList label="Teams" nodes={TREE} defaultExpanded={["eng"]} />);
    expect(screen.getByRole("button", { name: "Platform" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    rerender(
      <TreeList
        label="Teams"
        defaultExpanded={["eng", "ops"]}
        nodes={[...TREE, { id: "ops", label: "Ops", children: [{ id: "lea", label: "Lea" }] }]}
      />,
    );
    expect(screen.getByRole("button", { name: "Ops" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves its folds to a tree you keep, and tells you the open set", () => {
    const onExpandedChange = vi.fn();
    render(
      <TreeList
        label="Teams"
        nodes={TREE}
        expanded={new Set(["eng"])}
        onExpandedChange={onExpandedChange}
      />,
    );
    const platform = screen.getByRole("button", { name: "Platform" });
    fireEvent.click(platform);
    const open = onExpandedChange.mock.calls[0]?.[0] as ReadonlySet<string>;
    expect([...open].toSorted()).toEqual(["eng", "platform"]);
    expect(platform.getAttribute("aria-expanded")).toBe("false");
  });
});
