import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProcLive } from "./proc.ts";
import { PushFailed, pushCurrentBranch } from "./push.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";

const commit = (cwd: string, file: string, content = file) => {
  write(nodePath.join(cwd, file), content);
  run(cwd, "add", "-A");
  run(cwd, "commit", "-qm", file);
};

describe.skipIf(!hasGit)("pushCurrentBranch", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  /** A repo with a local bare `origin` holding `main`, plus another clone that pushes to it. */
  const withOrigin = () => {
    const root = tempDir();
    dirs.push(root);
    const repo = makeRepo(root);
    const origin = nodePath.join(root, "origin.git");
    run(root, "init", "-q", "--bare", "-b", "main", origin);
    run(repo, "remote", "add", "origin", origin);
    run(repo, "push", "-q", "-u", "origin", "main");
    const other = nodePath.join(root, "other");
    run(root, "clone", "-q", origin, other);
    run(other, "config", "user.email", "t@t");
    run(other, "config", "user.name", "t");
    run(other, "config", "commit.gpgsign", "false");
    return { root, repo, origin, other };
  };

  it.live("publishes a new branch with an upstream, then pushes later commits", () =>
    Effect.gen(function* () {
      const { repo, origin } = withOrigin();
      run(repo, "checkout", "-q", "-b", "feat/push");
      commit(repo, "a.txt");

      expect(yield* pushCurrentBranch(repo)).toEqual({ branch: "feat/push", published: true });
      expect(run(repo, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe("origin/feat/push");
      expect(run(origin, "rev-parse", "feat/push").trim()).toBe(
        run(repo, "rev-parse", "HEAD").trim(),
      );

      commit(repo, "b.txt");
      expect(yield* pushCurrentBranch(repo)).toEqual({ branch: "feat/push", published: false });
      expect(run(origin, "rev-parse", "feat/push").trim()).toBe(
        run(repo, "rev-parse", "HEAD").trim(),
      );
    }).pipe(Effect.provide(ProcLive)),
  );

  it.live(
    "publishes a branch that tracks its base, as a worktree branched from origin/main does",
    () =>
      Effect.gen(function* () {
        const { repo, origin } = withOrigin();
        run(repo, "checkout", "-q", "-b", "feat/tracked", "--track", "origin/main");
        commit(repo, "c.txt");
        expect(run(repo, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe("origin/main");

        expect(yield* pushCurrentBranch(repo)).toEqual({ branch: "feat/tracked", published: true });
        expect(run(repo, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe(
          "origin/feat/tracked",
        );
        expect(run(origin, "rev-parse", "feat/tracked").trim()).toBe(
          run(repo, "rev-parse", "HEAD").trim(),
        );
        // origin/main didn't move.
        expect(run(origin, "rev-parse", "main").trim()).not.toBe(
          run(repo, "rev-parse", "HEAD").trim(),
        );
      }).pipe(Effect.provide(ProcLive)),
  );

  it.live("refuses a branch that is behind or has diverged, and never forces", () =>
    Effect.gen(function* () {
      const { repo, origin, other } = withOrigin();
      commit(other, "theirs.txt");
      run(other, "push", "-q", "origin", "main");
      run(repo, "fetch", "-q", "origin");

      const behind = yield* Effect.flip(pushCurrentBranch(repo));
      expect(behind).toBeInstanceOf(PushFailed);
      expect(behind.message).toBe("main is 1 commit behind origin/main. Pull first.");

      commit(repo, "mine.txt");
      const diverged = yield* Effect.flip(pushCurrentBranch(repo));
      expect(diverged.message).toBe(
        "main has diverged from origin/main (1 ahead, 1 behind). Pull or rebase first; Gram never force-pushes.",
      );
      expect(run(origin, "rev-parse", "main").trim()).toBe(run(other, "rev-parse", "HEAD").trim());
    }).pipe(Effect.provide(ProcLive)),
  );

  it.live("refuses a detached HEAD and a repo without origin", () =>
    Effect.gen(function* () {
      const { repo, root } = withOrigin();
      run(repo, "checkout", "-q", "--detach");
      expect((yield* Effect.flip(pushCurrentBranch(repo))).message).toBe(
        "HEAD isn't on a branch, so there's nothing to push",
      );

      const lonely = makeRepo(nodePath.join(root, "lonely"));
      expect((yield* Effect.flip(pushCurrentBranch(lonely))).message).toBe(
        "This repository has no origin remote to push to",
      );
    }).pipe(Effect.provide(ProcLive)),
  );
});
