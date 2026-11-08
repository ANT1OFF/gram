import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  SqlClient,
  SqlStatement,
  type SqlConnection,
  SqlError,
  ConnectionError,
} from "../platform/unstable.ts";
import * as WriterWorker from "./writer-worker.ts";

const discardConnection = Symbol("discard durable SQLite connection");
type OwnedConnection = SqlConnection & { readonly [discardConnection]: () => void };
interface Generation {
  readonly scope: Scope.Closeable;
  connection: OwnedConnection;
  poisoned: boolean;
  /** Whether the connection's worker thread has stopped (`writer-worker.ts`); never, on the loop. */
  readonly stopped: () => boolean;
}

/**
 * Own the connection that durableCommit can discard. All borrowers share the gate; a poisoned
 * generation is closed before releasing it, and the next borrower opens a new NORMAL connection.
 * Statement borrowing stays scope-free; transactions and explicit reservations own a scoped lease.
 *
 * With `offLoop`, the connection lives on a worker thread (`writer-worker.ts`); a generation whose
 * worker stopped is replaced the same way as a poisoned one.
 */
export const durableSqliteLayer = (
  options:
    | (Pick<SqliteClient.SqliteClientConfig, "filename" | "readonly" | "busyTimeout"> & {
        readonly offLoop?: false | undefined;
      })
    // The writer worker opens read-write with its own busy timeout.
    | (Pick<SqliteClient.SqliteClientConfig, "filename"> & { readonly offLoop: true }),
  initialize?: (sql: SqlClient.SqlClient) => Effect.Effect<void, SqlError>,
): Layer.Layer<SqlClient.SqlClient, SqlError> =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const gate = yield* Semaphore.make(1);
      let current: Generation | undefined;
      let closed = false;
      const closeCurrent = Effect.suspend(() => {
        const old = current;
        current = undefined;
        return old === undefined ? Effect.void : Scope.close(old.scope, Exit.void);
      });
      // As with the native layer, teardown closes the database even if an update sealed its lease.
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          closed = true;
          return closeCurrent;
        }),
      );
      const closePoisoned = Effect.suspend(() =>
        current !== undefined && (current.poisoned || current.stopped())
          ? closeCurrent
          : Effect.void,
      );
      const available = Effect.suspend(() => {
        if (closed)
          return Effect.fail(
            new SqlError({
              reason: new ConnectionError({
                cause: undefined,
                message: "SQLite client is closed",
                operation: "connect",
              }),
            }),
          );
        if (current !== undefined && !current.stopped()) return Effect.succeed(current);
        return Effect.gen(function* () {
          // A generation whose worker stopped while idle: close its scope before replacing it.
          yield* closeCurrent;
          const scope = yield* Scope.make();
          return yield* Effect.gen(function* () {
            const context = yield* Layer.buildWithScope(
              options.offLoop === true
                ? WriterWorker.layer({ filename: options.filename })
                : SqliteClient.layer(options),
              scope,
            );
            const sql = Context.get(context, SqlClient.SqlClient);
            const stopped =
              WriterWorker.writerStopped in sql
                ? (sql as WriterWorker.WriterClient)[WriterWorker.writerStopped]
                : () => false;
            yield* sql`PRAGMA synchronous = NORMAL`;
            if (initialize !== undefined) yield* initialize(sql);
            const raw = yield* sql.reserve.pipe(Scope.provide(scope));
            const generation: Generation = {
              scope,
              poisoned: false,
              stopped,
              connection: Object.assign({}, raw, {
                [discardConnection]: () => {
                  generation.poisoned = true;
                },
                executeUnprepared: (...args: Parameters<SqlConnection["executeUnprepared"]>) =>
                  raw.executeUnprepared(...args).pipe(
                    Effect.tapCause(() =>
                      args[0] === "ROLLBACK"
                        ? Effect.sync(() => {
                            generation.poisoned = true;
                          })
                        : Effect.void,
                    ),
                  ),
              }),
            };
            current = generation;
            return generation;
          }).pipe(Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))));
        });
      });
      const acquire = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          yield* restore(gate.take(1));
          yield* Scope.addFinalizer(scope, closePoisoned.pipe(Effect.ensuring(gate.release(1))));
          return (yield* available).connection;
        }),
      );
      return yield* SqlClient.make({
        acquirer: acquire,
        transactionAcquirer: acquire,
        borrower: (f) =>
          gate.withPermit(
            Effect.flatMap(available, (generation) =>
              f(generation.connection).pipe(Effect.ensuring(closePoisoned)),
            ),
          ),
        compiler: SqlStatement.makeCompilerSqlite(),
        spanAttributes: [["db.system.name", "sqlite"]],
        beginTransaction:
          options.offLoop !== true && options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
        releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
        onCommitFailure: (conn) =>
          conn.executeUnprepared("ROLLBACK", [], undefined).pipe(Effect.asVoid),
      });
    }),
  ).pipe(Layer.provide(Reactivity.layer));

/**
 * A low-frequency safety transaction whose WAL commit must survive power loss before an
 * external action. Use FULL only for this transaction, restoring NORMAL before releasing it.
 * Failed cleanup discards the owned connection; it can never reach a subsequent borrower.
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
        if (!(discardConnection in conn)) {
          return yield* Effect.die(new Error("durableCommit requires durableSqliteLayer"));
        }
        const discard = (conn as OwnedConnection)[discardConnection];
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
          Effect.ensuring(
            execute("PRAGMA synchronous = NORMAL").pipe(
              Effect.tapCause(() => Effect.sync(discard)),
              Effect.orDie,
            ),
          ),
        );
      }),
    ),
  );
