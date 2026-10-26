import type { HelperKind, HelperUsageLine, RequestId, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { SqlClient, type SqlError } from "../platform/unstable.ts";

/** Queue/output namespace only; consent and usage remain governed by HelperKind. */
export type HelperOutputKind = HelperKind | `${HelperKind}:paletteFilters`;

/** The stored output per thread, kind/namespace and optional pending request. */
interface HelperOutputRow {
  readonly threadId: ThreadId;
  readonly kind: HelperOutputKind;
  readonly requestId?: RequestId | undefined;
  /**
   * A subject of the thread's other than a request, such as a feature card's summary, kept in the
   * same column; unlike a request it is not checked for, and outlives nothing but its thread.
   */
  readonly scope?: string | undefined;
  readonly basis: string;
  readonly promptVersion: number;
  readonly model: string;
  readonly data: unknown;
  readonly createdAt: number;
}

/** One call's worth of ledger, added to its day, kind and model. */
interface HelperUsageDelta {
  readonly day: string;
  readonly kind: HelperKind;
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly failures: number;
}

export interface HelperStore {
  readonly addUsage: (delta: HelperUsageDelta) => Effect.Effect<void>;
  readonly usageOn: (day: string) => Effect.Effect<ReadonlyArray<HelperUsageLine>>;
  readonly getOutput: (
    threadId: ThreadId,
    kind: HelperOutputKind,
    /** A request id, or a `scope` (`HelperOutputRow.scope`). */
    requestId?: RequestId | string,
  ) => Effect.Effect<HelperOutputRow | undefined>;
  /** Stores `row` while its thread and, when scoped, pending request exist. */
  readonly putOutput: (row: HelperOutputRow) => Effect.Effect<void>;
  readonly addEvent: (
    day: string,
    kind: HelperKind,
    event: string,
    n: number,
  ) => Effect.Effect<void>;
  /** Each of `kind`'s event counters summed from UTC day `since` on. */
  readonly eventsSince: (
    since: string,
    kind: HelperKind,
  ) => Effect.Effect<Readonly<Record<string, number>>>;
}

/** A broken database is a defect, as in `ThreadStore`. */
const run = <A, R>(effect: Effect.Effect<A, SqlError, R>): Effect.Effect<A, never, R> =>
  effect.pipe(Effect.catch((error) => Effect.die(error)));

/** The helper scheduler's tables (`0013_helper`). */
export const makeHelperStore: Effect.Effect<HelperStore, never, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      addUsage: (d) =>
        run(sql`INSERT INTO helper_usage
            (day, kind, model, calls, input_tokens, output_tokens, cost_usd, failures)
          VALUES (${d.day}, ${d.kind}, ${d.model}, ${d.calls}, ${d.inputTokens}, ${d.outputTokens},
            ${d.costUsd}, ${d.failures})
          ON CONFLICT (day, kind, model) DO UPDATE SET
            calls = calls + excluded.calls,
            input_tokens = input_tokens + excluded.input_tokens,
            output_tokens = output_tokens + excluded.output_tokens,
            cost_usd = cost_usd + excluded.cost_usd,
            failures = failures + excluded.failures`).pipe(Effect.asVoid),
      usageOn: (day) =>
        run(
          sql<{
            kind: HelperKind;
            model: string;
            calls: number;
            input_tokens: number;
            output_tokens: number;
            cost_usd: number;
            failures: number;
          }>`SELECT kind, model, calls, input_tokens, output_tokens, cost_usd, failures
            FROM helper_usage WHERE day = ${day} ORDER BY kind, model`,
        ).pipe(
          Effect.map((rows) =>
            rows.map((r) => ({
              kind: r.kind,
              model: r.model,
              calls: Number(r.calls),
              inputTokens: Number(r.input_tokens),
              outputTokens: Number(r.output_tokens),
              costUsd: Number(r.cost_usd),
              failures: Number(r.failures),
            })),
          ),
        ),
      getOutput: (threadId, kind, requestId) =>
        run(
          sql<{
            basis: string;
            prompt_version: number;
            model: string;
            data: string;
            created_at: number;
          }>`SELECT basis, prompt_version, model, data, created_at FROM helper_outputs
            WHERE thread_id = ${threadId} AND kind = ${kind} AND request_id = ${requestId ?? ""}`,
        ).pipe(
          Effect.map(([row]) =>
            row === undefined
              ? undefined
              : {
                  threadId,
                  kind,
                  ...(requestId === undefined ? {} : { requestId: requestId as RequestId }),
                  basis: row.basis,
                  promptVersion: Number(row.prompt_version),
                  model: row.model,
                  data: JSON.parse(row.data) as unknown,
                  createdAt: Number(row.created_at),
                },
          ),
        ),
      // Conditional on the thread, in the same statement: a call can outlive its thread, and its
      // answer must neither bring back what `removeThread` or `closeThread` deleted nor fail on the
      // thread's absence (the store deletes child rows itself rather than trust foreign keys).
      putOutput: (r) =>
        run(sql`INSERT INTO helper_outputs
            (thread_id, kind, request_id, basis, prompt_version, model, data, created_at)
          SELECT ${r.threadId}, ${r.kind}, ${r.requestId ?? r.scope ?? ""}, ${r.basis}, ${r.promptVersion}, ${r.model},
            ${JSON.stringify(r.data)}, ${r.createdAt}
          WHERE EXISTS (SELECT 1 FROM threads WHERE id = ${r.threadId})
          AND (${r.requestId ?? ""} = '' OR EXISTS
            (SELECT 1 FROM requests WHERE thread_id = ${r.threadId} AND id = ${r.requestId ?? ""}))
          ON CONFLICT (thread_id, kind, request_id) DO UPDATE SET
            basis = excluded.basis,
            prompt_version = excluded.prompt_version,
            model = excluded.model,
            data = excluded.data,
            created_at = excluded.created_at`).pipe(Effect.asVoid),
      addEvent: (day, kind, event, n) =>
        run(sql`INSERT INTO helper_events (day, kind, event, n) VALUES (${day}, ${kind}, ${event}, ${n})
          ON CONFLICT (day, kind, event) DO UPDATE SET n = n + excluded.n`).pipe(Effect.asVoid),
      eventsSince: (since, kind) =>
        run(
          sql<{ readonly event: string; readonly n: number }>`SELECT event, SUM(n) AS n
            FROM helper_events WHERE kind = ${kind} AND day >= ${since} GROUP BY event`,
        ).pipe(Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.event, row.n])))),
    };
  },
);
