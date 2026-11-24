import * as Schema from "effect/Schema";

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
