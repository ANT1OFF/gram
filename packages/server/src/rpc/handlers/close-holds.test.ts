import type { Checkout } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { heldForRemoval } from "./threads.ts";

const worktree: Checkout = {
  kind: "worktree",
  path: "/repo/.worktrees/fix",
  branch: "fix",
  repoRoot: "/repo",
};
const main: Checkout = { kind: "main", path: "/repo", branch: "main" };

describe("heldForRemoval", () => {
  it("holds the worktree being deleted, and where the thread follows the agent when elsewhere", () => {
    expect(heldForRemoval({ checkout: worktree }, true)).toEqual(["/repo/.worktrees/fix"]);
    expect(heldForRemoval({ checkout: worktree, currentCheckout: main }, true)).toEqual([
      "/repo/.worktrees/fix",
      "/repo",
    ]);
    // The same folder spelled another way is held once.
    expect(
      heldForRemoval(
        { checkout: worktree, currentCheckout: { ...worktree, path: "/repo/.worktrees/fix/" } },
        true,
      ),
    ).toEqual(["/repo/.worktrees/fix"]);
  });

  it("holds nothing when no worktree is removed", () => {
    expect(heldForRemoval({ checkout: worktree, currentCheckout: main }, false)).toEqual([]);
    expect(heldForRemoval({ checkout: main }, true)).toEqual([]);
  });
});
