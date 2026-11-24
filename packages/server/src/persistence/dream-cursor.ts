import type { WorkspaceId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { SqlClient } from "../platform/unstable.ts";
import { decodeStored } from "./stored.ts";

/**
 * Where a workspace's next memory update reads on from: the worker reports and orchestration events
 * past these seqs, and what happened after `at` (epoch ms). An adoption moves it on; a draft that
 * is discarded leaves it, so the next update reads the same again. It never moves back.
 */
export const DreamCursor = Schema.Struct({
  reportSeq: Schema.Int,
  eventSeq: Schema.Int,
  at: Schema.Number,
});
export type DreamCursor = typeof DreamCursor.Type;

/** A workspace with no cursor yet, made after the migration that seeded them: from its start, a time of 0 included. */
export const DREAM_CURSOR_START: DreamCursor = { reportSeq: 0, eventSeq: 0, at: -1 };

/** The later of two cursors, field by field, so a cursor never moves back. */
export const laterCursor = (a: DreamCursor, b: DreamCursor): DreamCursor => ({
  reportSeq: Math.max(a.reportSeq, b.reportSeq),
  eventSeq: Math.max(a.eventSeq, b.eventSeq),
  at: Math.max(a.at, b.at),
});

/** An orchestration event as `listOrchestrationEventsAfter` reads it. */
export interface OrchestrationEventRow {
  readonly seq: number;
  readonly workspaceId: WorkspaceId;
  readonly at: number;
  readonly kind: string;
  readonly data: unknown;
}

/** The workspace's events of `kinds` past `afterSeq`, oldest first: only what is new is read. */
export const eventsAfter = (
  sql: SqlClient.SqlClient,
  workspaceId: WorkspaceId,
  afterSeq: number,
  kinds: ReadonlyArray<string>,
) =>
  sql<{ seq: number; at: number; kind: string; data: string }>`SELECT seq, at, kind, data
    FROM orchestration_events
    WHERE workspace_id = ${workspaceId} AND seq > ${afterSeq}
      AND kind IN (SELECT value FROM json_each(${JSON.stringify(kinds)}))
    ORDER BY seq`.pipe(
    Effect.map((rows) =>
      rows.map((r): OrchestrationEventRow => ({
        seq: Number(r.seq),
        workspaceId,
        at: Number(r.at),
        kind: r.kind,
        data: JSON.parse(r.data) as unknown,
      })),
    ),
  );

/** The workspace's cursor; one that is missing or no longer decodes reads as none. */
export const readDreamCursor = (sql: SqlClient.SqlClient, workspaceId: WorkspaceId) =>
  sql<{ data: string }>`SELECT data FROM dream_cursors WHERE workspace_id = ${workspaceId}`.pipe(
    Effect.map((rows) => {
      if (rows[0] === undefined) return undefined;
      const decoded = decodeStored(DreamCursor, rows[0].data);
      return decoded.ok ? decoded.value : undefined;
    }),
  );

/** Moves the cursor on to `cursor`, field by field; run it in a transaction. */
export const advanceDreamCursor = (
  sql: SqlClient.SqlClient,
  workspaceId: WorkspaceId,
  cursor: DreamCursor,
) =>
  Effect.gen(function* () {
    const held = yield* readDreamCursor(sql, workspaceId);
    const next = held === undefined ? cursor : laterCursor(held, cursor);
    const data = JSON.stringify(Schema.encodeSync(DreamCursor)(next));
    yield* sql`INSERT INTO dream_cursors (workspace_id, data) VALUES (${workspaceId}, ${data})
      ON CONFLICT (workspace_id) DO UPDATE SET data = excluded.data`;
  });
