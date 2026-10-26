import * as Effect from "effect/Effect";
import { SqlClient } from "../platform/unstable.ts";

const projection = (row: "new") => {
  const body = `CASE WHEN json_valid(${row}.message) THEN ${row}.message ELSE '{}' END`;
  const conflict = `(json_type(${body}, '$.metadata.modelConflict') IS NOT NULL
    AND json_type(${body}, '$.metadata.modelConflict') != 'false')`;
  const base = `json_object('metadata', json_object(
    'agent', CASE WHEN json_extract(${body}, '$.metadata.agent') IN ('claude', 'codex')
      THEN json_extract(${body}, '$.metadata.agent') END,
    'model', CASE WHEN json_type(${body}, '$.metadata.model') = 'text'
      AND NOT ${conflict}
      THEN NULLIF(json_extract(${body}, '$.metadata.model'), '') END))`;
  const marked = `CASE WHEN ${conflict} THEN json_set(${base}, '$.metadata.modelConflict', 1) ELSE ${base} END`;
  const main = `CASE WHEN json_type(${body}, '$.metadata.agentSessionId') = 'text'
    THEN json_set(${marked}, '$.metadata.agentSessionId', json_extract(${body}, '$.metadata.agentSessionId'))
    ELSE ${marked} END`;
  return `CASE WHEN ${row}.role = 'assistant' THEN
    CASE WHEN json_extract(${body}, '$.metadata.parentToolUseId') IS NOT NULL
      THEN '{"metadata":{"parentToolUseId":1}}'
    WHEN json_type(${body}, '$.metadata.agentMessageIds') = 'array'
      AND json_array_length(${body}, '$.metadata.agentMessageIds') > 0
      THEN json_set(${main}, '$.metadata.agentMessageIds', json_extract(${body}, '$.metadata.agentMessageIds'))
    ELSE ${main} END END`;
};

/**
 * The attribution Usage reads, projected from each message into `usage_metadata` by triggers that
 * cover every writer, close, reopen and fork copies included; Usage never parses transcripts on a
 * request. Only the agent, the model (even an oversized one, so admission refuses rather than
 * truncating a label) and the native ids are kept; unrelated metadata and all parts stay in the
 * message. Updating `usage_metadata` rewrites the whole row, so the update trigger skips a write
 * whose projection hasn't changed: a streaming reply's attribution rarely does.
 */
export const usageSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["messages", "closed_messages"] as const) {
    yield* sql.unsafe(`CREATE TRIGGER ${table}_usage_insert AFTER INSERT ON ${table} BEGIN
      UPDATE ${table} SET usage_metadata = ${projection("new")} WHERE rowid = new.rowid;
    END`);
    yield* sql.unsafe(`CREATE TRIGGER ${table}_usage_update AFTER UPDATE OF message, role ON ${table}
      WHEN new.usage_metadata IS NOT (${projection("new")}) BEGIN
        UPDATE ${table} SET usage_metadata = ${projection("new")} WHERE rowid = new.rowid;
      END`);
  }
});
