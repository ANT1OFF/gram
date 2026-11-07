import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { originOwnerRepo, resolvePrInputs } from "./pr.ts";
import { Proc, ProcLive } from "./proc.ts";
import { localBaseRef, originTips } from "./refs.ts";
import { cachedOriginHead, cachedRepoRoots } from "./repo-facts.ts";
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
      expect(take()).toEqual([
        "git rev-parse --show-toplevel HEAD @{upstream} --abbrev-ref HEAD @{upstream}",
      ]);
      // And once its upstream is known, none while nothing moved.
      expect(yield* resolvePrInputs(path)).toEqual(inputs);
      expect(take()).toEqual([]);
      // From a folder below the toplevel as well.
      const sub = nodePath.join(path, "sub");
      write(nodePath.join(sub, "file.txt"), "x");
      expect(yield* resolvePrInputs(sub)).toEqual(inputs);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "reads a checkout's HEAD again only once a commit, checkout, push or upstream moves it",
    () => {
      const { layer, take } = counted();
      return Effect.gen(function* () {
        const path = repo();
        const first = commit(path, "a.txt");
        const inputs = () => resolvePrInputs(path);
        const settle = function* () {
          yield* inputs();
          yield* inputs();
          take();
        };
        // Never pushed: no upstream, and the branch and its origin tip are asked as well.
        yield* settle();
        expect(yield* inputs()).toMatchObject({ branch: "feat", localTip: first, remoteTip: "" });
        expect(take()).toEqual([]);
        // A commit moves the branch's ref.
        const second = commit(path, "b.txt");
        expect(yield* inputs()).toMatchObject({ localTip: second });
        // `git push -u`: the upstream's ref and the config.
        pushed(path);
        expect(yield* inputs()).toMatchObject({ localTip: second, remoteTip: second });
        yield* settle();
        expect(yield* inputs()).toMatchObject({ remoteTip: second });
        expect(take()).toEqual([]);
        // A fetch moves the upstream alone.
        const third = commit(path, "c.txt");
        run(path, "update-ref", "refs/remotes/origin/feat", "HEAD~2");
        expect(yield* inputs()).toMatchObject({ localTip: third, remoteTip: first });
        // Packed, then moved while packed.
        run(path, "pack-refs", "--all");
        expect(yield* inputs()).toMatchObject({ localTip: third, remoteTip: first });
        run(path, "update-ref", "refs/remotes/origin/feat", third);
        expect(yield* inputs()).toMatchObject({ remoteTip: third });
        // Another branch checked out, and detached.
        run(path, "checkout", "-q", "-b", "other");
        expect(yield* inputs()).toMatchObject({ branch: "other", remoteTip: "" });
        run(path, "checkout", "-q", "--detach");
        expect(yield* inputs()).toBeUndefined();
        run(path, "checkout", "-q", "feat");
        expect(yield* inputs()).toMatchObject({ branch: "feat", remoteTip: third });
        // Its upstream unset.
        run(path, "branch", "-q", "--unset-upstream");
        expect(yield* inputs()).toMatchObject({ branch: "feat", remoteTip: third });
        run(path, "update-ref", "-d", "refs/remotes/origin/feat");
        expect(yield* inputs()).toMatchObject({ branch: "feat", remoteTip: "" });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("asks for origin tips again only once one of their refs moves", () => {
    const { layer, take } = counted();
    return Effect.gen(function* () {
      const path = repo();
      const first = commit(path, "a.txt");
      run(path, "update-ref", "refs/remotes/origin/main", "HEAD");
      run(path, "update-ref", "refs/remotes/origin/feat", "HEAD");
      const tips = () =>
        originTips(path, ["feat", "main"]).pipe(Effect.map((map) => Object.fromEntries(map)));
      expect(yield* tips()).toEqual({ feat: first, main: first });
      take();
      // Nothing moved: no `for-each-ref`.
      expect(yield* tips()).toEqual({ feat: first, main: first });
      expect(take()).toEqual([]);
      // A fetch or push moves one: read again.
      const second = commit(path, "b.txt");
      run(path, "update-ref", "refs/remotes/origin/feat", "HEAD");
      expect(yield* tips()).toEqual({ feat: second, main: first });
      expect(take().filter((line) => line.includes("for-each-ref"))).toHaveLength(1);
      // Packed: the loose files go and `packed-refs` changes, and the answer holds.
      run(path, "pack-refs", "--all");
      expect(yield* tips()).toEqual({ feat: second, main: first });
      // Moved while packed, and pruned.
      run(path, "update-ref", "refs/remotes/origin/main", second);
      expect(yield* tips()).toEqual({ feat: second, main: second });
      run(path, "update-ref", "-d", "refs/remotes/origin/feat");
      expect(yield* tips()).toEqual({ main: second });
    }).pipe(Effect.provide(layer));
  });

  it.live("asks for origin/HEAD again only once its ref moves", () => {
    const { layer, take } = counted();
    return Effect.gen(function* () {
      const path = repo();
      commit(path, "a.txt");
      run(path, "update-ref", "refs/remotes/origin/main", "HEAD");
      run(path, "update-ref", "refs/remotes/origin/develop", "HEAD");
      run(path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      expect(yield* localBaseRef(path)).toBe("origin/main");
      take();
      // The sweep after: no `symbolic-ref`, the same answer.
      expect(yield* localBaseRef(path)).toBe("origin/main");
      expect(take().filter((line) => line.includes("symbolic-ref"))).toEqual([]);
      // `git remote set-head` rewrites the ref's file: read again.
      run(path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
      expect(yield* cachedOriginHead(path)).toBe("origin/develop");
      // Removed: none, and the fallback to master/main answers.
      run(path, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
      expect(yield* cachedOriginHead(path)).toBeUndefined();
      expect(yield* localBaseRef(path)).toBe("origin/main");
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
