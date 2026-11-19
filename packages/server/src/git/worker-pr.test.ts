import { afterAll, describe, expect, it } from "@effect/vitest";
import { Proc, type ProcOutput, ProcSpawnError, ProcTimeout } from "@gram/git";
import * as Effect from "effect/Effect";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  explainOwnershipBlocker,
  liveHeadAt,
  OWNERSHIP_BLOCKERS,
  ownershipFix,
  ownershipRefusalText,
  prHostOf,
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
      "the worktree Gram gave the worker is older than Gram's record of which repository it was made from",
      "another thread has it as its pull request, or holds its branch in a worktree of its own, so it is that thread's work even where the worker has the branch checked out",
    ]);
    for (const blocker of Object.values(OWNERSHIP_BLOCKERS))
      expect(explainOwnershipBlocker(blocker).fix).toMatch(/\.$/);
    // A blocker spelled like an inherited key is explained as any unknown one, never by the key.
    for (const inherited of ["constructor", "__proto__", "toString", "hasOwnProperty"])
      expect(explainOwnershipBlocker(inherited)).toEqual({
        reason: inherited,
        fix: "Retry the ownership check; ask your orchestrator if it persists.",
      });
    expect(explainOwnershipBlocker("it is merged")).toEqual({
      reason: "it is merged, not open",
      fix: "There is nothing to merge; check it with pr_status.",
    });
  });

  it("tells the worker and its orchestrator each what they can do", () => {
    const blocker = OWNERSHIP_BLOCKERS.branchNotHeld;
    expect(ownershipFix(blocker, "worker")).toBe(
      "Check the branch out inside the worktree Gram gave you (or ask your orchestrator to start a fresh worker for the follow-up), then call again. Gram can then merge it without asking.",
    );
    expect(ownershipFix(blocker, "orchestrator", "run it")).toBe(
      "Have the worker check the branch out inside the worktree Gram gave it, or start a fresh worker for the follow-up. Gram can then run it without asking.",
    );
  });

  it("gives every ownership doubt repair guidance at full, with no approval escape", () => {
    for (const blocker of Object.values(OWNERSHIP_BLOCKERS))
      for (const audience of ["worker", "orchestrator"] as const) {
        const refusal = ownershipRefusalText(blocker, audience, "merge_when_ready");
        expect(refusal).toContain(explainOwnershipBlocker(blocker).reason);
        expect(refusal).toContain("Then call merge_when_ready again so Gram verifies ownership");
        expect(refusal).toContain("The call was refused; the user wasn't asked.");
        expect(refusal).not.toMatch(/has to approve|user has to add|user's approval/);
      }
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
    expect(remoteNamesRepo(undefined, "acme/app", "github.com")).toBe(false);
  });

  it("owns a remote only on its PR's own host", () => {
    // A PR on GitHub: GitHub's own hosts and their explicit aliases, nothing that only looks so.
    for (const url of [
      "https://github.com/acme/app.git",
      "https://www.github.com/acme/app.git",
      "ssh://git@ssh.github.com:443/acme/app.git",
      "git@github.com:acme/app.git",
    ])
      expect(remoteNamesRepo(url, "acme/app", "github.com"), url).toBe(true);
    for (const url of [
      "https://github.com.evil.example/acme/app.git",
      "https://github-com.example/acme/app.git",
      "https://evil.example/acme/app.git",
      "git@github.com.evil.example:acme/app.git",
      "https://api.github.com/acme/app.git",
      "https://ghe.example.test/acme/app.git",
      "https://constructor/acme/app.git",
      "https://__proto__/acme/app.git",
    ])
      expect(remoteNamesRepo(url, "acme/app", "github.com"), url).toBe(false);
    // An Enterprise PR: its own host exactly, never GitHub's or a neighbour's.
    expect(
      remoteNamesRepo("https://ghe.example.test/acme/app.git", "acme/app", "ghe.example.test"),
    ).toBe(true);
    expect(
      remoteNamesRepo("git@GHE.example.test:acme/app.git", "acme/app", "ghe.example.test"),
    ).toBe(true);
    for (const url of [
      "https://github.com/acme/app.git",
      "git@github.com:acme/app.git",
      "https://ghe.example.test.evil.example/acme/app.git",
      "https://other-ghe.example.test/acme/app.git",
      "https://www.ghe.example.test/acme/app.git",
    ])
      expect(remoteNamesRepo(url, "acme/app", "ghe.example.test"), url).toBe(false);
    // The right host, the wrong repository.
    expect(remoteNamesRepo("https://github.com/acme/other.git", "acme/app", "github.com")).toBe(
      false,
    );
  });

  it("reads the host a PR's URL is on", () => {
    expect(prHostOf("https://github.com/acme/app/pull/12")).toBe("github.com");
    expect(prHostOf("https://GHE.example.test/acme/app/pull/12")).toBe("ghe.example.test");
    expect(prHostOf("https://ghe.example.test:8443/acme/app/pull/12")).toBe("ghe.example.test");
    for (const url of [
      "",
      "http://github.com/acme/app/pull/12",
      "https://.github.com/x",
      "github.com/acme/app/pull/1",
      "https://git\u0068ub.com\u2024/x",
    ])
      expect(prHostOf(url), url).toBeUndefined();
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
              const owns = remoteNamesRepo(url, "acme/app", "github.com");
              const other = remoteNamesOtherRepo(url, "acme/app");
              // A remote ownership takes for the repository is never plainly another one.
              expect(owns && other, url).toBe(false);
              // Ownership of a PR on GitHub takes only GitHub's own hosts.
              if (owns)
                expect(["github.com", "www.github.com", "ssh.github.com"]).toContain(
                  remoteRepoOf(url)!.host,
                );
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

/** A finished process's output, as `Proc` returns it. */
const out = (status: number, stdout = "", stderr = ""): ProcOutput => ({
  status,
  stdout,
  stderr,
  truncated: false,
});

describe("liveHeadAt", () => {
  const folder = mkdtempSync(join(tmpdir(), "gram-live-head-"));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  /** `liveHeadAt` in `folder` with its one git call answered by `answer`. */
  const head = (answer: Effect.Effect<ProcOutput, ProcSpawnError | ProcTimeout>, at = folder) =>
    liveHeadAt(at).pipe(Effect.provideService(Proc, { run: () => answer }));

  it.effect("reads a checked-out branch", () =>
    Effect.gen(function* () {
      expect(yield* head(Effect.succeed(out(0, "release/next\n")))).toEqual({
        kind: "branch",
        name: "release/next",
      });
    }),
  );

  it.effect("reads a silent exit 1 as a verified detached HEAD", () =>
    Effect.gen(function* () {
      expect(yield* head(Effect.succeed(out(1)))).toEqual({ kind: "detached" });
    }),
  );

  // Every way the HEAD can't be told is unknown, which a conflict check counts as a claim.
  for (const [why, answer] of [
    ["a broken git directory", Effect.succeed(out(128, "", "fatal: not a git repository"))],
    ["a signal", Effect.succeed(out(-1))],
    ["a truncated read", Effect.succeed({ ...out(0, "release/next"), truncated: true })],
    ["a timeout", Effect.fail(new ProcTimeout({ bin: "git", message: "timed out" }))],
    ["a spawn error", Effect.fail(new ProcSpawnError({ bin: "git", message: "ENOENT" }))],
  ] as const) {
    it.effect(`reads ${why} as unknown`, () =>
      Effect.gen(function* () {
        expect(yield* head(answer)).toEqual({ kind: "unknown" });
      }),
    );
  }

  it.effect("reads a folder that is gone as unknown, without running git", () =>
    Effect.gen(function* () {
      expect(
        yield* head(Effect.die("git ran for a missing folder"), join(folder, "moved-away")),
      ).toEqual({ kind: "unknown" });
    }),
  );

  const notRepo = out(
    128,
    "",
    "fatal: not a git repository (or any of the parent directories): .git\n",
  );
  it.effect("recognizes a verified non-repository with a separate fixed-locale probe", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      expect(
        yield* liveHeadAt(folder).pipe(
          Effect.provideService(Proc, {
            run: (_bin, args, options) => {
              calls.push(args);
              if (args[0] === "rev-parse")
                expect(options.env).toMatchObject({
                  LC_ALL: "C",
                  LANGUAGE: "C",
                  GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
                });
              return Effect.succeed(notRepo);
            },
          }),
        ),
      ).toEqual({ kind: "no-repository" });
      expect(calls).toEqual([
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        ["rev-parse", "--git-dir"],
      ]);
    }),
  );

  for (const marker of [".git", "HEAD", "objects", "refs", "config", "commondir"]) {
    it.effect(`keeps a broken repository's ${marker} marker in an ancestor unknown`, () =>
      Effect.gen(function* () {
        const parent = join(folder, marker.replace(".", "dot"));
        const nested = join(parent, "nested");
        mkdirSync(nested, { recursive: true });
        mkdirSync(join(parent, marker));
        expect(yield* head(Effect.succeed(notRepo), nested)).toEqual({ kind: "unknown" });
      }),
    );
  }

  for (const probe of [
    out(0, ".git\n"),
    out(128, "", "fatal: bad config"),
    out(1),
    { ...notRepo, truncated: true },
  ]) {
    it.effect(`keeps an inconclusive repository probe unknown (${JSON.stringify(probe)})`, () =>
      Effect.gen(function* () {
        expect(
          yield* liveHeadAt(folder).pipe(
            Effect.provideService(Proc, {
              run: (_bin, args) => Effect.succeed(args[0] === "symbolic-ref" ? notRepo : probe),
            }),
          ),
        ).toEqual({ kind: "unknown" });
      }),
    );
  }
});
