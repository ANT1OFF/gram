import type { QueueItemId, QueuedInput, TurnId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { type Runtime, stopHeld } from "./runtime-state.ts";
import type { TurnLifecycle } from "./turn-lifecycle.ts";
import type { MessageQueue } from "./message-queue.ts";
import type { SessionRestarts } from "./session-restarts.ts";
import type { LimitResume } from "./limit-resume.ts";
import { notInFlight } from "./user-input.ts";
import { isWorktreeWake } from "./worktree-activations.ts";

export const makeIdleDelivery = ({
  store,
  setStatus,
  switchHold,
  pumpDeliveries,
  isShuttingDown,
  unusedTurn,
  persistQueue,
  sendInFlight,
  finishTurn,
  setPendingRestart,
  reopenWhenIdle,
  queueHeld,
  startIdleTimer,
  startWorktreeWake,
  syncQueue,
  deliverNext,
  restartIfPending,
}: {
  readonly store: Pick<ThreadStoreShape, "getThread">;
  readonly setStatus: TurnLifecycle["setStatus"];
  readonly switchHold: MessageQueue["switchHold"];
  readonly pumpDeliveries: MessageQueue["pumpDeliveries"];
  readonly isShuttingDown: () => boolean;
  readonly unusedTurn: (rt: Runtime, turnId: TurnId | undefined) => Effect.Effect<TurnId>;
  readonly persistQueue: MessageQueue["persistQueue"];
  readonly sendInFlight: (options: {
    readonly rt: Runtime;
    readonly published?: boolean;
  }) => Effect.Effect<{ readonly started: Exit.Exit<void, never>; readonly refused?: true }>;
  readonly finishTurn: TurnLifecycle["finishTurn"];
  readonly setPendingRestart: SessionRestarts["setPendingRestart"];
  readonly reopenWhenIdle: SessionRestarts["reopenWhenIdle"];
  readonly queueHeld: LimitResume["queueHeld"];
  readonly startIdleTimer: TurnLifecycle["startIdleTimer"];
  readonly startWorktreeWake: (rt: Runtime, item: QueueItemId) => Effect.Effect<boolean>;
  readonly syncQueue: MessageQueue["syncQueue"];
  readonly deliverNext: MessageQueue["deliverNext"];
  readonly restartIfPending: SessionRestarts["restartIfPending"];
}) => {
  const becomeIdle = (rt: Runtime): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (rt.reopening || rt.activeWorktreeHook === true) return;
      if ((yield* switchHold(rt)) !== undefined) {
        yield* setStatus(rt, "idle");
        return yield* pumpDeliveries(rt);
      }
      if (isShuttingDown()) return yield* setStatus(rt, "idle");
      const launched = rt.reopenOnIdle ? undefined : rt.launch;
      if (launched !== undefined && rt.session !== undefined) {
        const turnId = yield* unusedTurn(rt, launched.turnId);
        rt.launch = undefined;
        rt.inFlight = { ...launched, turnId };
        yield* persistQueue(rt);
        const { started, refused } = yield* sendInFlight({
          rt,
          published: turnId === launched.turnId,
        });
        if (refused !== true) {
          if (Exit.isSuccess(started)) return;
          if (rt.turn !== undefined) yield* finishTurn(rt, "interrupted", "sendFailed");
        }
      }
      yield* setStatus(rt, "idle");
      if (rt.reopenOnIdle) {
        if (rt.pendingRestart !== undefined) {
          rt.restartMarker ??= rt.pendingRestart;
          yield* setPendingRestart(rt, undefined);
        }
        return yield* reopenWhenIdle(rt);
      }
      if (stopHeld(rt)) return;
      if (rt.limitWait !== undefined) return yield* startIdleTimer(rt);
      if (yield* queueHeld(rt)) return yield* startIdleTimer(rt);
      const archived = (item: QueuedInput | undefined) =>
        item !== undefined && rt.noticeKeys.has(item.id)
          ? store.getThread(rt.threadId).pipe(
              Effect.map((thread) => thread.parked),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false);
      const held = rt.session !== undefined && (yield* archived(rt.queue[0]));
      const wake = rt.queue[0]?.id;
      if (
        !held &&
        rt.session !== undefined &&
        wake !== undefined &&
        rt.resumedWorktreeNotice !== wake &&
        isWorktreeWake(rt.noticeKeys.get(wake)) &&
        (yield* startWorktreeWake(rt, wake))
      )
        return;
      const next = rt.session === undefined || held ? undefined : rt.queue.shift();
      if (next !== undefined) {
        rt.resumedWorktreeNotice = undefined;
        rt.inFlight = { ...next, turnId: yield* unusedTurn(rt, next.turnId) };
        yield* syncQueue(rt);
      }
      if (held) {
        yield* startIdleTimer(rt);
      } else if (next !== undefined && (yield* archived(next))) {
        rt.inFlight = undefined;
        rt.queue.unshift(notInFlight(next));
        yield* syncQueue(rt);
        yield* startIdleTimer(rt);
      } else if (next !== undefined && rt.session !== undefined && rt.inFlight !== undefined) {
        const { started, refused } = yield* sendInFlight({ rt });
        if (refused === true) return yield* becomeIdle(rt);
        if (Exit.isFailure(started)) return yield* Effect.failCause(started.cause);
      } else if (rt.session === undefined || !(yield* deliverNext(rt, rt.session))) {
        yield* startIdleTimer(rt);
        yield* restartIfPending(rt);
      }
    });

  return becomeIdle;
};
