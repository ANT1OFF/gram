import type { MessageId, ThreadId, ThreadSearchHit, ThreadSearchResult } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { readOffLoop } from "../persistence/read-worker.ts";
import type { SqlClient } from "../platform/unstable.ts";

const DEFAULT_SEARCH_LIMIT = 50;

/** What `snippet()` wraps matches in: control characters that can't occur in indexed text. */
const OPEN = "\u0001";
const CLOSE = "\u0002";
const SNIPPET_TOKENS = 16;

/**
 * An FTS5 query that matches every word of `input` literally (all must appear), with the last word
 * as a prefix so results follow typing. `undefined` when `input` holds nothing searchable.
 */
export const toMatchQuery = (input: string): string | undefined => {
  const terms = input
    .split(/\s+/)
    .map((term) => term.replace(/\p{Cc}/gu, ""))
    .filter((term) => /[\p{L}\p{N}]/u.test(term));
  if (terms.length === 0) return undefined;
  return terms
    .map((term, i) => `"${term.replaceAll('"', '""')}"${i === terms.length - 1 ? "*" : ""}`)
    .join(" ");
};

/** Strips the `snippet()` markers, returning the text and the marked ranges as UTF-16 offsets. */
export const parseSnippet = (
  marked: string,
): {
  readonly snippet: string;
  readonly highlights: ReadonlyArray<{ readonly start: number; readonly end: number }>;
} => {
  let snippet = "";
  const highlights: Array<{ start: number; end: number }> = [];
  let start: number | undefined;
  for (const ch of marked) {
    if (ch === OPEN) start = snippet.length;
    else if (ch === CLOSE) {
      if (start !== undefined) highlights.push({ start, end: snippet.length });
      start = undefined;
    } else snippet += ch === "\n" || ch === "\r" ? " " : ch;
  }
  return { snippet, highlights };
};

interface HitRow {
  readonly threadId: string;
  readonly messageId?: string | null;
  readonly title: string | null;
  readonly marked: string | null;
}

const toHit = (row: HitRow): ThreadSearchHit => {
  const { snippet, highlights } = parseSnippet(row.marked ?? "");
  return {
    threadId: row.threadId as ThreadId,
    ...(row.messageId == null ? {} : { messageId: row.messageId as MessageId }),
    title: row.title ?? "",
    snippet,
    ...(highlights.length === 0 ? {} : { highlights }),
  };
};

export interface SearchInput {
  readonly query: string;
  readonly threadId?: ThreadId | undefined;
  readonly limit?: number | undefined;
}

/**
 * Threads whose title matches but whose messages don't, then message hits ranked by bm25 (body
 * above tool names and inputs). The caller checks that a scoped thread exists.
 */
export const searchThreads = ({
  query,
  threadId,
  limit = DEFAULT_SEARCH_LIMIT,
}: SearchInput): Effect.Effect<ThreadSearchResult, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const match = toMatchQuery(query);
    if (match === undefined) return { hits: [], truncated: false };
    const scope = threadId === undefined ? [] : [threadId];
    const orderedRank = threadId === undefined;

    // On the read worker when there is one: a global search over a long history takes hundreds of
    // milliseconds, and the event loop would wait for it.
    // Global searches can consume FTS rank order and stop at LIMIT, using the same weights.
    // A small scope must filter first: thread_id is UNINDEXED, so global rank order does
    // unnecessary work before reaching that thread's matches. Keep its filter-then-sort plan.
    const messageRows = yield* readOffLoop<HitRow>(
      `SELECT message_search.thread_id AS "threadId", message_search.message_id AS "messageId",
          CASE WHEN json_valid(threads.data) THEN json_extract(threads.data, '$.title') END
            AS "title",
          snippet(message_search, -1, char(1), char(2), '…', ${SNIPPET_TOKENS}) AS "marked"
        FROM message_search JOIN threads ON threads.id = message_search.thread_id
        WHERE message_search MATCH ?
          ${orderedRank ? "AND message_search.rank MATCH 'bm25(0, 0, 1.0, 0.4)'" : ""}
          ${threadId === undefined ? "" : "AND message_search.thread_id = ?"}
        ORDER BY ${orderedRank ? "message_search.rank" : "bm25(message_search, 0, 0, 1.0, 0.4)"}
        LIMIT ?`,
      [match, ...scope, limit + 1],
    );
    const titleRows = yield* readOffLoop<HitRow>(
      `SELECT thread_id AS "threadId", title AS "title",
          snippet(thread_title_search, 1, char(1), char(2), '…', ${SNIPPET_TOKENS}) AS "marked"
        FROM thread_title_search
        WHERE thread_title_search MATCH ?
          ${orderedRank ? "AND thread_title_search.rank MATCH 'bm25()'" : ""}
          ${threadId === undefined ? "" : "AND thread_id = ?"}
        ORDER BY ${orderedRank ? "thread_title_search.rank" : "bm25(thread_title_search)"}
        LIMIT ?`,
      [match, ...scope, limit + 1],
    );

    const withMessageHits = new Set(messageRows.map((r) => r.threadId));
    const hits = [
      ...titleRows.filter((r) => !withMessageHits.has(r.threadId)).map(toHit),
      ...messageRows.map(toHit),
    ];
    return { hits: hits.slice(0, limit), truncated: hits.length > limit };
  }).pipe(Effect.orDie);

/** Cap on the words around a match that a transcript hit shows. */
const TRANSCRIPT_SNIPPET_TOKENS = 32;

/** One message of a workspace's conversations that matched, as `searchWorkspaceTranscripts` finds it. */
export interface TranscriptSearchHit {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly title: string;
  /** The thread's part in the workspace: its orchestrator, or a worker. */
  readonly part: "orchestrator" | "worker";
  /** The message's place in its thread, from 0. */
  readonly seq: number;
  readonly role: string;
  /** The match with the words around it; unscrubbed, so the caller redacts it. */
  readonly snippet: string;
  /** The whole message's text, when asked for; unscrubbed and uncut. */
  readonly text?: string | undefined;
}

export interface TranscriptSearchInput {
  readonly query: string;
  readonly workspaceId: string;
  readonly threadId?: ThreadId | undefined;
  /** Leave out the workspace's orchestrator thread: what only its workers said. */
  readonly workersOnly?: boolean | undefined;
  /** Each hit's whole message text as well. */
  readonly withText?: boolean | undefined;
  readonly limit?: number | undefined;
}

/**
 * The messages of one workspace's threads, its orchestrator and its workers, that match `query`,
 * ranked by bm25 with what was said above tool names and inputs. Dream threads are left out: they
 * are memory being written, not the work it records. A thread that left the workspace (detached,
 * or closed and so deleted) is left out with it. The caller scrubs what it returns.
 */
export const searchWorkspaceTranscripts = ({
  query,
  workspaceId,
  threadId,
  workersOnly = false,
  withText = false,
  limit = 10,
}: TranscriptSearchInput): Effect.Effect<
  { readonly hits: ReadonlyArray<TranscriptSearchHit>; readonly truncated: boolean },
  never,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const match = toMatchQuery(query);
    if (match === undefined) return { hits: [], truncated: false };
    // A workspace is a small share of all threads: filter to it first, then rank, as a scoped
    // `searchThreads` does, rather than walk global rank order past every other workspace's hits.
    const rows = yield* readOffLoop<{
      readonly threadId: string;
      readonly messageId: string;
      readonly title: string | null;
      readonly role: string | null;
      readonly seq: number;
      readonly messageRole: string;
      readonly marked: string | null;
      readonly message: string | null;
    }>(
      `SELECT message_search.thread_id AS "threadId", message_search.message_id AS "messageId",
          json_extract(threads.data, '$.title') AS "title",
          json_extract(threads.data, '$.role') AS "role",
          messages.seq AS "seq", messages.role AS "messageRole",
          snippet(message_search, -1, char(1), char(2), '…', ${TRANSCRIPT_SNIPPET_TOKENS}) AS "marked",
          ${withText ? "message_search.body" : "NULL"} AS "message"
        FROM message_search
          JOIN threads ON threads.id = message_search.thread_id
          JOIN messages ON messages.rowid = message_search.rowid
        WHERE message_search MATCH ?
          AND json_valid(threads.data)
          AND json_extract(threads.data, '$.workspaceId') = ?
          AND (json_extract(threads.data, '$.role') IS NULL
            ${workersOnly ? "" : "OR json_extract(threads.data, '$.role') = 'orchestrator'"})
          ${threadId === undefined ? "" : "AND message_search.thread_id = ?"}
        ORDER BY bm25(message_search, 0, 0, 1.0, 0.4)
        LIMIT ?`,
      [match, workspaceId, ...(threadId === undefined ? [] : [threadId]), limit + 1],
    );
    const hits = rows.slice(0, limit).map((row): TranscriptSearchHit => ({
      threadId: row.threadId as ThreadId,
      messageId: row.messageId as MessageId,
      title: row.title ?? "",
      part: row.role === "orchestrator" ? "orchestrator" : "worker",
      seq: row.seq,
      role: row.messageRole,
      snippet: parseSnippet(row.marked ?? "").snippet,
      ...(withText ? { text: row.message ?? "" } : {}),
    }));
    return { hits, truncated: rows.length > limit };
  }).pipe(Effect.orDie);
