import { describe, expect, it } from "vitest";
import type { Checkout } from "./domain.ts";
import { effectiveCheckout } from "./worktree-move.ts";

describe("effectiveCheckout", () => {
  const launch: Checkout = { kind: "main", path: "/work/repo" };
  const followed: Checkout = {
    kind: "worktree",
    path: "/work/repo/.worktrees/feat",
    repoRoot: "/work/repo",
  };

  it("is the followed worktree while there is one, else the launch checkout", () => {
    expect(effectiveCheckout({ checkout: launch })).toBe(launch);
    expect(effectiveCheckout({ checkout: launch, currentCheckout: followed })).toBe(followed);
  });
});
