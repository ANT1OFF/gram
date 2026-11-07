import { describe, expect, it } from "vitest";

import { autonomyForApproval, mergeApprovalOf, mergeApprovalSaved } from "./merge-approval";

describe("merge approval", () => {
  it("is Automatic at Full and Ask below it", () => {
    expect(mergeApprovalOf("full")).toBe("automatic");
    expect(mergeApprovalOf("publish")).toBe("ask");
    expect(mergeApprovalOf("supervised")).toBe("ask");
  });

  it("moves to Full for Automatic, and from Full down to Publish for Ask", () => {
    expect(autonomyForApproval("publish", "automatic")).toBe("full");
    expect(autonomyForApproval("supervised", "automatic")).toBe("full");
    expect(autonomyForApproval("full", "ask")).toBe("publish");
    // A level that already asks is kept.
    expect(autonomyForApproval("supervised", "ask")).toBe("supervised");
  });

  it("says in its Undo what the workspace now does, never only this task", () => {
    expect(mergeApprovalSaved("billing-api", "publish")).toBe(
      "Workspace billing-api now asks before merging",
    );
    expect(mergeApprovalSaved("billing-api", "full")).toBe(
      "Workspace billing-api now merges without asking",
    );
  });
});
