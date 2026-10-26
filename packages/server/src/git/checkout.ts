import {
  CheckoutInUse,
  effectiveCheckout,
  GitError,
  InvalidState,
  WorktreeDirty,
  type Checkout,
  type Thread,
} from "@gram/contracts";
import {
  Checkpoints,
  git,
  Proc,
  samePath,
  worktreeCleanliness,
  Worktrees,
  type RestoredWorktree,
} from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { folderExists, resolveFolder } from "../fs/folders.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { heldCheckoutPaths, usedCheckoutPaths } from "../runtime/create-in-checkout.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { changedFileCount, removalError, toGitError } from "./mapping.ts";

/**
 * `release` options. `removeWorktree: true` is the port's current boolean (no force); `{ force }` is
 * the shape `hooks.ts` is moving to.
 */
export interface GitReleaseOptions {
  readonly removeWorktree?: boolean | { readonly force: boolean } | undefined;
  readonly permissionRules?: ReadonlyArray<string> | undefined;
}

const extraWorktrees = (thread: Thread) =>
  (thread.extraCheckouts ?? []).filter((extra) => extra.kind === "worktree");

/**
 * `CheckoutService` over `@gram/git`: the current checkout, a new worktree (placement,
 * `.worktreeinclude`, permission seeding, `repoRoot`), or an existing registered worktree, with one
 * thread per worktree checkout. Release optionally removes the worktree, merging the picked
 * permission rules back and pruning the thread's checkpoints only once removal succeeded. A worker's
 * worktrees in other repos (`extraCheckouts`) are removed with it, after every one of them passed
 * the dirty check, so a refusal leaves them all in place.
 */
export const GitCheckoutLive = Layer.effect(
  CheckoutService,
  Effect.gen(function* () {
    const proc = yield* Proc;
    const worktrees = yield* Worktrees;
    const checkpoints = yield* Checkpoints;
    const store = yield* ThreadStore;
    const provide = Effect.provideService(Proc, proc);

    const currentBranch = (path: string) =>
      provide(
        git(path, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.map((out) => {
            const branch = out.stdout.trim();
            return out.status === 0 && branch !== "" && branch !== "HEAD" ? branch : undefined;
          }),
          Effect.orElseSucceed(() => undefined),
        ),
      );

    /** The open worktree a new-worktree request would have reused, as a typed refusal. */
    const inUseWorktree = (
      root: string,
      branch: string,
      openCheckouts: ReadonlyArray<string>,
      message: string,
    ): Effect.Effect<never, CheckoutInUse> =>
      Effect.gen(function* () {
        const listed = yield* worktrees.list(root, { openCheckouts }).pipe(
          Effect.map((list) => list.worktrees),
          Effect.orElseSucceed(() => []),
        );
        const entry = listed.find((w) => w.isOpen && w.branch === branch);
        return yield* new CheckoutInUse({ path: entry?.path ?? root, message });
      });

    const prepare: CheckoutService["Service"]["prepare"] = (request, openCheckouts, projectRoot) =>
      Effect.gen(function* () {
        // Every kind checks its folder before git runs there, so a typo never persists a thread.
        const root = yield* resolveFolder(projectRoot);
        switch (request.kind) {
          case "current": {
            const branch = yield* currentBranch(root);
            return {
              kind: "main",
              path: root,
              ...(branch === undefined ? {} : { branch }),
            } satisfies Checkout;
          }
          case "newWorktree": {
            const created = yield* worktrees
              .create({
                repoPath: root,
                branch: request.branch,
                ...(request.base === undefined ? {} : { base: request.base }),
                openCheckouts,
              })
              .pipe(
                Effect.catch(
                  (
                    error,
                  ): Effect.Effect<
                    never,
                    CheckoutInUse | GitError | WorktreeDirty | InvalidState
                  > =>
                    error.reason === "conflict"
                      ? inUseWorktree(root, request.branch, openCheckouts, error.message)
                      : provide(removalError(error, root)),
                ),
              );
            return created.checkout;
          }
          case "existingWorktree": {
            const path = yield* resolveFolder(request.path);
            const list = yield* worktrees
              .list(path, { openCheckouts })
              .pipe(Effect.mapError(toGitError));
            const entry = list.worktrees.find((w) => samePath(w.path, path));
            const main = list.worktrees[0];
            if (entry === undefined || main === undefined) {
              return yield* new GitError({
                message: `${path} is not a worktree of this repository`,
              });
            }
            if (entry.isOpen) {
              return yield* new CheckoutInUse({
                path: entry.path,
                message: "a thread is already open in that checkout",
              });
            }
            const branch = entry.branch === undefined ? {} : { branch: entry.branch };
            return (
              entry.isMain
                ? { kind: "main", path: entry.path, ...branch }
                : { kind: "worktree", path: entry.path, ...branch, repoRoot: main.path }
            ) satisfies Checkout;
          }
        }
      });

    /** `WorktreeDirty` for the first checkout a non-forced removal would refuse, primary first. */
    const refuseDirty = (
      checkouts: ReadonlyArray<Checkout>,
      options: GitReleaseOptions,
    ): Effect.Effect<void, WorktreeDirty> =>
      Effect.gen(function* () {
        const removal = options.removeWorktree;
        if (removal === undefined || removal === false || (removal !== true && removal.force)) {
          return;
        }
        for (const target of checkouts) {
          if (target.kind !== "worktree") continue;
          // Unreadable status refuses too: removal won't delete what git can't show is clean.
          if ((yield* provide(worktreeCleanliness(target.path))) !== "clean") {
            const changedFiles = yield* provide(changedFileCount(target.path));
            return yield* new WorktreeDirty({ path: target.path, changedFiles });
          }
        }
      });

    /** The thread's project folder: its repo when nothing else names it. */
    const projectRootOf = (thread: Thread) =>
      store.listProjects.pipe(
        Effect.map((projects) => {
          const project = projects.find((p) => p.id === thread.projectId);
          return project === undefined ? undefined : (project.repoRoot ?? project.root);
        }),
      );

    /**
     * The main checkout of `target`'s repo, resolved while the worktree is still there. A worktree
     * checkout without `repoRoot` (one a hook reported) would otherwise remove its worktree from
     * inside it (which Windows refuses) and prune through the folder that removal just deleted,
     * leaking its refs. One whose worktree was deleted outside Gram goes by its project's folder,
     * since git can't run in a folder that isn't there.
     */
    const repoOf = (target: Checkout, thread: Thread): Effect.Effect<string> =>
      target.repoRoot !== undefined || target.kind !== "worktree"
        ? Effect.succeed(target.repoRoot ?? target.path)
        : worktrees.list(target.path, { openCheckouts: [] }).pipe(
            Effect.map((list) => list.worktrees[0]?.path),
            Effect.orElseSucceed(() => undefined),
            Effect.flatMap((main) =>
              main === undefined ? projectRootOf(thread) : Effect.succeed(main),
            ),
            Effect.map((main) => main ?? target.path),
          );

    const checkRelease = (
      thread: Thread,
      options: GitReleaseOptions,
    ): Effect.Effect<void, GitError | WorktreeDirty> =>
      refuseDirty([thread.checkout, ...extraWorktrees(thread)], options);

    const release = (
      thread: Thread,
      options: GitReleaseOptions,
    ): Effect.Effect<void, GitError | WorktreeDirty> =>
      Effect.gen(function* () {
        const checkout = thread.checkout;
        const repo = yield* repoOf(checkout, thread);
        // Only once removal succeeded, so a refused close keeps the thread's rewind points too.
        const prune = checkpoints.prune(repo, thread.id).pipe(Effect.ignore);
        const removal = options.removeWorktree;
        if (removal === undefined || removal === false) return yield* prune;
        const force = removal === true ? false : removal.force;
        const extras = extraWorktrees(thread);
        // Before anything goes: the primary removed and an extra then refused would leave a thread
        // that can neither close nor work.
        yield* refuseDirty(extras, options);
        // Read at removal time, followed checkouts included: another thread's agent may have moved in.
        // It isn't held across the removal, an accepted gap that `git/worktree-gc.ts` describes.
        const others = usedCheckoutPaths(
          (yield* store.listThreads).filter((t) => t.id !== thread.id),
        );
        const remove = (target: Checkout, mergeRules: ReadonlyArray<string> | undefined) =>
          Effect.gen(function* () {
            return yield* worktrees.remove({
              repoPath: target === checkout ? repo : yield* repoOf(target, thread),
              worktreeDir: target.path,
              force,
              openCheckouts: others,
              ...(mergeRules === undefined ? {} : { mergeRules }),
            });
          }).pipe(
            Effect.catch((error) =>
              provide(removalError(error, target.path)).pipe(
                Effect.catchTag("InvalidState", (e) => Effect.fail(toGitError(e))),
              ),
            ),
          );
        // The thread's own worktree goes first: it is the one most likely to refuse (it is where
        // the agent worked), and a refusal there must leave the extras for the retry. The picked
        // rules were read from it, so they are its repo's alone.
        if (checkout.kind === "worktree") yield* remove(checkout, options.permissionRules);
        for (const extra of extras) yield* remove(extra, undefined);
        yield* prune;
      });

    const discard = (checkout: Checkout): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (checkout.kind !== "worktree" || checkout.repoRoot === undefined) return;
        const open = heldCheckoutPaths(yield* store.listThreads);
        yield* worktrees
          .remove({
            repoPath: checkout.repoRoot,
            worktreeDir: checkout.path,
            force: false,
            openCheckouts: open,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("couldn't take back a prepared worktree").pipe(
                Effect.annotateLogs({ path: checkout.path, error: error.message }),
              ),
            ),
          );
      });

    const restore = (
      thread: Thread,
      fromPr: number | undefined,
    ): Effect.Effect<RestoredWorktree, GitError | InvalidState | CheckoutInUse> =>
      Effect.gen(function* () {
        const checkout = effectiveCheckout(thread);
        if (checkout.kind !== "worktree") {
          return yield* new InvalidState({
            message:
              "Only a worktree can be restored: this thread's folder was the repository itself.",
          });
        }
        if (checkout.branch === undefined) {
          return yield* new InvalidState({
            message: "This worktree's branch was never recorded, so it can't be restored.",
          });
        }
        const repo = yield* repoOf(checkout, thread);
        const others = usedCheckoutPaths(
          (yield* store.listThreads).filter((t) => t.id !== thread.id),
        );
        return yield* worktrees
          .restore({
            repoPath: repo,
            worktreeDir: checkout.path,
            branch: checkout.branch,
            fromPr,
            openCheckouts: others,
          })
          .pipe(
            Effect.catch((error): Effect.Effect<never, GitError | InvalidState | CheckoutInUse> =>
              error.reason === "conflict"
                ? Effect.fail(new CheckoutInUse({ path: checkout.path, message: error.message }))
                : error.reason === "invalidRequest"
                  ? Effect.fail(new InvalidState({ message: error.message }))
                  : Effect.fail(new GitError({ message: error.message })),
            ),
          );
      });

    return { prepare, checkRelease, release, discard, present: folderExists, restore };
  }),
);
