// The start's sweep of the append-only history tables (`pruneHistory`), run by the store's start.

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { SqlClient } from "../platform/unstable.ts";
import { DAY_MS } from "../zone-time.ts";

// What the start's sweep keeps of the append-only history tables (`pruneHistory`). Nothing shows
// these past their windows; each rule keeps whatever something still reads.
/**
 * `orchestration_events`: 90 days. A worker's `spawn` event stays while the worker does, open or
 * closed and reopenable: a `clientRequestId` retry reads it to tell a finished spawn from one a
 * crash cut short.
 */
export const ORCHESTRATION_EVENTS_KEPT_MS = 90 * DAY_MS;
/**
 * `settings_audit`: a year, and the newest 1,000 whatever their age; an entry whose approval
 * request is still open stays too.
 */
export const SETTINGS_AUDIT_KEPT_MS = 365 * DAY_MS;
export const SETTINGS_AUDIT_KEPT_ROWS = 1_000;
/** `actor_events`: a year, and the newest 10,000 whatever their age. */
export const ACTOR_EVENTS_KEPT_MS = 365 * DAY_MS;
export const ACTOR_EVENTS_KEPT_ROWS = 10_000;
/** `helper_usage`: 400 UTC days of daily totals, of which the helper reads today's. */
export const HELPER_USAGE_KEPT_MS = 400 * DAY_MS;
/** `helper_events`: 30 UTC days of daily counts, of which the helper reads the last 7. */
export const HELPER_EVENTS_KEPT_MS = 30 * DAY_MS;

/** The UTC day `at` falls on, as the helper tables key their rows. */
const utcDayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * Prunes the append-only history tables to what they keep (`ORCHESTRATION_EVENTS_KEPT_MS` and the
 * rest), as of `now`. Run by the store's start.
 */
export const pruneHistory = (sql: SqlClient.SqlClient, now: number) =>
  sql
    .withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM orchestration_events
          WHERE at < ${now - ORCHESTRATION_EVENTS_KEPT_MS}
            AND NOT (kind = 'spawn' AND json_valid(data)
              AND (json_extract(data, '$.threadId') IN (SELECT id FROM threads)
                OR json_extract(data, '$.threadId') IN (SELECT thread_id FROM closed_threads)))`;
        yield* sql`DELETE FROM settings_audit
          WHERE at < ${now - SETTINGS_AUDIT_KEPT_MS}
            AND seq NOT IN (SELECT seq FROM settings_audit ORDER BY seq DESC
              LIMIT ${SETTINGS_AUDIT_KEPT_ROWS})
            AND (request_id IS NULL OR request_id NOT IN (SELECT id FROM requests))`;
        yield* sql`DELETE FROM actor_events
          WHERE at < ${now - ACTOR_EVENTS_KEPT_MS}
            AND seq NOT IN (SELECT seq FROM actor_events ORDER BY seq DESC
              LIMIT ${ACTOR_EVENTS_KEPT_ROWS})`;
        yield* sql`DELETE FROM helper_usage WHERE day < ${utcDayOf(now - HELPER_USAGE_KEPT_MS)}`;
        yield* sql`DELETE FROM helper_events WHERE day < ${utcDayOf(now - HELPER_EVENTS_KEPT_MS)}`;
      }),
    )
    .pipe(
      // History it couldn't prune now waits for the next start; nothing depends on it going.
      Effect.catchCause((cause) =>
        Effect.logWarning("couldn't prune the history tables").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
    );
