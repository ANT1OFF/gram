import type { TaskId } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { taskCheckoutRequest } from "./task-checkout.ts";

const id = "24a89db0-966b-4f37-9310-f3b0e3eca3ef" as TaskId;
const HEAD = "9774440c0ffee";

describe("taskCheckoutRequest", () => {
  it("gives a task a worktree of its own unless it asks for the parent's", () => {
    expect(taskCheckoutRequest({ id }, HEAD)).toEqual({
      kind: "newWorktree",
      branch: "task-24a89db0",
      base: HEAD,
    });
    expect(taskCheckoutRequest({ id, checkout: "new-worktree" }, HEAD)).toMatchObject({
      kind: "newWorktree",
    });
    expect(taskCheckoutRequest({ id, checkout: "current" }, HEAD)).toBeUndefined();
  });

  it("branches from the parent's HEAD, or from the base the chip names", () => {
    expect(taskCheckoutRequest({ id, branch: "fix/spec" }, HEAD)).toEqual({
      kind: "newWorktree",
      branch: "fix/spec",
      base: HEAD,
    });
    expect(taskCheckoutRequest({ id, base: "origin/main" }, HEAD)).toMatchObject({
      base: "origin/main",
    });
  });

  it("shares the parent's folder where there is no commit to branch from", () => {
    expect(taskCheckoutRequest({ id }, undefined)).toBeUndefined();
    expect(taskCheckoutRequest({ id, checkout: "new-worktree" }, undefined)).toBeUndefined();
  });
});
