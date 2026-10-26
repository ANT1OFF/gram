import * as Effect from "effect/Effect";
import { ThreadRuntimes } from "../../runtime/thread-runtimes.ts";
import type { Handlers } from "./common.ts";

/** `threads.reorder`. */
export const sidebarHandlers = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;

  return {
    "threads.reorder": ({ threadIds }) =>
      Effect.forEach(
        threadIds,
        (threadId, sortOrder) =>
          runtimes
            .updateThread(threadId, (t) => (t.sortOrder === sortOrder ? t : { ...t, sortOrder }))
            // A thread closed while the drag was in flight just drops out of the order.
            .pipe(Effect.catchTag("ThreadNotFound", () => Effect.void)),
        { discard: true },
      ),
  } satisfies Partial<Handlers>;
});
