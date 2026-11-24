import type { MachineMovingEvent, Thread, ThreadId } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";

type Store = Pick<ThreadStoreShape, "getThread" | "updateThread">;
type Publish = (thread: Thread) => Effect.Effect<void>;

/**
 * The thread's session waits for its machine to come back from a move (`machineMoving`): it shows
 * the move's notice (`Thread.machineMove`) until the session ends.
 */
export const startMachineMove = (
  store: Store,
  publish: Publish,
  threadId: ThreadId,
  event: typeof MachineMovingEvent.Type,
) =>
  Effect.gen(function* () {
    const machine = event.machine;
    if (machine === undefined) return;
    const at = yield* Clock.currentTimeMillis;
    yield* Effect.logInfo("a thread's machine is being replaced; its session waits for it").pipe(
      Effect.annotateLogs({ threadId, until: event.until }),
    );
    const thread = yield* store
      .updateThread(threadId, (t) => ({ ...t, machineMove: { machine, at, until: event.until } }))
      .pipe(Effect.orDie);
    yield* publish(thread);
  });

/** The session no longer waits for its machine to move, as it ended: the move's notice goes. */
export const endMachineMove = (store: Store, publish: Publish, threadId: ThreadId) =>
  Effect.gen(function* () {
    const thread = yield* store.getThread(threadId).pipe(Effect.option);
    if (Option.isNone(thread) || thread.value.machineMove === undefined) return;
    const next = yield* store
      .updateThread(threadId, (current) => {
        const { machineMove: _, ...rest } = current;
        return rest;
      })
      .pipe(Effect.orDie);
    yield* publish(next);
  });
