import { describe, expect, it } from "@effect/vitest";
import {
  explainOwnershipBlocker,
  OWNERSHIP_BLOCKERS,
  ownershipAsk,
  ownershipForAgent,
} from "./worker-pr.ts";

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

  it("never tells an agent to wait on an approval that can't act", () => {
    // local_check rechecks ownership after its card, so approving it runs nothing.
    const fork = ownershipAsk(
      OWNERSHIP_BLOCKERS.fork,
      "worker",
      "runs Gram's check of a worker's own pull request",
      "Gram checks only a worker's own pull request, so approving won't run it either.",
      "run it",
      false,
    );
    expect(fork.user).toBe(
      "Full auto runs Gram's check of a worker's own pull request without asking, but Gram couldn't confirm this one is the worker's own: its branch is on a fork, not in the repository itself. Gram checks only a worker's own pull request, so approving won't run it either.",
    );
    expect(fork.agent).toBe(
      "Full auto covers only a worker's own pull request, and Gram couldn't confirm this one is the worker's own: its branch is on a fork, not in the repository itself. Push the branch to the repository from the worktree Gram gave you and open the pull request from there. Gram can then run it without asking. The user's approval doesn't change this: Gram refuses it for a pull request that isn't the worker's own.",
    );
    const gone = ownershipAsk(OWNERSHIP_BLOCKERS.noWorkspace, "worker", "", "", "run it", false);
    expect(gone.agent).not.toContain("has to approve");
    expect(gone.agent).toContain("otherwise rely on CI");
  });
});
