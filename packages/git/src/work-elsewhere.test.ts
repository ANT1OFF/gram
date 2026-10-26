import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { localGitState } from "./git-state.ts";
import { ProcLive } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";
import { workElsewhere } from "./work-elsewhere.ts";

const provide = Effect.provide(ProcLive);

const scan = (cwd: string) =>
  Effect.gen(function* () {
    return yield* workElsewhere(cwd, yield* localGitState(cwd));
  }).pipe(provide);

describe.skipIf(!hasGit)("workElsewhere", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  /** A repo on `main` and a linked worktree on `feat` holding an uncommitted file. */
  const fixture = () => {
    const tmp = tempDir();
    dirs.push(tmp);
    const repo = makeRepo(tmp);
    const sibling = nodePath.join(tmp, "feat-tree");
    run(repo, "worktree", "add", "-q", "-b", "feat", sibling);
    write(nodePath.join(sibling, "wip.txt"), "work in progress");
    return { repo, sibling };
  };

  it.effect("names the other worktree holding uncommitted work on another branch", () =>
    Effect.gen(function* () {
      const { repo, sibling } = fixture();
      expect(yield* scan(repo)).toEqual({ branch: "feat", path: sibling });
    }),
  );

  it.effect("stays quiet when this checkout has its own changes or the sibling is clean", () =>
    Effect.gen(function* () {
      const { repo, sibling } = fixture();
      write(nodePath.join(repo, "tracked.txt"), "edited here");
      expect(yield* scan(repo)).toBeUndefined();

      run(repo, "checkout", "-q", "--", "tracked.txt");
      removeDir(nodePath.join(sibling, "wip.txt"));
      expect(yield* scan(repo)).toBeUndefined();
    }),
  );

  it.effect("never advises a linked worktree, which is pinned to itself", () =>
    Effect.gen(function* () {
      const { sibling } = fixture();
      run(sibling, "add", "-A");
      run(sibling, "commit", "-qm", "wip");
      expect(yield* scan(sibling)).toBeUndefined();
    }),
  );
});
