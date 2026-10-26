// The startup sweep for messages whose search index row is behind (`messageSearchPending`): a
// reply cut off by a crash or a stop between two refreshes. Indexed in small batches, each its own
// short write, in the background, so a large backlog never holds the event loop or the open.

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { SqlClient, type SqlError } from "../platform/unstable.ts";

/** Messages indexed per batch: a few long replies at most. */
export const CATCH_UP_BATCH = 4;

/**
 * Waits between attempts while another connection holds the write lock past the busy timeout:
 * from 100 ms, doubling, to 30 s apart, for as long as it takes.
 */
export const LOCK_RETRY: Schedule.Schedule<unknown, SqlError> = Schedule.min([
  Schedule.exponential("100 millis"),
  Schedule.spaced("30 seconds"),
]);

/** The write lock was held elsewhere: retrying later can succeed, unlike any other failure. */
export const isLockWait = (error: SqlError) =>
  error.reason._tag === "LockTimeoutError" || error.reason._tag === "DeadlockError";

/**
 * Indexes every marked message, `CATCH_UP_BATCH` at a time; returns how many batches it wrote. A
 * batch that finds the write lock held is retried on `retry`, so a busy moment delays the sweep
 * without ending it; any other failure does end it.
 */
export const catchUpSearch = (retry: Schedule.Schedule<unknown, SqlError> = LOCK_RETRY) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Read first: even an UPDATE that changes nothing takes the write lock.
    const step = Effect.gen(function* () {
      const batch = yield* sql<{ rowid: number }>`SELECT rowid FROM messages
        WHERE search_pending IS NOT NULL LIMIT ${CATCH_UP_BATCH}`;
      if (batch.length === 0) return false;
      yield* sql`UPDATE messages SET search_pending = NULL
        WHERE rowid IN (SELECT value FROM json_each(${JSON.stringify(batch.map((r) => r.rowid))}))
          AND search_pending IS NOT NULL`;
      return true;
    }).pipe(Effect.retry({ schedule: retry, while: isLockWait }));
    let batches = 0;
    while (yield* step) {
      batches++;
      yield* Effect.yieldNow;
    }
    return batches;
  });

/** Runs the sweep once the database opens, without holding up the open. */
export const SearchCatchUp: Layer.Layer<never, never, SqlClient.SqlClient> = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Started at once: with nothing behind, the sweep has read so and ended before the store opens.
    yield* Effect.forkScoped(
      catchUpSearch().pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catch((error) =>
          Effect.logWarning("search: couldn't index the messages cut off mid-stream").pipe(
            Effect.annotateLogs({ error: String(error) }),
          ),
        ),
      ),
      { startImmediately: true },
    );
  }),
);
