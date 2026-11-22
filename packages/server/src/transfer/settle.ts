import { InvalidState, type Thread } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { EventHubShape } from "../events/event-hub.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import type { ThreadTransferShape } from "./thread-transfer.ts";
const refuse = (message: string) => new InvalidState({ message });

/**
 * Settling a moved thread's copy here, and the copy it came back from (models/thread-move): the
 * copy here becomes read-only only when nothing on it is newer than the bundle.
 */
export const makeSettle = ({
  store,
  runtimes,
  hub,
  requireOn,
}: {
  readonly store: ThreadStoreShape;
  readonly runtimes: Pick<ThreadRuntimesShape, "restSessionThen">;
  readonly hub: EventHubShape;
  readonly requireOn: Effect.Effect<void, InvalidState>;
}): Pick<ThreadTransferShape, "settleThread" | "settledThere"> => {
  const settleThread: ThreadTransferShape["settleThread"] = (input, by) =>
    Effect.gen(function* () {
      yield* requireOn;
      const before = yield* store.getThread(input.threadId);
      if (before.transferredTo !== undefined) return before;
      const behind = (thread: Thread) => thread.lastActivityAt >= input.exportedAt;
      if (behind(before)) {
        return yield* refuse(
          "This thread carried on after it was exported, so its copy there is behind. Carry on in one of the two; moving it again makes another copy there.",
        );
      }
      const rested = yield* runtimes.restSessionThen(
        input.threadId,
        Effect.gen(function* () {
          if (behind(yield* store.getThread(input.threadId))) return undefined;
          const at = yield* Clock.currentTimeMillis;
          return yield* store.updateThread(input.threadId, (thread) => ({
            ...thread,
            parked: true,
            transferredTo: {
              name: input.to,
              at,
              ...(input.url === undefined ? {} : { url: input.url }),
              ...(input.server === undefined ? {} : { server: input.server }),
              ...(by === undefined ? {} : { by }),
            },
          }));
        }),
      );
      if (rested.state === "working") {
        return yield* refuse(
          "This thread started a turn after it was exported, so its copy there is behind. Carry on in one of the two; moving it again makes another copy there.",
        );
      }
      const settled = rested.value;
      if (settled === undefined) {
        return yield* refuse(
          "This thread carried on after it was exported, so its copy there is behind. Carry on in one of the two; moving it again makes another copy there.",
        );
      }
      yield* hub.publish({ type: "thread.upsert", thread: settled });
      return settled;
    });

  const settledThere: ThreadTransferShape["settledThere"] = (threadId) =>
    Effect.gen(function* () {
      yield* requireOn;
      const thread = yield* store.updateThread(threadId, (was) => {
        if (was.transferredFrom?.leftOpen === undefined) return was;
        const { leftOpen: _settled, ...from } = was.transferredFrom;
        return { ...was, transferredFrom: from };
      });
      yield* hub.publish({ type: "thread.upsert", thread });
      return thread;
    });

  return { settleThread, settledThere };
};
