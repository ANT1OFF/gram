import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { fetchPrHead, localPrBranch, prHead, type PrHead } from "./pr-checkout.ts";
import { Proc, ProcLive, type ProcShape } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir } from "./test-utils.ts";

type Reply = { status: number; stdout?: string; stderr?: string };

const mockProc = (respond: (bin: string, args: ReadonlyArray<string>) => Reply) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const proc: ProcShape = {
    run: (bin, args) =>
      Effect.sync(() => {
        calls.push([bin, ...args]);
        return { stdout: "", stderr: "", truncated: false, ...respond(bin, args) };
      }),
  };
  return { proc, calls };
};

const head = (overrides: Partial<PrHead> = {}): PrHead => ({
  repo: "acme/web",
  number: 12,
  url: "https://github.com/acme/web/pull/12",
  title: "Fix it",
  headRefName: "fix/it",
  fork: false,
  ...overrides,
});

const REMOTES =
  "remote.origin.url git@github.com:acme/web.git\nremote.mine.url https://github.com/me/web.git\n";

/** A repo whose branch lookups miss, whose fetched refs resolve to `f00d`, and whose other git calls succeed. */
const repo = (remotes = REMOTES, branchExists = false) =>
  mockProc((_bin, args) => {
    if (args[0] === "rev-parse" && args.at(-1)?.endsWith("^{commit}")) {
      return { status: 0, stdout: "f00d\n" };
    }
    if (args[0] === "rev-parse") return { status: branchExists ? 0 : 1 };
    if (args[0] === "config") return { status: remotes === "" ? 1 : 0, stdout: remotes };
    return { status: 0 };
  });

const gitCalls = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter((c) => c[0] === "git" && c[1] !== "config").map((c) => c.slice(1));

describe("localPrBranch", () => {
  it("keeps a same-repo head, prefixes a fork's and falls back to pr-<n>", () => {
    expect(localPrBranch(head())).toBe("fix/it");
    expect(localPrBranch(head({ fork: true, headRefName: "main" }))).toBe("pr-12-main");
    expect(localPrBranch(head({ headRefName: "weird name" }))).toBe("pr-12");
    expect(localPrBranch(head({ headRefName: "a..b" }))).toBe("pr-12");
  });
});

describe("prHead", () => {
  it.effect("reads the PR from gh, taking the repository from its URL", () =>
    Effect.gen(function* () {
      const { proc, calls } = mockProc(() => ({
        status: 0,
        stdout: JSON.stringify({
          number: 12,
          url: "https://github.com/acme/web/pull/12",
          title: "Fix it",
          headRefName: "patch-1",
          isCrossRepository: true,
          state: "OPEN",
          headRefOid: "h1",
        }),
      }));
      const described = yield* prHead("/w", 12, undefined).pipe(Effect.provideService(Proc, proc));
      expect(described).toMatchObject({
        repo: "acme/web",
        headRefName: "patch-1",
        fork: true,
        state: "OPEN",
        headRefOid: "h1",
      });
      expect(calls[0]).toEqual([
        "gh",
        "pr",
        "view",
        "12",
        "--json",
        "number,url,title,headRefName,isCrossRepository,state,headRefOid",
      ]);
    }),
  );

  it.effect("fails with what gh said, and refuses a malformed repository", () =>
    Effect.gen(function* () {
      const { proc } = mockProc(() => ({ status: 1, stderr: "no pull requests found\n" }));
      const missing = yield* Effect.flip(
        prHead("/w", 99, "acme/web").pipe(Effect.provideService(Proc, proc)),
      );
      const bad = yield* Effect.flip(
        prHead("/w", 1, "--repo=x").pipe(Effect.provideService(Proc, proc)),
      );
      expect(missing.message).toBe("no pull requests found");
      expect(bad.message).toBe("invalid repository --repo=x");
    }),
  );
});

describe("fetchPrHead", () => {
  it.effect("tracks a same-repo head from the remote that is the PR's repository", () =>
    Effect.gen(function* () {
      const { proc, calls } = repo();
      const branch = yield* fetchPrHead("/r", head()).pipe(Effect.provideService(Proc, proc));
      expect(branch).toBe("fix/it");
      expect(gitCalls(calls)).toEqual([
        ["rev-parse", "--verify", "--quiet", "refs/heads/fix/it"],
        ["fetch", "--quiet", "origin", "+refs/heads/fix/it:refs/remotes/origin/fix/it"],
        ["branch", "--track", "fix/it", "origin/fix/it"],
      ]);
    }),
  );

  it.effect("fetches a fork's head through refs/pull/<n>/head", () =>
    Effect.gen(function* () {
      const { proc, calls } = repo();
      const branch = yield* fetchPrHead("/r", head({ fork: true, headRefName: "main" })).pipe(
        Effect.provideService(Proc, proc),
      );
      expect(branch).toBe("pr-12-main");
      const [fetch, resolve, create, cleanup] = gitCalls(calls).slice(1);
      const ref = fetch?.at(-1)?.replace(/^\+refs\/pull\/12\/head:/, "") ?? "";
      expect(ref).toMatch(/^refs\/gram\/pr-checkout\/pr-12-/);
      expect(fetch?.slice(0, 3)).toEqual(["fetch", "--quiet", "origin"]);
      expect(resolve).toEqual(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      expect(create).toEqual(["branch", "pr-12-main", "f00d"]);
      expect(cleanup).toEqual(["update-ref", "-d", ref]);
    }),
  );

  it.effect("refuses a fetched head that isn't the PR's head, and drops its ref", () =>
    Effect.gen(function* () {
      const { proc, calls } = repo();
      const error = yield* Effect.flip(
        fetchPrHead("/r", head({ fork: true, headRefOid: "beef" })).pipe(
          Effect.provideService(Proc, proc),
        ),
      );
      expect(error.message).toBe("PR #12's head moved while it was fetched; try again");
      const after = gitCalls(calls).slice(2);
      expect(after.some((c) => c[0] === "branch")).toBe(false);
      expect(after.at(-1)?.slice(0, 2)).toEqual(["update-ref", "-d"]);
    }),
  );

  it.effect("fetches from the PR's URL when no remote matches", () =>
    Effect.gen(function* () {
      const { proc, calls } = repo("remote.origin.url git@github.com:me/web.git\n");
      yield* fetchPrHead("/r", head()).pipe(Effect.provideService(Proc, proc));
      expect(gitCalls(calls)[1]?.slice(0, 3)).toEqual([
        "fetch",
        "--quiet",
        "https://github.com/acme/web.git",
      ]);
    }),
  );

  it.effect("uses an existing local branch as it is", () =>
    Effect.gen(function* () {
      const { proc, calls } = repo(REMOTES, true);
      expect(yield* fetchPrHead("/r", head()).pipe(Effect.provideService(Proc, proc))).toBe(
        "fix/it",
      );
      expect(gitCalls(calls)).toEqual([["rev-parse", "--verify", "--quiet", "refs/heads/fix/it"]]);
    }),
  );

  it.effect("fails with what git said when the fetch fails", () =>
    Effect.gen(function* () {
      const { proc } = mockProc((_bin, args) =>
        args[0] === "fetch"
          ? { status: 128, stderr: "fatal: couldn't find remote ref refs/pull/12/head\n" }
          : { status: args[0] === "rev-parse" ? 1 : 0, stdout: REMOTES },
      );
      const error = yield* Effect.flip(
        fetchPrHead("/r", head({ fork: true })).pipe(Effect.provideService(Proc, proc)),
      );
      expect(error.message).toBe("fatal: couldn't find remote ref refs/pull/12/head");
    }),
  );
});

describe.skipIf(!hasGit)("fetchPrHead with real git", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  // A sibling's fetch landing between this fetch and the branch used to swap `FETCH_HEAD` under it.
  it.live("branches from the PR it fetched even when another fetch lands in between", () =>
    Effect.gen(function* () {
      const tmp = tempDir();
      dirs.push(tmp);
      const remote = makeRepo(nodePath.join(tmp, "remote"));
      const one = run(remote, "rev-parse", "HEAD").trim();
      run(remote, "update-ref", "refs/pull/1/head", one);
      run(remote, "commit", "-qm", "two", "--allow-empty");
      const two = run(remote, "rev-parse", "HEAD").trim();
      run(remote, "update-ref", "refs/pull/2/head", two);
      const local = makeRepo(nodePath.join(tmp, "local"));
      run(local, "remote", "add", "origin", "https://github.com/fixture/repo.git");
      run(
        local,
        "config",
        "url.file://" + remote + ".insteadOf",
        "https://github.com/fixture/repo.git",
      );
      const actual = yield* Proc;
      const racing: ProcShape = {
        run: (bin, args, options) =>
          actual.run(bin, args, options).pipe(
            Effect.tap(() =>
              args[0] === "fetch" && args.some((a) => a.includes("refs/pull/1/head"))
                ? actual.run("git", ["fetch", "--quiet", "origin", "refs/pull/2/head"], {
                    cwd: local,
                  })
                : Effect.void,
            ),
          ),
      };
      const branch = yield* fetchPrHead(local, {
        repo: "fixture/repo",
        number: 1,
        url: "https://github.com/fixture/repo/pull/1",
        title: "one",
        headRefName: "feature",
        headRefOid: one,
        fork: true,
      }).pipe(Effect.provideService(Proc, racing));
      expect(run(local, "rev-parse", branch).trim()).toBe(one);
      expect(run(local, "for-each-ref", "refs/gram/").trim()).toBe("");
    }).pipe(Effect.provide(ProcLive)),
  );
});
