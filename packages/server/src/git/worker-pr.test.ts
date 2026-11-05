import { describe, expect, it } from "@effect/vitest";
import { explainOwnershipBlocker, OWNERSHIP_BLOCKERS, ownershipForAgent } from "./worker-pr.ts";

describe("ownership blockers", () => {
  it("explains every blocker in plain words, with a fix", () => {
    expect(
      Object.values(OWNERSHIP_BLOCKERS).map((blocker) => explainOwnershipBlocker(blocker).reason),
    ).toEqual([
      "the worker no longer belongs to a workspace",
      "the worktree Gram gave the worker is gone, and its repository was never recorded",
      "its repository isn't a workspace project the worker has a worktree in",
      "it is in another repository than the worktree Gram gave the worker",
      "GitHub didn't say whether it is open",
      "its branch is on a fork, not in the repository itself",
      "its branch isn't checked out in a worktree Gram gave the worker",
      "GitHub didn't say which commit its head is",
      "its head moved after Gram checked it",
      "Gram couldn't read the worker's worktree or the pull request on GitHub",
    ]);
    for (const blocker of Object.values(OWNERSHIP_BLOCKERS))
      expect(explainOwnershipBlocker(blocker).fix).toMatch(/\.$/);
    expect(explainOwnershipBlocker("it is merged")).toEqual({
      reason: "it is merged, not open",
      fix: "There is nothing to merge; check it with pr_status.",
    });
  });

  it("tells the worker and its orchestrator each what they can do", () => {
    const blocker = OWNERSHIP_BLOCKERS.branchNotHeld;
    expect(ownershipForAgent(blocker, "worker")).toBe(
      "Full auto covers only a worker's own pull request, and Gram couldn't confirm this one is the worker's own: its branch isn't checked out in a worktree Gram gave the worker. Check the branch out inside the worktree Gram gave you (or ask your orchestrator to start a fresh worker for the follow-up), then call again. Gram can then merge it without asking.",
    );
    expect(ownershipForAgent(blocker, "orchestrator", "run it")).toBe(
      "Full auto covers only a worker's own pull request, and Gram couldn't confirm this one is the worker's own: its branch isn't checked out in a worktree Gram gave the worker. Have the worker check the branch out inside the worktree Gram gave it, or start a fresh worker for the follow-up. Gram can then run it without asking.",
    );
  });
});
