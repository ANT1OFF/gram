import { describe, expect, it } from "@effect/vitest";
import {
  explainOwnershipBlocker,
  OWNERSHIP_BLOCKERS,
  ownershipAsk,
  ownershipForAgent,
  remoteNamesOtherRepo,
  remoteNamesRepo,
  remoteRepoOf,
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

/** The repository `remoteRepoOf` reads, as `owner/name`. */
const named = (url: string) => {
  const repo = remoteRepoOf(url);
  return repo === undefined ? undefined : `${repo.owner}/${repo.name}`;
};

/** Every way the property test spells a remote of `path` on `host`. */
const forms = (host: string, path: string) => [
  `https://${host}/${path}`,
  `https://${host}:443/${path}`,
  `https://${host}:8443/${path}`,
  `https://user@${host}/${path}`,
  `ssh://git@${host}/${path}`,
  `ssh://git@${host}:22/${path}`,
  `ssh://git@${host}:443/${path}`,
  `ssh://git@${host}:2222/${path}`,
  `git@${host}:${path}`,
  `https://${host}/prefix/${path}`,
];

/** Whether `owner/name` spells the property test's repository, acme/app. */
const isTarget = (owner: string, name: string) =>
  owner.toLowerCase() === "acme" && name.toLowerCase() === "app";

describe("remoteRepoOf", () => {
  it("reads a plain remote's repository, dropping one .git suffix in any case", () => {
    for (const url of [
      "https://github.com/acme/app",
      "https://github.com/acme/app.git",
      "https://github.com/acme/app.GIT",
      "https://github.com/acme/app.Git",
      "https://github.com/acme/app.gIt",
      "https://github.com/acme/app/",
      "https://github.com/acme/app.git/",
      "https://github.com:443/acme/app.git",
      "https://GitHub.com/acme/app.git",
      "https://user@github.com/acme/app.git",
      "ssh://git@github.com/acme/app.git",
      "ssh://git@github.com:22/acme/app.GIT",
      "ssh://git@ssh.github.com:443/acme/app.git",
      "git@github.com:acme/app.git",
      "git@github.com:acme/app.gIt",
      "github.com:acme/app",
      "https://ghe.example.test/acme/app.git",
      "ssh://git@ghe.example.test:2222/acme/app.git",
    ])
      expect(named(url), url).toBe("acme/app");
    expect(named("https://github.com/Acme-Co/my_app.v2.git")).toBe("Acme-Co/my_app.v2");
    expect(remoteRepoOf("ssh://git@ssh.github.com:443/acme/app.git")).toEqual({
      transport: "ssh",
      host: "ssh.github.com",
      port: "443",
      owner: "acme",
      name: "app",
    });
  });

  it("names no repository for an encoded, lookalike or extra-segment remote", () => {
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
      "https://github.com/.acme/app.git",
      "https://github.com/acme./app.git",
      "https://github.com/acme/..",
      "https://github.com/acme/app.git.git",
      "https://github.com/acme/app.GIT.git",
      "https://github.com/acme/.git",
      "https://github.com/acme\\app.git",
      "https://github.com/acme/ app.git",
      "https://.github.com/acme/app.git",
      "https://git_hub.com/acme/app.git",
      "file:///srv/acme/app.git",
      "/srv/acme/app.git",
      "",
    ])
      expect(remoteRepoOf(url), url).toBeUndefined();
  });

  it("only plainly names another repository on GitHub's own host and default port", () => {
    expect(remoteNamesOtherRepo("https://github.com/elsewhere/other.git", "acme/app")).toBe(true);
    expect(remoteNamesOtherRepo("git@github.com:elsewhere/other.git", "acme/app")).toBe(true);
    for (const url of [
      "https://ghe.example.test/elsewhere/other.git",
      "https://github.com:8443/elsewhere/other.git",
      "ssh://git@github.com:2222/elsewhere/other.git",
      "ssh.github.com:elsewhere/other.git",
      // Hosts spelled like keys every object inherits: no table lookup may find them.
      "https://constructor/elsewhere/other.git",
      "https://__proto__/elsewhere/other.git",
      "https://Constructor/elsewhere/other.git",
      "ssh://git@__proto__/elsewhere/other.git",
      "git@constructor:elsewhere/other.git",
      "https://toString/elsewhere/other.git",
      "https://hasOwnProperty/elsewhere/other.git",
      "https://valueOf/elsewhere/other.git",
    ])
      expect(remoteNamesOtherRepo(url, "acme/app"), url).toBe(false);
    expect(remoteNamesOtherRepo(undefined, "acme/app")).toBe(false);
    expect(remoteNamesRepo(undefined, "acme/app")).toBe(false);
  });

  it("never lets ownership and conflict detection disagree on a remote", () => {
    const hosts = [
      "github.com",
      "GitHub.com",
      "www.github.com",
      "ssh.github.com",
      "ghe.example.test",
      "constructor",
      "__proto__",
    ];
    const owners = ["acme", "ACME", "Acme", "%61cme", "\u0430cme", ".acme", "elsewhere"];
    const names = ["app", "App", "APP", "%61pp", "\u0430pp", "other", "app.v2"];
    const suffixes = [
      "",
      ".git",
      ".GIT",
      ".Git",
      ".gIt",
      "/",
      ".git/",
      ".GIT/",
      ".git.git",
      "/extra",
    ];
    let checked = 0;
    for (const host of hosts)
      for (const owner of owners)
        for (const name of names)
          for (const suffix of suffixes)
            for (const url of forms(host, `${owner}/${name}${suffix}`)) {
              checked++;
              const owns = remoteNamesRepo(url, "acme/app");
              const other = remoteNamesOtherRepo(url, "acme/app");
              // A remote ownership takes for the repository is never plainly another one.
              expect(owns && other, url).toBe(false);
              // A remote that spells the repository with any .git case is never plainly another.
              if (isTarget(owner, name)) expect(other, url).toBe(false);
              // Plainly another needs a plain parse on GitHub's own host and default port.
              if (other) {
                const read = remoteRepoOf(url)!;
                expect(read, url).toBeDefined();
                expect(isTarget(read.owner, read.name), url).toBe(false);
                expect(["github.com", "www.github.com", "ssh.github.com"]).toContain(read.host);
              }
            }
    expect(checked).toBe(hosts.length * owners.length * names.length * suffixes.length * 10);
  });
});
