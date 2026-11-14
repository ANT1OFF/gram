import { describe, expect, it } from "@effect/vitest";
import {
  explainOwnershipBlocker,
  OWNERSHIP_BLOCKERS,
  ownershipAsk,
  ownershipForAgent,
  plainGitHubRepoOf,
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
      "the machine the worker runs on didn't confirm that the worktree Gram made there still has its branch and its repository",
      "the worktree Gram made on the worker's machine is older than Gram's record of which repository it cloned there",
      "another thread has it as its pull request, or holds its branch in a worktree of its own, so it is that thread's work even where the worker has the branch checked out",
    ]);
    for (const blocker of Object.values(OWNERSHIP_BLOCKERS))
      expect(explainOwnershipBlocker(blocker).fix).toMatch(/\.$/);
    // A blocker spelled like an inherited key is explained as any unknown one, never by the key.
    for (const inherited of ["constructor", "__proto__", "toString", "hasOwnProperty"])
      expect(explainOwnershipBlocker(inherited)).toEqual({
        reason: inherited,
        fix: "Call again in a minute; if it keeps happening, the user has to approve it.",
      });
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

describe("plainGitHubRepoOf", () => {
  it("names a repository only from a plain GitHub URL", () => {
    for (const url of [
      "https://github.com/acme/app",
      "https://github.com/acme/app.git",
      "https://github.com/acme/app/",
      "https://github.com:443/acme/app.git",
      "https://GitHub.com/acme/app.git",
      "ssh://git@github.com/acme/app.git",
      "ssh://git@github.com:22/acme/app.git",
      "ssh://git@ssh.github.com:443/acme/app.git",
      "git@github.com:acme/app.git",
      "github.com:acme/app",
    ])
      expect(plainGitHubRepoOf(url), url).toBe("acme/app");
    expect(plainGitHubRepoOf("https://github.com/Acme-Co/my_app.v2.git")).toBe("Acme-Co/my_app.v2");
  });

  it("names nothing for an encoded, lookalike, extra-segment or other-host URL", () => {
    for (const url of [
      "https://github.com/%61cme/app.git",
      "https://github.com/acme/%61pp.git",
      "https://github.com/acme%2Fapp.git",
      "https://github.com/acme/\u0430pp.git",
      "https://github.com/acme/app\uff0egit",
      "https://github.com/prefix/acme/app.git",
      "https://github.com/123/acme/app.git",
      "https://github.com/acme/app/extra.git",
      "https://github.com/acme/app.git?x=1",
      "https://github.com/acme/app.git#x",
      "https://user@github.com/acme/app.git",
      "https://github.com:8443/acme/app.git",
      "ssh://git@github.com:2222/acme/app.git",
      "ssh.github.com:acme/app.git",
      "https://ghe.example.test/acme/app.git",
      "https://github.com/.acme/app.git",
      "https://github.com/acme./app.git",
      "https://github.com/acme/..",
      "https://github.com/acme/app.git.git",
      "https://github.com/acme\\app.git",
      "https://github.com/acme/ app.git",
      "file:///srv/acme/app.git",
      // Hosts spelled like keys every object inherits: no table lookup may find them.
      "https://constructor/elsewhere/other.git",
      "https://__proto__/elsewhere/other.git",
      "https://Constructor/elsewhere/other.git",
      "ssh://git@__proto__/elsewhere/other.git",
      "ssh://git@constructor:22/elsewhere/other.git",
      "git@constructor:elsewhere/other.git",
      "git@__proto__:elsewhere/other.git",
      "https://toString/elsewhere/other.git",
      "https://hasOwnProperty/elsewhere/other.git",
      "https://valueOf/elsewhere/other.git",
      "/srv/acme/app.git",
      "",
    ])
      expect(plainGitHubRepoOf(url), url).toBeUndefined();
  });
});
