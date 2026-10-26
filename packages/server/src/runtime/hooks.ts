import {
  GitError,
  InvalidState,
  type Checkout,
  type CheckoutInUse,
  type NotFound,
  type CheckoutRequest,
  type ThreadId,
  type Thread,
  type TurnEndReason,
  type TurnId,
  type WorktreeDirty,
} from "@gram/contracts";
import type { RestoredWorktree } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { resolveFolder } from "../fs/folders.ts";

export interface TurnHooksShape {
  onTurnStart(threadId: ThreadId, turnId: TurnId, cwd: string): Effect.Effect<void>;
  /** `touchedRemote`: the turn ran a command GitHub reacts to (`touchesRemote`). */
  onTurnEnd(
    threadId: ThreadId,
    turnId: TurnId,
    cwd: string,
    reason: TurnEndReason,
    touchedRemote: boolean,
  ): Effect.Effect<void>;
  /** A command GitHub reacts to — a push, a `gh pr` write — just finished. */
  onRemoteCommand(threadId: ThreadId, cwd: string): Effect.Effect<void>;
  /** The agent reported file changes during a turn. */
  onFilesChanged(threadId: ThreadId, cwd: string): Effect.Effect<void>;
  /**
   * The agent reported working in `cwd`. Returns the checkout the thread should follow, `null` to
   * return to its own, or `undefined` to leave it as it is.
   */
  resolveCwd(
    thread: Thread,
    cwd: string,
    follow: boolean,
  ): Effect.Effect<Checkout | null | undefined>;
}

/**
 * Called by `ThreadRuntimes` around turns (per-turn checkpoints, git refresh). A hook that fails or
 * dies is logged; it never fails the turn.
 */
export class TurnHooks extends Context.Service<TurnHooks, TurnHooksShape>()(
  "@gram/server/TurnHooks",
) {
  static readonly layerNoop: Layer.Layer<TurnHooks> = Layer.succeed(
    TurnHooks,
    TurnHooks.of({
      onTurnStart: () => Effect.void,
      onTurnEnd: () => Effect.void,
      onRemoteCommand: () => Effect.void,
      onFilesChanged: () => Effect.void,
      resolveCwd: () => Effect.succeed(undefined),
    }),
  );
}

export interface ReleaseCheckoutOptions {
  /** Also remove the worktree; `force` discards uncommitted changes instead of `WorktreeDirty`. */
  readonly removeWorktree?: { readonly force: boolean };
  /** `.claude/settings.local.json` rules the user chose to union back into the main checkout. */
  readonly permissionRules?: ReadonlyArray<string>;
}

export interface CheckoutServiceShape {
  /**
   * Resolves what `thread.create` asked for into the thread's checkout. `openCheckouts` are the
   * paths live threads already use (the one-thread-per-worktree guard, `CheckoutInUse`);
   * `projectRoot` is the path the user opened, which a `current` checkout uses directly.
   */
  prepare(
    request: CheckoutRequest,
    openCheckouts: ReadonlyArray<string>,
    projectRoot: string,
  ): Effect.Effect<Checkout, GitError | WorktreeDirty | InvalidState | NotFound | CheckoutInUse>;
  /**
   * Fails with the refusal `release` would give for these options, changing nothing. `thread.close`
   * calls it before it stops the session, so a close that would be refused leaves the thread as it
   * was.
   */
  checkRelease(
    thread: Thread,
    options: ReleaseCheckoutOptions,
  ): Effect.Effect<void, GitError | WorktreeDirty>;
  /**
   * Called by `thread.close` after the session has stopped. With `removeWorktree` the thread's
   * `extraCheckouts` go too, and an uncommitted change in any of them refuses the whole removal
   * with `WorktreeDirty` naming that path, before anything is deleted. The thread's checkpoints
   * are pruned only once that succeeded.
   */
  release(
    thread: Thread,
    options: ReleaseCheckoutOptions,
  ): Effect.Effect<void, GitError | WorktreeDirty>;
  /**
   * Takes back a worktree `prepare` made for a thread that was then never created. It never forces,
   * so a checkout `prepare` reused with work already in it stays, and it never fails: a worktree it
   * couldn't remove is only logged.
   */
  discard(checkout: Checkout): Effect.Effect<void>;
  /**
   * Whether the folder at `path` is still there: false only when it is definitely gone, deleted
   * outside Gram. A send to a thread whose folder is gone is refused, and a session whose
   * folder goes mid-turn is stopped.
   */
  present(path: string): Effect.Effect<boolean>;
  /**
   * Recreates the thread's worktree (`effectiveCheckout`: a followed one too), deleted outside
   * Gram, at its recorded path on its branch (`Worktrees.restore`); `fromPr` is the PR whose head recreates a branch gone everywhere.
   */
  restore(
    thread: Thread,
    fromPr: number | undefined,
  ): Effect.Effect<RestoredWorktree, GitError | InvalidState | CheckoutInUse>;
}

const releaseNoGit = (removeWorktree: ReleaseCheckoutOptions["removeWorktree"]) =>
  removeWorktree === undefined
    ? Effect.void
    : Effect.fail(new GitError({ message: "removing a worktree needs the git runtime" }));

export class CheckoutService extends Context.Service<CheckoutService, CheckoutServiceShape>()(
  "@gram/server/CheckoutService",
) {
  /**
   * No git: uses the opened folder or an existing worktree as-is, never removes anything, and
   * takes every folder as present.
   */
  static readonly layerNoGit: Layer.Layer<CheckoutService> = Layer.succeed(
    CheckoutService,
    CheckoutService.of({
      prepare: (request, _openCheckouts, projectRoot) => {
        switch (request.kind) {
          case "current":
            return resolveFolder(projectRoot).pipe(
              Effect.map((path): Checkout => ({ kind: "main", path })),
            );
          case "existingWorktree":
            return resolveFolder(request.path).pipe(
              Effect.map((path): Checkout => ({ kind: "worktree", path })),
            );
          case "newWorktree":
            return Effect.fail(
              new InvalidState({ message: "creating a worktree needs the git runtime" }),
            );
        }
      },
      checkRelease: (_thread, { removeWorktree }) => releaseNoGit(removeWorktree),
      release: (_thread, { removeWorktree }) => releaseNoGit(removeWorktree),
      discard: () => Effect.void,
      // Every folder counts as there: runtime tests run threads in made-up paths.
      present: () => Effect.succeed(true),
      restore: () =>
        Effect.fail(new InvalidState({ message: "restoring a worktree needs the git runtime" })),
    }),
  );
}
