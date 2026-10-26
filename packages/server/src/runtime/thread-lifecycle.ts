// Creating a thread and closing it: one close per thread at a time, which a guard can refuse, and
// what of the checkout it releases.

import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import type * as Semaphore from "effect/Semaphore";
import {
  type ThreadId,
  InvalidState,
  type AgentUnavailable,
  type Thread,
  type ThreadNotFound,
  type GitError,
  type WorktreeDirty,
} from "@gram/contracts";
import type {
  CloseThreadOptions,
  ThreadRuntimesShape,
  ClaimGuard,
} from "./thread-runtimes-shape.ts";
import {
  coversRelease,
  locked,
  makeThreadId,
  type Runtime,
  atRest,
  type GetRuntime,
} from "./runtime-state.ts";
import { discoverDefaultModel } from "./default-model.ts";
import { basename } from "node:path";
import { samePath } from "@gram/git";
import type { AgentHosts } from "./agent-hosts.ts";
import type { McpTokens } from "../app-tools/mcp-tokens.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { EventHubShape } from "../events/event-hub.ts";
import type { CheckoutServiceShape } from "./hooks.ts";
import type { ThreadPlansShape } from "../plans/service.ts";
import type { TurnLifecycle } from "./turn-lifecycle.ts";
import type { MessageQueue } from "./message-queue.ts";
import * as FiberSet from "effect/FiberSet";

/** What creating and closing a thread read and change beside its `Runtime`. */
export interface ThreadLifecycleDeps {
  readonly store: ThreadStoreShape;
  readonly hub: EventHubShape;
  readonly checkouts: CheckoutServiceShape;
  readonly hosts: AgentHosts["Service"];
  readonly plans: ThreadPlansShape;
  readonly mcpTokens: Option.Option<McpTokens["Service"]>;
  readonly runtimes: Map<ThreadId, Runtime>;
  readonly getRuntime: GetRuntime;
  readonly sessions: FiberMap.FiberMap<ThreadId>;
  readonly recoveries: FiberMap.FiberMap<ThreadId, void, never>;
  readonly closes: FiberMap.FiberMap<
    ThreadId,
    void,
    ThreadNotFound | GitError | WorktreeDirty | InvalidState
  >;
  readonly runningCloses: Map<
    ThreadId,
    {
      readonly fiber: Fiber.Fiber<void, ThreadNotFound | GitError | WorktreeDirty | InvalidState>;
      readonly options: CloseThreadOptions;
    }
  >;
  readonly closeLock: Semaphore.Semaphore;
  readonly setStatus: TurnLifecycle["setStatus"];
  readonly publishUpsert: TurnLifecycle["publishUpsert"];
  readonly cancelIdleTimer: TurnLifecycle["cancelIdleTimer"];
  readonly stopSession: TurnLifecycle["stopSession"];
  readonly failPendingDeliveries: TurnLifecycle["failPendingDeliveries"];
  readonly send: MessageQueue["send"];
  readonly openSession: (
    rt: Runtime,
    thread: Thread,
    resumeAt?: string,
    switchAttempt?: string,
  ) => Effect.Effect<void, AgentUnavailable>;
}

/** Thread creation, and the close each thread runs at most one of. */
export const makeThreadLifecycle = ({
  store,
  hub,
  checkouts,
  hosts,
  plans,
  mcpTokens,
  runtimes,
  getRuntime,
  sessions,
  recoveries,
  closes,
  runningCloses,
  closeLock,
  setStatus,
  publishUpsert,
  cancelIdleTimer,
  stopSession,
  failPendingDeliveries,
  send,
  openSession,
}: ThreadLifecycleDeps) => {
  /** The thread's running close, or a new one in `closes` with these options. */
  const claimClose = (threadId: ThreadId, options: CloseThreadOptions) =>
    closeLock.withPermits(1)(
      Effect.gen(function* () {
        const running = runningCloses.get(threadId);
        if (running !== undefined) return { ...running, threadId, joined: true };
        const fiber = yield* FiberMap.run(closes, threadId, closeNow(threadId, options));
        const started = { fiber, options };
        runningCloses.set(threadId, started);
        fiber.addObserver(() => {
          if (runningCloses.get(threadId) === started) runningCloses.delete(threadId);
        });
        return { ...started, threadId, joined: false };
      }),
    );

  /**
   * A claimed close's outcome for a caller with `options`. A joined one that succeeded without the
   * worktree removal the caller asked for fails it: the thread is gone with its worktree kept, which
   * a worktree removal would count as done.
   */
  const settleClose = (
    claim: Effect.Success<ReturnType<typeof claimClose>>,
    options: CloseThreadOptions,
  ) =>
    Effect.gen(function* () {
      const exit = yield* Fiber.await(claim.fiber);
      if (Exit.isSuccess(exit) && claim.joined && !coversRelease(claim.options, options)) {
        return yield* new InvalidState({
          message: "another close of the thread finished first and kept its worktree",
          threadId: claim.threadId,
        });
      }
      return yield* Fiber.join(claim.fiber);
    });

  /** The whole close, run only by `claimClose`, so nothing but the server's shutdown interrupts it. */
  const closeNow = (threadId: ThreadId, options: CloseThreadOptions) =>
    Effect.gen(function* () {
      const thread = yield* store.getThread(threadId);
      const release = {
        ...(options.removeWorktree === undefined ? {} : { removeWorktree: options.removeWorktree }),
        ...(options.permissionRules === undefined
          ? {}
          : { permissionRules: options.permissionRules }),
      };
      // While the session still runs: a refused close leaves the thread working as it was.
      yield* checkouts.checkRelease(thread, release);
      const onlyAtRest = options.onlyAtRest === true;
      // Every close claims the runtime, a cold thread's too: without one to mark `closing`, a send
      // during the release started a session that outlived the thread, untracked and unstoppable.
      const rt = yield* getRuntime(threadId);
      // Before the session stops, so no recovery reopens it once the thread is gone: the mark
      // turns away one the watchdog starts, and any send, while the session is still stopping.
      // Under the lock sends take, so a guarded close sees the last send that got in.
      yield* locked(
        rt,
        Effect.gen(function* () {
          const changed = !(yield* guardHolds(threadId, options));
          if (changed || (onlyAtRest && !(yield* restsNow(rt)))) {
            return yield* new InvalidState({
              message: changed
                ? "the thread changed since it was checked, so it was left open"
                : "the thread is working, so it was left open",
              threadId,
              status: rt.status,
            });
          }
          rt.closing = true;
        }),
      );
      yield* Effect.gen(function* () {
        yield* cancelIdleTimer(rt);
        yield* FiberMap.remove(recoveries, threadId);
        yield* stopSession(rt, "close");
        // A thread closed cold never had a session whose exit would do this.
        yield* locked(rt, failPendingDeliveries(rt, "ended"));
        yield* checkouts.release(thread, release);
        // The checkout is gone, so the rest runs to the end even under a shutdown.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (Option.isSome(mcpTokens)) yield* mcpTokens.value.revoke(threadId);
            // Kept as it was, conversation included, so ⌘⇧T can bring it back, across restarts too.
            yield* store.closeThread(threadId, Date.now());
            // Only once the row is gone: until then a send finds the closing runtime and is refused,
            // where one finding none would make a fresh runtime and start a session.
            runtimes.delete(threadId);
            yield* hub.publish({ type: "thread.removed", threadId });
          }),
        );
      });
    }).pipe(
      // Cover every post-claim failure, including a defect in the final store transaction or an
      // interruption between marking the runtime and entering provider/checkout cleanup.
      Effect.onError(() =>
        Effect.suspend(() => {
          const rt = runtimes.get(threadId);
          if (rt === undefined || !rt.closing) return Effect.void;
          return locked(
            rt,
            Effect.gen(function* () {
              // Successful removal must never be turned into a reopen by notification failure.
              if (Option.isNone(yield* store.getThread(threadId).pipe(Effect.option))) return;
              rt.closing = false;
              // Keep a still-owning provider's status; only an absent lifetime becomes cold.
              if (!FiberMap.hasUnsafe(sessions, threadId)) yield* setStatus(rt, "cold");
            }),
          );
        }),
      ),
    );

  const create: ThreadRuntimesShape["create"] = (input) =>
    Effect.gen(function* () {
      const settings = yield* store.getSettings;
      const model =
        input.model ?? settings.agents.defaultModel ?? (yield* discoverDefaultModel(hosts));
      const project = yield* store.ensureProject({
        root: input.projectRoot,
        name: basename(input.projectRoot) || input.projectRoot,
      });
      const now = yield* Clock.currentTimeMillis;
      const firstLine = input.input?.text.split("\n")[0]?.trim().slice(0, 60);
      const thread: Thread = {
        id: input.id ?? makeThreadId(),
        projectId: project.id,
        title: input.title ?? (firstLine || "New thread"),
        userNamed: input.title !== undefined,
        model,
        mode: input.mode ?? settings.agents.defaultMode,
        checkout: input.checkout,
        labels: [],
        pinned: false,
        parked: false,
        unread: false,
        createdAt: now,
        lastActivityAt: now,
        ...(input.resumeSessionId === undefined ? {} : { agentSessionId: input.resumeSessionId }),
        ...(input.resumeSessionId === undefined || input.codexHome === undefined
          ? {}
          : { codexHome: input.codexHome }),
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.spawnedBy === undefined ? {} : { spawnedBy: input.spawnedBy }),
        ...(input.additionalDirectories === undefined || input.additionalDirectories.length === 0
          ? {}
          : { additionalDirectories: [...input.additionalDirectories] }),
        ...(input.extraCheckouts === undefined || input.extraCheckouts.length === 0
          ? {}
          : { extraCheckouts: [...input.extraCheckouts] }),
        ...input.kept,
      };
      yield* store.insertThread(thread);
      if (input.restoreClosedHistory === true) yield* store.restoreClosedHistory(thread.id);
      yield* publishUpsert(thread);
      // Clients dropped the plan with the thread when it closed; the upsert carries only the thread.
      if (input.restoreClosedHistory === true) yield* plans.publish(thread.id);
      if (input.input !== undefined) {
        yield* send(thread.id, input.input).pipe(Effect.catchTag("ThreadNotFound", Effect.die));
      } else if (input.resumeSessionId === undefined && input.deferOpen !== true) {
        const rt = yield* getRuntime(thread.id).pipe(Effect.orDie);
        yield* locked(rt, openSession(rt, thread));
      }
      // A resumed session stays cold until the first send, like a fork.
      return thread;
    });

  /** Whether `guard` still holds of the thread as stored; true without one. */
  const guardHolds = (threadId: ThreadId, guard: ClaimGuard) =>
    guard.expectedCheckout === undefined && guard.stillHolds === undefined
      ? Effect.succeed(true)
      : store.getThread(threadId).pipe(
          Effect.map((thread) => {
            const path = guard.expectedCheckout;
            const inCheckout =
              path === undefined ||
              (samePath(thread.checkout.path, path) &&
                (thread.currentCheckout === undefined ||
                  samePath(thread.currentCheckout.path, path)));
            return inCheckout && (guard.stillHolds?.(thread) ?? true);
          }),
          Effect.orElseSucceed(() => false),
        );

  /** `atRest`, nothing reserved, and no request waiting on the user. Holds the lock. */
  const restsNow = (rt: Runtime) =>
    Effect.gen(function* () {
      if (rt.reserved || !atRest(rt)) return false;
      return (yield* store.listRequests(rt.threadId)).length === 0;
    });

  return { claimClose, settleClose, guardHolds, restsNow, create };
};

/** What `makeThreadLifecycle` gives the rest of `ThreadRuntimes`. */
export type ThreadLifecycle = ReturnType<typeof makeThreadLifecycle>;

/** What the close `ThreadRuntimes` methods read beside the close itself. */
export interface CloseMethodsDeps {
  readonly getRuntime: GetRuntime;
  readonly runningCloses: ReadonlyMap<
    ThreadId,
    {
      readonly fiber: Fiber.Fiber<void, ThreadNotFound | GitError | WorktreeDirty | InvalidState>;
      readonly options: CloseThreadOptions;
    }
  >;
  readonly closeReleases: FiberSet.FiberSet;
  readonly claimClose: ThreadLifecycle["claimClose"];
  readonly settleClose: ThreadLifecycle["settleClose"];
  readonly guardHolds: ThreadLifecycle["guardHolds"];
  readonly restsNow: ThreadLifecycle["restsNow"];
  readonly pumpDeliveries: MessageQueue["pumpDeliveries"];
}

/** The `ThreadRuntimes` methods that close a thread, or work on it while it is at rest. */
export const makeCloseMethods = ({
  getRuntime,
  runningCloses,
  closeReleases,
  claimClose,
  settleClose,
  guardHolds,
  restsNow,
  pumpDeliveries,
}: CloseMethodsDeps): Pick<ThreadRuntimesShape, "close" | "releaseAfterClose" | "whileAtRest"> => ({
  close: (threadId, options = {}) =>
    Effect.gen(function* () {
      const first = yield* claimClose(threadId, options);
      const exit = yield* Fiber.await(first.fiber);
      if (Exit.isSuccess(exit) || !first.joined) return yield* settleClose(first, options);
      // The close it joined may have refused what this caller asks for regardless: a guarded
      // close from the UI that found the thread working, under a workspace removal's.
      return yield* settleClose(yield* claimClose(threadId, options), options);
    }),
  releaseAfterClose: (threadId, release) =>
    Effect.suspend(() => {
      const running = runningCloses.get(threadId);
      return running === undefined
        ? release
        : FiberSet.run(
            closeReleases,
            Fiber.await(running.fiber).pipe(Effect.andThen(release)),
          ).pipe(Effect.asVoid);
    }),
  whileAtRest: (threadId, effect, guard = {}) =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      yield* locked(
        rt,
        Effect.gen(function* () {
          const changed = !(yield* guardHolds(threadId, guard));
          // Cold too: a live session is an agent that could start something of its own.
          if (changed || rt.closing || rt.session !== undefined || !(yield* restsNow(rt))) {
            return yield* new InvalidState({
              message: changed
                ? "the thread changed since it was checked, so its worktree was left alone"
                : "the thread is working, so its worktree was left alone",
              threadId,
              status: rt.status,
            });
          }
          rt.reserved = true;
        }),
      );
      return yield* effect.pipe(
        Effect.ensuring(
          locked(
            rt,
            Effect.gen(function* () {
              rt.reserved = false;
              yield* pumpDeliveries(rt);
            }),
          ),
        ),
      );
    }),
});
