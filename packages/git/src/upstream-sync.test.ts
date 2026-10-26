import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProcLive } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";
import {
  fastForwardBlocker,
  FastForwardFailed,
  fastForwardCurrent,
  upstreamDivergence,
} from "./upstream-sync.ts";

const commit = (cwd: string, file: string, content = file) => {
  write(nodePath.join(cwd, file), content);
  run(cwd, "add", "-A");
  run(cwd, "commit", "-qm", file);
};

describe.skipIf(!hasGit)("upstream sync", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  /** A repo tracking a local bare `origin`, plus another clone that pushes to it. */
  const withOrigin = () => {
    const root = tempDir();
    dirs.push(root);
    const repo = makeRepo(root);
    commit(repo, "tracked.txt", "one");
    const origin = nodePath.join(root, "origin.git");
    run(root, "init", "-q", "--bare", "-b", "main", origin);
    run(repo, "remote", "add", "origin", origin);
    run(repo, "push", "-q", "-u", "origin", "main");
    const other = nodePath.join(root, "other");
    run(root, "clone", "-q", origin, other);
    run(other, "config", "user.email", "t@t");
    run(other, "config", "user.name", "t");
    run(other, "config", "commit.gpgsign", "false");
    const push = (file: string) => {
      commit(other, file);
      run(other, "push", "-q", "origin", "main");
    };
    return { repo, push };
  };

  it.live("counts the commits a fetch brought in and fast-forwards onto them", () =>
    Effect.gen(function* () {
      const { repo, push } = withOrigin();
      push("a.txt");
      push("b.txt");
      expect((yield* upstreamDivergence(repo)).behind).toBe(0);

      run(repo, "fetch", "-q", "origin");
      const before = yield* upstreamDivergence(repo);
      expect(before).toEqual({
        branch: "main",
        ref: "origin/main",
        ahead: 0,
        behind: 2,
        changedFiles: 0,
      });
      expect(fastForwardBlocker(before)).toBeUndefined();

      // An untracked file doesn't get in the way.
      write(nodePath.join(repo, "notes.local"), "scratch");
      const result = yield* fastForwardCurrent(repo);
      expect(result).toMatchObject({ branch: "main", ref: "origin/main", commits: 2 });
      expect(result.head).toBe(run(repo, "rev-parse", "origin/main").trim());
      expect((yield* upstreamDivergence(repo)).behind).toBe(0);
    }).pipe(Effect.provide(ProcLive)),
  );

  it.live("refuses a dirty or diverged checkout, and one with nothing to take", () =>
    Effect.gen(function* () {
      const { repo, push } = withOrigin();
      expect(fastForwardBlocker(yield* upstreamDivergence(repo))).toBe("it's up to date");

      push("a.txt");
      run(repo, "fetch", "-q", "origin");
      write(nodePath.join(repo, "tracked.txt"), "edited");
      const dirty = yield* Effect.flip(fastForwardCurrent(repo));
      expect(dirty).toBeInstanceOf(FastForwardFailed);
      expect(dirty.message).toBe("Can't fast-forward main: it has 1 uncommitted change");

      run(repo, "checkout", "-q", "--", "tracked.txt");
      commit(repo, "mine.txt");
      expect(yield* upstreamDivergence(repo)).toMatchObject({ ahead: 1, behind: 1 });
      expect((yield* Effect.flip(fastForwardCurrent(repo))).message).toBe(
        "Can't fast-forward main: it has 1 commit of its own",
      );
    }).pipe(Effect.provide(ProcLive)),
  );

  it.live("reports a branch without an origin upstream", () =>
    Effect.gen(function* () {
      const { repo } = withOrigin();
      run(repo, "checkout", "-q", "-b", "local-only");
      const divergence = yield* upstreamDivergence(repo);
      expect(divergence).toMatchObject({ branch: "local-only", ref: undefined, behind: 0 });
      expect(fastForwardBlocker(divergence)).toBe("it has no origin upstream");
    }).pipe(Effect.provide(ProcLive)),
  );
});
