import type { GitState } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { closeWarning, waitingWarning } from "./close-warning";

const git = (patch: Partial<GitState> = {}): GitState => ({
  repo: true,
  worktree: true,
  head: "abc",
  changesToken: "t",
  changedFiles: 0,
  behindBase: 0,
  aheadBase: 0,
  conflicts: false,
  base: "origin/main",
  ...patch,
});

describe("closeWarning", () => {
  it("is silent for a clean, merged or unknown checkout", () => {
    expect(closeWarning(undefined)).toBeUndefined();
    expect(closeWarning(git())).toBeUndefined();
    expect(closeWarning(git({ repo: false, changedFiles: 3 }))).toBeUndefined();
  });

  it("names uncommitted changes and unmerged commits", () => {
    expect(closeWarning(git({ changedFiles: 1 }))).toBe("This worktree has 1 uncommitted change.");
    expect(closeWarning(git({ changedFiles: 2, aheadBase: 3, conflicts: true }))).toBe(
      "This worktree has 2 uncommitted changes and 3 commits not merged to main. Merging it into the base branch would conflict.",
    );
  });

  it("ignores commits a squash-merged PR already carries", () => {
    const pr = { number: 1, state: "MERGED", aheadOfPr: false } as NonNullable<GitState["pr"]>;
    expect(closeWarning(git({ aheadBase: 4, pr }))).toBeUndefined();
  });
});

describe("waitingWarning", () => {
  it("names what still waits on the user, and counts past three", () => {
    expect(waitingWarning(undefined)).toBeUndefined();
    expect(waitingWarning([])).toBeUndefined();
    expect(waitingWarning([{ title: "Teams message" }])).toBe(
      "1 thing still waits on you here: “Teams message”. Closing leaves it undone.",
    );
    const four = ["a", "b", "c", "d"].map((title) => ({ title }));
    expect(waitingWarning(four)).toBe(
      "4 things still wait on you here: “a”, “b”, “c” and 1 more. Closing leaves them undone.",
    );
  });
});
