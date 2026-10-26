import {
  InvalidState,
  type AgentUnavailable,
  type Checkout,
  type CheckoutInUse,
  type CheckoutRequest,
  type GitError,
  type NotFound,
  type Thread,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { CheckoutServiceShape } from "./hooks.ts";
import type { CreateThreadInput, ThreadRuntimesShape } from "./thread-runtimes.ts";

/**
 * Every checkout the threads hold, for the one-thread-per-worktree guard: each thread's own, and the
 * worktrees in other repos a worker spanning them was given (`Thread.extraCheckouts`). Those are
 * never a session's cwd, so nothing but the thread row says they are taken.
 */
export const heldCheckoutPaths = (
  threads: ReadonlyArray<Pick<Thread, "checkout" | "extraCheckouts">>,
): Array<string> =>
  threads.flatMap((thread) => [
    thread.checkout.path,
    ...(thread.extraCheckouts ?? []).map((extra) => extra.path),
  ]);

/**
 * `heldCheckoutPaths` and every checkout a thread follows its agent into (`currentCheckout`): the
 * folders no removal may take, though a new thread may still open in a followed one.
 */
export const usedCheckoutPaths = (
  threads: ReadonlyArray<Pick<Thread, "checkout" | "extraCheckouts" | "currentCheckout">>,
): Array<string> => [
  ...heldCheckoutPaths(threads),
  ...threads.flatMap((thread) =>
    thread.currentCheckout === undefined ? [] : [thread.currentCheckout.path],
  ),
];

/** Why a thread couldn't be started in the checkout asked for. */
type CreateInCheckoutError = InvalidState | NotFound | GitError | CheckoutInUse | AgentUnavailable;

export interface ThreadCreator {
  /**
   * Resolves a checkout request against the checkouts open threads already hold (the
   * one-thread-per-worktree guard). Creation has no `WorktreeDirty` slot and can't hit it anyway,
   * so it reads as `InvalidState`; `CheckoutInUse` is left for the caller to word.
   */
  prepare(
    request: CheckoutRequest,
    projectRoot: string,
  ): Effect.Effect<Checkout, InvalidState | NotFound | GitError | CheckoutInUse>;
  /**
   * Prepares the checkout, runs `afterPrepare` (what must only happen once the checkout exists,
   * such as marking a task chip accepted), then creates the thread in it.
   */
  createIn<E = never>(
    request: CheckoutRequest,
    projectRoot: string,
    input: Omit<CreateThreadInput, "projectRoot" | "checkout">,
    afterPrepare?: (checkout: Checkout) => Effect.Effect<void, E>,
  ): Effect.Effect<Thread, CreateInCheckoutError | E>;
}

/**
 * The one way a thread is started in a checkout the server prepares for it: `thread.create`,
 * `task.accept` and the orchestrator's `spawn_worker` all go through here, so a follow-up task and
 * a spawned worker get the same guard and the same errors.
 */
export const makeThreadCreator = (deps: {
  readonly store: Pick<ThreadStoreShape, "listThreads">;
  readonly checkouts: Pick<CheckoutServiceShape, "prepare">;
  readonly runtimes: Pick<ThreadRuntimesShape, "create">;
}): ThreadCreator => {
  const prepare: ThreadCreator["prepare"] = (request, projectRoot) =>
    Effect.gen(function* () {
      const open = heldCheckoutPaths(yield* deps.store.listThreads);
      return yield* deps.checkouts.prepare(request, open, projectRoot);
    }).pipe(
      Effect.catchTag("WorktreeDirty", (e) =>
        Effect.fail(new InvalidState({ message: `${e.path} has uncommitted changes` })),
      ),
    );
  return {
    prepare,
    createIn: (request, projectRoot, input, afterPrepare) =>
      Effect.gen(function* () {
        const checkout = yield* prepare(request, projectRoot);
        if (afterPrepare !== undefined) yield* afterPrepare(checkout);
        return yield* deps.runtimes.create({ ...input, projectRoot, checkout });
      }),
  };
};
