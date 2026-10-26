import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { originOwnerRepo, resolvePrInputs } from "./pr.ts";
import { Proc, ProcLive } from "./proc.ts";
import { cachedRepoRoots } from "./repo-facts.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";

/** Real git, with every command line it is asked to run kept in `runs`. */
const counted = () => {
  const runs: Array<string> = [];
  const layer = Layer.effect(
    Proc,
    Effect.map(Effect.service(Proc), (proc) =>
      Proc.of({
        run: (bin, args, options) =>
          Effect.suspend(() => {
            runs.push([bin, ...args].join(" "));
            return proc.run(bin, args, options);
          }),
      }),
    ),
  ).pipe(Layer.provide(ProcLive));
  /** The runs since the last call. */
  const take = () => runs.splice(0);
  return { layer, take };
};

const commit = (path: string, file: string) => {
  write(nodePath.join(path, file), file);
  run(path, "add", "-A");
  run(path, "commit", "-qm", file);
  return run(path, "rev-parse", "HEAD").trim();
};
/** As `git push -u origin feat` leaves the checkout, without a remote to push to. */
const pushed = (path: string, upstream = true) => {
  run(path, "update-ref", "refs/remotes/origin/feat", "HEAD");
  if (upstream) run(path, "branch", "-q", "--set-upstream-to=origin/feat");
  return run(path, "rev-parse", "HEAD").trim();
};

describe.skipIf(!hasGit)("the sweep's per-checkout git reads", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  /**
   * A repo whose `origin` is acme/web on GitHub, never contacted: `origin/<branch>` refs are written
   * locally, as a fetch would leave them.
   */
  const repo = () => {
    const root = tempDir();
    dirs.push(root);
    const path = makeRepo(root);
    run(path, "remote", "add", "origin", "git@github.com:acme/web.git");
    run(path, "checkout", "-q", "-b", "feat");
    return path;
  };

  it.live("reads a pushed branch's PR inputs in one git run once the origin is known", () => {
    const { layer, take } = counted();
    return Effect.gen(function* () {
      const path = repo();
      const tip = pushed(path);
      const local = commit(path, "ahead.txt");
      const inputs = {
        workTree: path,
        branch: "feat",
        localTip: local,
        remoteTip: tip,
        repo: "acme/web",
      };
      expect(yield* resolvePrInputs(path)).toEqual(inputs);
      take();
      // The sweep after: the four `rev-parse`s and the origin's `git config` were five runs.
      expect(yield* resolvePrInputs(path)).toEqual(inputs);
      expect(take()).toEqual(["git rev-parse --show-toplevel HEAD @{upstream} --abbrev-ref HEAD"]);
      // From a folder below the toplevel as well.
      const sub = nodePath.join(path, "sub");
      write(nodePath.join(sub, "file.txt"), "x");
      expect(yield* resolvePrInputs(sub)).toEqual(inputs);
    }).pipe(Effect.provide(layer));
  });

  it.live("reads a branch without an upstream by name, its pushed tip from origin", () =>
    Effect.gen(function* () {
      const path = repo();
      const head = commit(path, "a.txt");
      // Never pushed: no remote tip.
      expect(yield* resolvePrInputs(path)).toMatchObject({
        branch: "feat",
        localTip: head,
        remoteTip: "",
      });
      // Pushed without `-u`: the tip is `origin/feat`'s.
      const tip = pushed(path, false);
      const local = commit(path, "b.txt");
      expect(yield* resolvePrInputs(path)).toMatchObject({
        branch: "feat",
        localTip: local,
        remoteTip: tip,
      });
      // An upstream whose ref is gone, as after a prune of the merged branch.
      run(path, "branch", "-q", "--set-upstream-to=origin/feat");
      run(path, "update-ref", "-d", "refs/remotes/origin/feat");
      expect(yield* resolvePrInputs(path)).toMatchObject({ branch: "feat", remoteTip: "" });
    }).pipe(Effect.provide(ProcLive)),
  );

  it.live("finds no inputs off a branch, before a first commit, or outside a repo", () =>
    Effect.gen(function* () {
      const path = repo();
      pushed(path);
      run(path, "checkout", "-q", "--detach");
      expect(yield* resolvePrInputs(path)).toBeUndefined();
      run(path, "checkout", "-q", "--orphan", "fresh");
      expect(yield* resolvePrInputs(path)).toBeUndefined();
      const outside = tempDir();
      dirs.push(outside);
      expect(yield* resolvePrInputs(outside)).toBeUndefined();
      // No GitHub origin.
      run(path, "checkout", "-q", "feat");
      run(path, "remote", "remove", "origin");
      expect(yield* resolvePrInputs(path)).toBeUndefined();
    }).pipe(Effect.provide(ProcLive)),
  );

  it.live("reads the origin again once the repo's config changes, and only then", () => {
    const { layer, take } = counted();
    return Effect.gen(function* () {
      const path = repo();
      expect(yield* originOwnerRepo(path)).toBe("acme/web");
      take();
      expect(yield* originOwnerRepo(path)).toBe("acme/web");
      expect(take()).toEqual([]);

      run(path, "remote", "set-url", "origin", "https://github.com/acme/app.git");
      expect(yield* originOwnerRepo(path)).toBe("acme/app");
      run(path, "remote", "remove", "origin");
      expect(yield* originOwnerRepo(path)).toBeUndefined();
      run(path, "remote", "add", "origin", "git@github.com:acme/lib.git");
      expect(yield* originOwnerRepo(path)).toBe("acme/lib");

      // A linked worktree's own config counts too.
      const tree = nodePath.join(nodePath.dirname(path), "tree");
      run(path, "worktree", "add", "-q", "-b", "other", tree);
      expect(yield* originOwnerRepo(tree)).toBe("acme/lib");
      run(path, "config", "extensions.worktreeConfig", "true");
      run(tree, "config", "--worktree", "remote.origin.url", "git@github.com:acme/fork.git");
      expect(yield* originOwnerRepo(tree)).toBe("acme/fork");
      expect(yield* originOwnerRepo(path)).toBe("acme/lib");
    }).pipe(Effect.provide(layer));
  });

  it.live("keeps a checkout's roots until its folder or git dir goes", () => {
    const { layer, take } = counted();
    return Effect.gen(function* () {
      const path = repo();
      const tree = nodePath.join(nodePath.dirname(path), "tree");
      run(path, "worktree", "add", "-q", "-b", "other", tree);
      const roots = yield* cachedRepoRoots(tree);
      expect(roots?.top).toBe(tree);
      take();
      expect(yield* cachedRepoRoots(tree)).toEqual(roots);
      expect(take()).toEqual([]);

      run(path, "worktree", "remove", "--force", tree);
      const gone = yield* cachedRepoRoots(tree).pipe(Effect.orElseSucceed(() => undefined));
      expect(gone).toBeUndefined();
      expect(take()).toHaveLength(1);
      // Added again for another branch: its new roots.
      run(path, "worktree", "add", "-q", "-b", "again", tree);
      expect((yield* cachedRepoRoots(tree))?.top).toBe(tree);
      expect(yield* resolvePrInputs(tree)).toMatchObject({ branch: "again" });
    }).pipe(Effect.provide(layer));
  });

  it.live("reads another repo made where a kept one was, though the old git dir remains", () =>
    Effect.gen(function* () {
      const path = repo();
      pushed(path);
      const other = nodePath.join(nodePath.dirname(path), "other");
      fs.mkdirSync(other);
      run(other, "init", "-q", "-b", "feat");
      run(other, "remote", "add", "origin", "git@github.com:other/b.git");
      write(nodePath.join(other, "b.txt"), "b");
      run(other, "add", "-A");
      run(other, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "b");

      // A worktree deleted by hand, unpruned, so its git dir under the first repo stays.
      const tree = nodePath.join(nodePath.dirname(path), "tree");
      run(path, "worktree", "add", "-q", tree);
      expect((yield* resolvePrInputs(tree))?.repo).toBe("acme/web");
      expect(yield* originOwnerRepo(tree)).toBe("acme/web");
      removeDir(tree);
      run(nodePath.dirname(path), "clone", "-q", other, tree);
      run(tree, "remote", "set-url", "origin", "git@github.com:other/b.git");
      expect(yield* originOwnerRepo(tree)).toBe("other/b");
      expect((yield* resolvePrInputs(tree))?.repo).toBe("other/b");

      // A new repo with no origin.
      removeDir(tree);
      fs.mkdirSync(tree);
      run(tree, "init", "-q");
      expect(yield* originOwnerRepo(tree)).toBeUndefined();

      // The main checkout cloned anew from another repo.
      expect(yield* originOwnerRepo(path)).toBe("acme/web");
      removeDir(path);
      run(nodePath.dirname(path), "clone", "-q", other, path);
      run(path, "remote", "set-url", "origin", "git@github.com:other/b.git");
      expect(yield* originOwnerRepo(path)).toBe("other/b");

      // A repo started in a folder below a kept toplevel.
      const sub = nodePath.join(path, "nested");
      fs.mkdirSync(sub);
      expect((yield* cachedRepoRoots(sub))?.top).toBe(path);
      expect(yield* originOwnerRepo(sub)).toBe("other/b");
      run(sub, "init", "-q");
      expect((yield* cachedRepoRoots(sub))?.top).toBe(sub);
      expect(yield* originOwnerRepo(sub)).toBeUndefined();
    }).pipe(Effect.provide(ProcLive)),
  );
});
