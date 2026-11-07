import * as Effect from "effect/Effect";
import { captureReadWorker, withReadWorker } from "../persistence/read-worker.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import type { Handlers } from "../rpc/handlers/common.ts";
import { searchThreads } from "./search.ts";

/** `thread.search`. */
export const searchHandlers = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const sql = yield* SqlClient.SqlClient;
  const reads = withReadWorker(yield* captureReadWorker);

  return {
    "thread.search": ({ query, threadId, limit }) =>
      Effect.gen(function* () {
        if (threadId !== undefined) yield* store.getThread(threadId);
        return yield* searchThreads({ query, threadId, limit }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          reads,
        );
      }),
  } satisfies Partial<Handlers>;
});
