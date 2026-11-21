import {
  InvalidState,
  type AgentUnavailable,
  type Checkout,
  type CheckoutInUse,
  type CheckoutRequest,
  checkoutRequestHost,
  type GitError,
  type HostId,
  hostOf,
  LOCAL_HOST_ID,
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
  on?: HostId,
): Array<string> =>
  threads.flatMap((thread) =>
    [thread.checkout, ...(thread.extraCheckouts ?? [])]
      .filter((checkout) => on === undefined || hostOf(checkout) === on)
      .map((checkout) => checkout.path),
  );

/**
 * `heldCheckoutPaths` and every checkout a thread follows its agent into (`currentCheckout`): the
 * folders no removal may take, though a new thread may still open in a followed one.
 */
export const usedCheckoutPaths = (
  threads: ReadonlyArray<Pick<Thread, "checkout" | "extraCheckouts" | "currentCheckout">>,
  on?: HostId,
): Array<string> => [
  ...heldCheckoutPaths(threads, on),
  ...threads.flatMap((thread) =>
    thread.currentCheckout === undefined ||
    (on !== undefined && hostOf(thread.currentCheckout) !== on)
      ? []
      : [thread.currentCheckout.path],
  ),
];

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
  readonly checkouts: Pick<CheckoutServiceShape, "prepare" | "place">;
  readonly runtimes: Pick<ThreadRuntimesShape, "create">;
}): ThreadCreator => {
  const prepare: ThreadCreator["prepare"] = (asked, projectRoot) =>
    Effect.gen(function* () {
      const request =
        deps.checkouts.place === undefined ? asked : yield* deps.checkouts.place(asked);
      const on = checkoutRequestHost(request) ?? LOCAL_HOST_ID;
      const open = heldCheckoutPaths(yield* deps.store.listThreads, on);
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

/** A thread's checkouts in the repositories it works in: its own, and one in each other. */
export interface CheckoutsWithOthers {
  readonly checkout: Checkout;
  readonly extraCheckouts: ReadonlyArray<Checkout>;
  /** The folders its agent is given beside its own: the other worktrees, or the others' folders. */
  readonly additionalDirectories: ReadonlyArray<string>;
}

/**
 * The checkout `request` asks for in `projectRoot`, and the thread's place in each of `others`
 * (projects' folders here, never `projectRoot` itself). With a worktree of its own, it gets one in
 * each other repository too, on its branch and on its machine; working in a folder as it is on
 * this machine, it gets the others' folders as they are. A repository that refuses takes the
 * worktrees made so far with it, so nothing is half made.
 */
export const prepareWithOthers = (
  deps: {
    readonly prepare: ThreadCreator["prepare"];
    readonly discard: (checkout: Checkout) => Effect.Effect<void>;
  },
  request: CheckoutRequest,
  projectRoot: string,
  others: ReadonlyArray<string>,
): Effect.Effect<CheckoutsWithOthers, InvalidState | NotFound | GitError | CheckoutInUse> =>
  Effect.gen(function* () {
    const checkout = yield* deps.prepare(request, projectRoot);
    if (others.length === 0) return { checkout, extraCheckouts: [], additionalDirectories: [] };
    const branch = checkout.kind === "worktree" ? checkout.branch : undefined;
    if (branch === undefined) {
      if (hostOf(checkout) !== LOCAL_HOST_ID) {
        yield* deps.discard(checkout);
        return yield* new InvalidState({
          message:
            "On another machine, other repositories come with a new worktree: start it in one.",
        });
      }
      return { checkout, extraCheckouts: [], additionalDirectories: [...others] };
    }
    const extraCheckouts: Array<Checkout> = [];
    for (const other of others) {
      const made = yield* deps
        .prepare(
          {
            kind: "newWorktree",
            branch,
            ...(hostOf(checkout) === LOCAL_HOST_ID ? {} : { hostId: hostOf(checkout) }),
          },
          other,
        )
        .pipe(
          Effect.onError(() =>
            Effect.forEach([checkout, ...extraCheckouts], deps.discard, { discard: true }),
          ),
        );
      extraCheckouts.push(made);
    }
    return {
      checkout,
      extraCheckouts,
      additionalDirectories: extraCheckouts.map((extra) => extra.path),
    };
  });
