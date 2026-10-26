import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProcLive } from "./proc.ts";
import { currentUpstream, FetchFailed, fetchOriginBranch, lastFetchedAt } from "./refs.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";

const pushCommit = (clone: string, file: string) => {
  write(nodePath.join(clone, file), file);
  run(clone, "add", "-A");
  run(clone, "commit", "-qm", file);
  run(clone, "push", "-q", "origin", "main");
};

describe.skipIf(!hasGit)("base branch freshness", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  /** A repo whose `origin` is a local bare repo, plus another clone that pushes to it. */
  const withOrigin = () => {
    const root = tempDir();
    dirs.push(root);
    const repo = makeRepo(root);
    const origin = nodePath.join(root, "origin.git");
    run(root, "init", "-q", "--bare", "-b", "main", origin);
    run(repo, "remote", "add", "origin", origin);
    run(repo, "push", "-q", "origin", "main");
    const other = nodePath.join(root, "other");
    run(root, "clone", "-q", origin, other);
    run(other, "config", "user.email", "t@t");
    run(other, "config", "user.name", "t");
    run(other, "config", "commit.gpgsign", "false");
    return { repo, other };
  };

  it.live("reports the last fetch and the commits a fetch brings in", () =>
    Effect.gen(function* () {
      const { repo, other } = withOrigin();
      expect(yield* lastFetchedAt(repo)).toBeUndefined();

      pushCommit(other, "a.txt");
      pushCommit(other, "b.txt");
      const first = yield* fetchOriginBranch(repo, "origin/main");
      expect(first.newCommits).toBe(2);
      expect(first.fetchedAt).toBeGreaterThan(0);
      expect(yield* lastFetchedAt(repo)).toBe(first.fetchedAt);
      expect((yield* fetchOriginBranch(repo, "origin/main")).newCommits).toBe(0);

      expect(yield* Effect.flip(fetchOriginBranch(repo, "origin/nope"))).toBeInstanceOf(
        FetchFailed,
      );
      expect((yield* Effect.flip(fetchOriginBranch(repo, "develop"))).message).toBe(
        "develop is not an origin branch",
      );
    }).pipe(Effect.provide(ProcLive)),
  );

  it.live("fetches only the named branch, leaving other branches alone", () =>
    Effect.gen(function* () {
      const { repo, other } = withOrigin();
      run(other, "checkout", "-q", "-b", "develop");
      pushCommit(other, "d.txt");
      run(other, "push", "-q", "origin", "develop");
      run(repo, "fetch", "-q", "origin");
      run(repo, "branch", "-q", "develop", "origin/develop");
      const developBefore = run(repo, "rev-parse", "origin/develop").trim();
      const localBefore = run(repo, "rev-parse", "develop").trim();

      run(other, "commit", "-q", "--allow-empty", "-m", "more develop");
      run(other, "push", "-q", "origin", "develop");
      run(other, "checkout", "-q", "main");
      pushCommit(other, "m.txt");

      expect((yield* fetchOriginBranch(repo, "origin/main")).newCommits).toBe(1);
      expect(run(repo, "rev-parse", "origin/develop").trim()).toBe(developBefore);
      expect(run(repo, "rev-parse", "develop").trim()).toBe(localBefore);
    }).pipe(Effect.provide(ProcLive)),
  );

  it.live("finds the current branch's origin upstream", () =>
    Effect.gen(function* () {
      const { repo } = withOrigin();
      expect(yield* currentUpstream(repo)).toEqual({ branch: "main", ref: undefined });
      run(repo, "branch", "--set-upstream-to=origin/main");
      expect(yield* currentUpstream(repo)).toEqual({ branch: "main", ref: "origin/main" });
      run(repo, "checkout", "-q", "-b", "local-only");
      expect(yield* currentUpstream(repo)).toEqual({ branch: "local-only", ref: undefined });
      run(repo, "checkout", "-q", "--detach");
      expect(yield* currentUpstream(repo)).toEqual({ branch: undefined, ref: undefined });
    }).pipe(Effect.provide(ProcLive)),
  );
});
