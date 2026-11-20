import type { Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { notePrivacy, noteReaders } from "../embedding/readable-by.ts";
import type { SqlClient } from "../platform/unstable.ts";

/**
 * What `private_readers` keeps of a stored thread's JSON: who may read it and where it worked,
 * as `notePrivacy` reads them; undefined for a thread anyone may read.
 */
const privateFieldsOf = (data: string): string | undefined => {
  let stored: unknown;
  try {
    stored = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof stored !== "object" || stored === null) return undefined;
  const thread = stored as Record<string, unknown>;
  if (typeof thread["readableBy"] !== "string") return undefined;
  const kept: Record<string, unknown> = {};
  for (const key of [
    "readableBy",
    "readers",
    "workspaceId",
    "checkout",
    "currentCheckout",
    "extraCheckouts",
  ]) {
    if (thread[key] !== undefined && thread[key] !== null) kept[key] = thread[key];
  }
  return JSON.stringify(kept);
};

/**
 * Keeps who could read each private thread of `ids` in `table` before its row leaves the store,
 * with its workspace and folders: what it left behind (an archived transcript, its workspace's
 * memory) stays that person's after a restart. Run in the transaction that removes the row; a
 * kept entry is never removed.
 */
export const rememberPrivateIn = (
  sql: SqlClient.SqlClient,
  table: "threads" | "closed_threads",
  ids: ReadonlyArray<string>,
) =>
  Effect.forEach(ids, (id) =>
    Effect.gen(function* () {
      const rows =
        table === "threads"
          ? yield* sql<{ data: string }>`SELECT data FROM threads WHERE id = ${id}`
          : yield* sql<{ data: string }>`SELECT data FROM closed_threads WHERE thread_id = ${id}`;
      const kept = rows[0] === undefined ? undefined : privateFieldsOf(rows[0].data);
      if (kept === undefined) return;
      yield* sql`INSERT OR REPLACE INTO private_readers (thread_id, data) VALUES (${id}, ${kept})`;
    }),
  );

/**
 * Whose each thread is, open, closed or gone, and where it works, noted before anything asks
 * (`embedding/readable-by.ts`): a thread no read has touched yet since the server started is
 * still only its reader's, and so are its folders and its workspace.
 */
export const notePrivateThreads = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    for (const row of yield* sql<{ id: string; data: string }>`
      SELECT id, data FROM threads WHERE json_extract(data, '$.readableBy') IS NOT NULL
      UNION ALL
      SELECT thread_id AS id, data FROM closed_threads
        WHERE json_extract(data, '$.readableBy') IS NOT NULL
      UNION ALL
      SELECT thread_id AS id, data FROM private_readers`.pipe(Effect.orDie)) {
      const stored = JSON.parse(row.data) as Partial<Thread>;
      if (typeof stored.readableBy !== "string") continue;
      const noted = { ...stored, id: row.id as ThreadId, readableBy: stored.readableBy };
      notePrivacy(noted);
      noteReaders({
        ...noted,
        readers: Array.isArray(stored.readers)
          ? stored.readers.filter((each): each is string => typeof each === "string")
          : undefined,
      });
    }
  });
