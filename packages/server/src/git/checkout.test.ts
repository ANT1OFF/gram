import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { Checkout, ProjectId, Thread, ThreadId } from "@gram/contracts";
import { Checkpoints, readPermissionRules, settingsPath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadStore } from "../persistence/thread-store.ts";
import { CheckoutService, type ReleaseCheckoutOptions } from "../runtime/hooks.ts";
import { GitCheckoutLive } from "./checkout.ts";
import { gitPlatformTest } from "./platform.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-repo.ts";

const TestLayer = GitCheckoutLive.pipe(
  Layer.provideMerge(gitPlatformTest()),
  Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
  Layer.orDie,
);

const threadAt = (checkout: Checkout): Thread => ({
  id: "thread-1" as ThreadId,
  projectId: "project-1" as ProjectId,
  title: "t",
  userNamed: false,
  model: { agent: "claude", model: "default" },
  mode: "default",
  checkout,
  labels: [],
  pinned: false,
  parked: false,
  unread: false,
  createdAt: 0,
  lastActivityAt: 0,
});

const release = (thread: Thread, options: ReleaseCheckoutOptions) =>
  Effect.gen(function* () {
    const checkouts = yield* CheckoutService;
    return yield* checkouts.release(thread, options);
  });

describe.skipIf(!hasGit)("GitCheckoutLive", () => {
  const dirs: Array<string> = [];
  const repo = () => {
    const dir = tempDir();
    dirs.push(dir);
    return makeRepo(dir);
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live("fails with NotFound for a missing folder before running git, for every kind", () =>
    Effect.gen(function* () {
      const root = repo();
      const missing = nodePath.join(root, "gone.");
      const checkouts = yield* CheckoutService;
      const notFound = { _tag: "NotFound", entity: "project", id: missing };
      for (const [request, projectRoot] of [
        [{ kind: "current" }, missing],
        [{ kind: "newWorktree", branch: "feat" }, missing],
        [{ kind: "existingWorktree", path: missing }, root],
      ] as const) {
        const error = yield* checkouts.prepare(request, [], projectRoot).pipe(Effect.flip);
        expect(error).toMatchObject(notFound);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live(
    "prepares current, new and existing checkouts with repoRoot and the one-thread guard",
    () =>
      Effect.gen(function* () {
        const root = repo();
        const checkouts = yield* CheckoutService;
        expect(yield* checkouts.prepare({ kind: "current" }, [], root)).toEqual({
          kind: "main",
          path: root,
          branch: "main",
        });

        write(nodePath.join(root, ".worktreeinclude"), ".env\n");
        write(
          nodePath.join(root, ".gitignore"),
          ".worktrees/\n.claude/settings.local.json\n.env\n",
        );
        run(root, "add", "-A");
        run(root, "commit", "-qm", "include");
        write(nodePath.join(root, ".env"), "KEY=1");
        write(
          settingsPath(root),
          JSON.stringify({ permissions: { allow: ["Bash(npm test)", "Bash(git push)"] } }),
        );

        const created = yield* checkouts.prepare(
          { kind: "newWorktree", branch: "feat/x" },
          [],
          root,
        );
        const dir = nodePath.join(root, ".worktrees", "feat-x");
        expect(created).toMatchObject({
          kind: "worktree",
          path: dir,
          branch: "feat/x",
          repoRoot: root,
        });
        expect(fs.readFileSync(nodePath.join(dir, ".env"), "utf8")).toBe("KEY=1");
        expect(readPermissionRules(dir).allow).toEqual(["Bash(npm test)"]);

        expect(yield* checkouts.prepare({ kind: "existingWorktree", path: dir }, [], root)).toEqual(
          { kind: "worktree", path: dir, branch: "feat/x", repoRoot: root },
        );
        const guarded = yield* Effect.flip(
          checkouts.prepare({ kind: "existingWorktree", path: dir }, [dir], root),
        );
        expect(guarded).toMatchObject({
          _tag: "CheckoutInUse",
          path: dir,
          message: "a thread is already open in that checkout",
        });
        const reused = yield* Effect.flip(
          checkouts.prepare({ kind: "newWorktree", branch: "feat/x" }, [dir], root),
        );
        expect(reused).toMatchObject({ _tag: "CheckoutInUse", path: dir });
        const invalid = yield* Effect.flip(
          checkouts.prepare({ kind: "newWorktree", branch: "bad branch" }, [], root),
        );
        expect(invalid).toMatchObject({ _tag: "GitError" });
        const stray = yield* Effect.flip(
          checkouts.prepare({ kind: "existingWorktree", path: tempDir() }, [], root),
        );
        expect(stray).toMatchObject({ _tag: "GitError" });
      }).pipe(Effect.provide(TestLayer)),
  );

  it.live(
    "releases: refuses dirty work, then prunes checkpoints and merges picked rules after removal",
    () =>
      Effect.gen(function* () {
        const root = repo();
        const checkouts = yield* CheckoutService;
        const checkpoints = yield* Checkpoints;
        write(settingsPath(root), JSON.stringify({ permissions: { allow: ["Bash(ls *)"] } }));
        const checkout = yield* checkouts.prepare({ kind: "newWorktree", branch: "b" }, [], root);
        const thread = threadAt(checkout);
        yield* checkpoints.snapshot(checkout.path, thread.id, "turn-1");

        write(nodePath.join(checkout.path, "tracked.txt"), "changed\n");
        write(
          settingsPath(checkout.path),
          JSON.stringify({
            permissions: { allow: ["Bash(ls *)", "Bash(date:*)", "Bash(whoami)"] },
          }),
        );
        const refusal = { _tag: "WorktreeDirty", path: checkout.path, changedFiles: 1 };
        const checked = yield* Effect.flip(
          checkouts.checkRelease(thread, { removeWorktree: { force: false } }),
        );
        expect(checked).toMatchObject(refusal);
        yield* checkouts.checkRelease(thread, { removeWorktree: { force: true } });
        yield* checkouts.checkRelease(thread, {});
        const dirty = yield* Effect.flip(
          checkouts.release(thread, {
            removeWorktree: { force: false },
            permissionRules: ["Bash(date:*)"],
          }),
        );
        expect(dirty).toMatchObject(refusal);
        expect(fs.existsSync(checkout.path)).toBe(true);
        expect(yield* checkpoints.list(root, thread.id)).toHaveLength(1);
        expect(readPermissionRules(root).allow).toEqual(["Bash(ls *)"]);

        yield* release(thread, {
          removeWorktree: { force: true },
          permissionRules: ["Bash(date:*)"],
        });
        expect(fs.existsSync(checkout.path)).toBe(false);
        expect(yield* checkpoints.list(root, thread.id)).toEqual([]);
        expect(readPermissionRules(root).allow).toEqual(["Bash(ls *)", "Bash(date:*)"]);

        // Without `repoRoot`: the refs still go with the worktree.
        const { repoRoot, ...bare } = yield* checkouts.prepare(
          { kind: "newWorktree", branch: "c" },
          [],
          root,
        );
        expect(repoRoot).toBe(root);
        const unrooted = { ...threadAt(bare), id: "thread-2" as ThreadId };
        yield* checkpoints.snapshot(bare.path, unrooted.id, "turn-1");
        yield* release(unrooted, { removeWorktree: { force: true } });
        expect(fs.existsSync(bare.path)).toBe(false);
        expect(yield* checkpoints.list(root, unrooted.id)).toEqual([]);

        // Deleted outside Gram, and without `repoRoot` too: the project's folder is the repo, and the
        // removal prunes what git still had registered.
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root, name: "r" });
        const { repoRoot: _gone, ...deleted } = yield* checkouts.prepare(
          { kind: "newWorktree", branch: "d" },
          [],
          root,
        );
        fs.rmSync(deleted.path, { recursive: true, force: true });
        const orphan = { ...threadAt(deleted), id: "thread-3" as ThreadId, projectId: project.id };
        yield* checkouts.checkRelease(orphan, { removeWorktree: { force: false } });
        yield* release(orphan, { removeWorktree: { force: false } });
        expect(run(root, "worktree", "list", "--porcelain")).not.toContain(deleted.path);

        // A worktree the thread followed its agent into is the one restored, not the launch folder.
        const followed = yield* checkouts.prepare({ kind: "newWorktree", branch: "f" }, [], root);
        fs.rmSync(followed.path, { recursive: true, force: true });
        const follower = {
          ...threadAt({ kind: "main", path: root }),
          id: "thread-4" as ThreadId,
          currentCheckout: followed,
        };
        expect(yield* checkouts.restore(follower, undefined)).toEqual({
          kind: "restored",
          source: "local",
        });
        expect(fs.existsSync(followed.path)).toBe(true);
        const main = yield* checkouts
          .restore(threadAt({ kind: "main", path: root }), undefined)
          .pipe(Effect.flip);
        expect(main).toMatchObject({ _tag: "InvalidState" });

        yield* release(threadAt({ kind: "main", path: root }), { removeWorktree: { force: true } });
        expect(fs.existsSync(root)).toBe(true);
        yield* checkouts.release(thread, {});
      }).pipe(Effect.provide(TestLayer)),
  );
});
