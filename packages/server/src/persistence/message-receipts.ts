import { InvalidState, ThreadNotFound, type ThreadId } from "@gram/contracts";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import type { SqlClient } from "../platform/unstable.ts";

/** Per thread; count ordered, independent of wall clocks. Unfinished reservations never expire. */
export const MESSAGE_RECEIPT_LIMIT = 1024;

interface ReceiptRow {
  fingerprint: string;
  outcome: string | null;
}

/**
 * Reserve before touching the agent, finish before acknowledging. Work belongs to the store
 * scope, so a dropped socket cannot cancel it; shutting down the server still can. A crash can
 * leave an uncertain reservation: refuse its retry instead of guessing that an external agent
 * didn't take the input. Completed results survive boot.
 */
export const makeMessageReceipts = (sql: SqlClient.SqlClient, scope: Scope.Scope) => {
  const locks = new Map<string, { semaphore: Semaphore.Semaphore; refs: number }>();
  return <A, E, R>(
    threadId: ThreadId,
    clientMessageId: string,
    request: unknown,
    success: Schema.Codec<A, unknown>,
    error: Schema.Codec<E, unknown>,
    action: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | InvalidState | ThreadNotFound, R> =>
    Effect.suspend(() => {
      const key = JSON.stringify([threadId, clientMessageId]);
      const lock = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), refs: 0 };
      locks.set(key, lock);
      lock.refs++;
      const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      const run = Effect.gen(function* () {
        const prior = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const [row] = yield* sql<ReceiptRow>`SELECT fingerprint, outcome FROM message_receipts
            WHERE thread_id = ${threadId} AND client_message_id = ${clientMessageId}`;
              if (row !== undefined) return row;
              const [thread] = yield* sql`SELECT id FROM threads WHERE id = ${threadId}`;
              if (thread === undefined) return yield* new ThreadNotFound({ threadId });
              const [pending] = yield* sql<{
                count: number;
              }>`SELECT COUNT(*) AS count FROM message_receipts
            WHERE thread_id = ${threadId} AND outcome IS NULL`;
              const room = MESSAGE_RECEIPT_LIMIT - Number(pending!.count) - 1;
              if (room < 0)
                return yield* new InvalidState({
                  threadId,
                  message:
                    "Too many unfinished message requests; inspect the thread before sending again.",
                });
              // Prune only completed receipts, never a request that might still be in flight.
              yield* sql`DELETE FROM message_receipts WHERE seq IN (
            SELECT seq FROM message_receipts WHERE thread_id = ${threadId} AND outcome IS NOT NULL
            ORDER BY seq DESC LIMIT -1 OFFSET ${room})`;
              yield* sql`INSERT INTO message_receipts (thread_id, client_message_id, fingerprint)
            VALUES (${threadId}, ${clientMessageId}, ${fingerprint})`;
              return undefined;
            }),
          )
          .pipe(Effect.catchTag("SqlError", Effect.die));
        if (prior !== undefined) {
          if (prior.fingerprint !== fingerprint)
            return yield* new InvalidState({
              threadId,
              message: "This client message id was already used for different input.",
            });
          if (prior.outcome === null)
            return yield* new InvalidState({
              threadId,
              message:
                "This message may already have been delivered. Its result is unavailable; inspect the thread before sending again.",
            });
          const outcome = JSON.parse(prior.outcome) as { ok: boolean; value: unknown };
          return outcome.ok
            ? Schema.decodeUnknownSync(success)(outcome.value)
            : yield* Effect.fail(Schema.decodeUnknownSync(error)(outcome.value));
        }
        // Typed failures are replayed too; a defect leaves the durable reservation uncertain.
        const outcome = yield* action.pipe(
          Effect.match({
            onSuccess: (value) => ({ ok: true, value: Schema.encodeSync(success)(value) }),
            onFailure: (value) => ({ ok: false, value: Schema.encodeSync(error)(value) }),
          }),
        );
        yield* sql`UPDATE message_receipts SET outcome = ${JSON.stringify(outcome)}
          WHERE thread_id = ${threadId} AND client_message_id = ${clientMessageId}`.pipe(
          Effect.orDie,
        );
        return outcome.ok
          ? Schema.decodeUnknownSync(success)(outcome.value)
          : yield* Effect.fail(Schema.decodeUnknownSync(error)(outcome.value));
      });
      return lock.semaphore.withPermit(run).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (--lock.refs === 0) locks.delete(key);
          }),
        ),
      );
    }).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join));
};
