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
 * still only its reader's, and so are its folders and its workspace. A kept entry counts only
 * for a thread with no live or closed row, whose row says who reads it now.
 */
export const notePrivateThreads = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    for (const row of yield* sql<{ id: string; data: string }>`
      SELECT id, data FROM threads WHERE json_extract(data, '$.readableBy') IS NOT NULL
      UNION ALL
      SELECT thread_id AS id, data FROM closed_threads
        WHERE json_extract(data, '$.readableBy') IS NOT NULL
      UNION ALL
      SELECT thread_id AS id, data FROM private_readers
        WHERE thread_id NOT IN (SELECT id FROM threads)
          AND thread_id NOT IN (SELECT thread_id FROM closed_threads)`.pipe(Effect.orDie)) {
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

/** The fields of a thread that say which machines it ran on, as `mayReachThread` reads them. */
const MACHINE_FIELDS = [
  "checkout",
  "currentCheckout",
  "extraCheckouts",
  "dreamHost",
  "awaitingMachine",
] as const;

/**
 * Keeps where `threadId` ran when it is its workspace's orchestrator and its row is about to
 * leave `threads`: the machines a later edit of the workspace must still be reachable on, once
 * no orchestrator is open (`holderMachinesIn`). Run in the transaction that removes the row.
 */
export const rememberHolderIn = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ workspace_id: string; data: string }>`
      SELECT w.id AS workspace_id, t.data FROM workspaces w JOIN threads t
        ON t.id = w.orchestrator_thread_id WHERE w.orchestrator_thread_id = ${threadId}`;
    for (const row of rows) {
      let stored: unknown;
      try {
        stored = JSON.parse(row.data);
      } catch {
        stored = undefined;
      }
      const thread = typeof stored === "object" && stored !== null ? stored : {};
      const kept = Object.fromEntries(
        MACHINE_FIELDS.flatMap((key) => {
          const value = (thread as Record<string, unknown>)[key];
          return value === undefined || value === null ? [] : [[key, value]];
        }),
      );
      yield* sql`INSERT OR REPLACE INTO workspace_holders (workspace_id, data)
        VALUES (${row.workspace_id}, ${JSON.stringify(kept)})`;
    }
  });

/** What `holderMachinesIn` answers. */
export type ClosedHolder = Pick<Thread, (typeof MACHINE_FIELDS)[number]> | "unreadable" | undefined;

/**
 * Where `workspaceId`'s last orchestrator ran, as `rememberHolderIn` kept it: `undefined` when
 * none was kept, `"unreadable"` when the kept record can't be read, which a caller must refuse.
 */
export const holderMachinesIn = (sql: SqlClient.SqlClient, workspaceId: string) =>
  Effect.map(
    sql<{ data: string }>`SELECT data FROM workspace_holders WHERE workspace_id = ${workspaceId}`,
    (rows): ClosedHolder => {
      if (rows[0] === undefined) return undefined;
      try {
        const kept: unknown = JSON.parse(rows[0].data);
        const checkout = (kept as Partial<Thread> | null)?.checkout;
        if (typeof checkout?.path !== "string") return "unreadable";
        return kept as Pick<Thread, (typeof MACHINE_FIELDS)[number]>;
      } catch {
        return "unreadable";
      }
    },
  );
