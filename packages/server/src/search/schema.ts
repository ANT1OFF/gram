import * as Effect from "effect/Effect";
import { SqlClient } from "../platform/unstable.ts";

/*
 * Full-text search over messages and thread titles. Triggers keep both indexes in step with every
 * write to `messages` and `threads` (persist, upsert, rewind truncation, rename, close), so no store
 * method has to remember them. Index rows share the source row's rowid; nothing in the app runs
 * VACUUM, which could renumber those.
 */

const TOKENIZE = "tokenize = 'unicode61 remove_diacritics 2'";

const parts = (message: string) =>
  `json_each(CASE WHEN json_valid(${message}) THEN ${message} ELSE '{}' END, '$.parts') p`;

/** Text and reasoning parts: what was said. */
const bodyOf = (message: string) => `(SELECT group_concat(json_extract(p.value, '$.text'), char(10))
  FROM ${parts(message)}
  WHERE json_extract(p.value, '$.type') IN ('text', 'reasoning'))`;

/** Tool names with their inputs, ranked below the body. */
const toolsOf = (message: string) => `(SELECT group_concat(
    CASE WHEN json_extract(p.value, '$.type') = 'dynamic-tool' THEN json_extract(p.value, '$.toolName')
      ELSE substr(json_extract(p.value, '$.type'), 6) END
      || ' ' || COALESCE(json_extract(p.value, '$.input'), ''),
    char(10))
  FROM ${parts(message)}
  WHERE json_extract(p.value, '$.type') LIKE 'tool-%' OR json_extract(p.value, '$.type') = 'dynamic-tool')`;

const titleOf = (data: string) =>
  `CASE WHEN json_valid(${data}) THEN json_extract(${data}, '$.title') END`;

const indexMessage = (row: "new") =>
  `INSERT INTO message_search (rowid, thread_id, message_id, body, tools)
    VALUES (${row}.rowid, ${row}.thread_id, ${row}.id, ${bodyOf(`${row}.message`)}, ${toolsOf(`${row}.message`)});`;

const indexTitle = (row: "new") =>
  `INSERT INTO thread_title_search (rowid, thread_id, title)
    VALUES (${row}.rowid, ${row}.id, ${titleOf(`${row}.data`)});`;

/**
 * The indexes and the triggers that keep them. A streaming reply is the exception: re-indexing it
 * on each save was about two thirds of a save's cost, since FTS5 deletes and re-tokenizes the whole
 * growing body every time. So the feed writer refreshes a streaming reply's index row at most every
 * few seconds and always when it settles; the saves in between store their feed revision in
 * `messages.search_pending`, and the update trigger skips a write that moved the mark. The index
 * then lags a streaming reply by those few seconds at most.
 *
 * Every other write indexes the row: one that clears the mark (a refresh, a settle, or the startup
 * sweep in `search/catch-up.ts`), and one that leaves it as it was. Revisions only grow, so a
 * skipped save always moves the mark, and a marked row is exactly one whose index is behind.
 */
export const searchSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const statements = [
    `CREATE VIRTUAL TABLE message_search USING fts5(
      thread_id UNINDEXED, message_id UNINDEXED, body, tools, ${TOKENIZE})`,
    `CREATE VIRTUAL TABLE thread_title_search USING fts5(thread_id UNINDEXED, title, ${TOKENIZE})`,
    // Holds only the marked rows: the few replies streaming now, or cut off by a crash.
    `CREATE INDEX messages_search_pending ON messages(search_pending)
      WHERE search_pending IS NOT NULL`,

    `CREATE TRIGGER messages_search_insert AFTER INSERT ON messages BEGIN ${indexMessage("new")} END`,
    `CREATE TRIGGER messages_search_update AFTER UPDATE OF message, search_pending ON messages
      WHEN new.search_pending IS NULL OR new.search_pending IS old.search_pending BEGIN
        DELETE FROM message_search WHERE rowid = old.rowid;
        ${indexMessage("new")}
      END`,
    `CREATE TRIGGER messages_search_delete AFTER DELETE ON messages BEGIN
      DELETE FROM message_search WHERE rowid = old.rowid;
    END`,

    `CREATE TRIGGER threads_search_insert AFTER INSERT ON threads BEGIN ${indexTitle("new")} END`,
    `CREATE TRIGGER threads_search_update AFTER UPDATE OF data ON threads BEGIN
      DELETE FROM thread_title_search WHERE rowid = old.rowid;
      ${indexTitle("new")}
    END`,
    `CREATE TRIGGER threads_search_delete AFTER DELETE ON threads BEGIN
      DELETE FROM thread_title_search WHERE rowid = old.rowid;
    END`,
  ];
  for (const statement of statements) yield* sql.unsafe(statement);
});
