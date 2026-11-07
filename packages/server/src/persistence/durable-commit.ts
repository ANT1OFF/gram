import * as Effect from "effect/Effect";
import type { SqlClient, SqlError } from "../platform/unstable.ts";

/**
 * A low-frequency safety transaction whose WAL commit must survive power loss before an
 * external action. Reserve SQLite's single connection, use FULL only for this transaction,
 * and restore NORMAL before releasing it. Queries in `effect` use this client's connection.
 * Call instead of a top-level withTransaction, never inside one; the body must not nest one.
 */
export const durableCommit = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SqlError, R> =>
  Effect.scoped(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const conn = yield* sql.reserve;
        const execute = (text: string) => conn.executeUnprepared(text, [], undefined);
        return yield* execute("PRAGMA synchronous = FULL").pipe(
          Effect.andThen(execute("BEGIN IMMEDIATE")),
          Effect.andThen(
            effect.pipe(
              Effect.provideService(sql.transactionService, [conn, 0]),
              Effect.tap(() => execute("COMMIT")),
              Effect.onError(() => execute("ROLLBACK").pipe(Effect.orDie)),
            ),
          ),
          Effect.ensuring(execute("PRAGMA synchronous = NORMAL")),
        );
      }),
    ),
  );
