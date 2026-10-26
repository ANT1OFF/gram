import { describe, expect, it } from "vitest";

import { taskStart, taskStartLabel } from "./task-chip-model";

const repo = { repo: true, head: "9774440" };

describe("taskStart", () => {
  it("promises a worktree only where the server will make one", () => {
    expect(taskStart({}, repo)).toEqual({ kind: "worktree", branch: undefined });
    expect(taskStart({ branch: "fix/spec" }, repo)).toEqual({
      kind: "worktree",
      branch: "fix/spec",
    });
    // Not known yet: the common case, corrected when the state arrives.
    expect(taskStart({}, undefined)).toEqual({ kind: "worktree", branch: undefined });
  });

  it("says the folder is shared outside a repo or before a first commit, whatever was asked", () => {
    expect(taskStart({}, { repo: false, head: "" })).toEqual({ kind: "shared", asked: false });
    expect(taskStart({ checkout: "new-worktree" }, { repo: true, head: "" })).toEqual({
      kind: "shared",
      asked: false,
    });
    // A base the chip names is branched from, or refused: never silently shared.
    expect(taskStart({ base: "main" }, { repo: true, head: "" }).kind).toBe("worktree");
  });

  it("says so when the chip asked to share", () => {
    expect(taskStart({ checkout: "current" }, repo)).toEqual({ kind: "shared", asked: true });
  });
});

describe("taskStartLabel", () => {
  it("names the branch and the worktree, or why the folder is shared", () => {
    expect(taskStartLabel({ kind: "worktree", branch: undefined })).toBe(
      "new branch · new worktree",
    );
    expect(taskStartLabel({ kind: "worktree", branch: "fix/spec" })).toBe(
      "fix/spec · new worktree",
    );
    expect(taskStartLabel({ kind: "shared", asked: true })).toBe("shares this thread's checkout");
    expect(taskStartLabel({ kind: "shared", asked: false })).toBe(
      "shares this thread's folder · no commit to branch from",
    );
  });
});
