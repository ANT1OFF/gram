import type { MessageId, ThreadId, ThreadSearchHit, ThreadSearchResult } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { SqlClient } from "../platform/unstable.ts";

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
    const sql = yield* SqlClient.SqlClient;
    const scope = threadId === undefined ? [] : [threadId];

    const messageRows = yield* sql.unsafe<HitRow>(
      `SELECT message_search.thread_id AS "threadId", message_search.message_id AS "messageId",
          CASE WHEN json_valid(threads.data) THEN json_extract(threads.data, '$.title') END
            AS "title",
          snippet(message_search, -1, char(1), char(2), '…', ${SNIPPET_TOKENS}) AS "marked"
        FROM message_search JOIN threads ON threads.id = message_search.thread_id
        WHERE message_search MATCH ?
          ${threadId === undefined ? "" : "AND message_search.thread_id = ?"}
        ORDER BY bm25(message_search, 0, 0, 1.0, 0.4)
        LIMIT ?`,
      [match, ...scope, limit + 1],
    );
    const titleRows = yield* sql.unsafe<HitRow>(
      `SELECT thread_id AS "threadId", title AS "title",
          snippet(thread_title_search, 1, char(1), char(2), '…', ${SNIPPET_TOKENS}) AS "marked"
        FROM thread_title_search
        WHERE thread_title_search MATCH ?
          ${threadId === undefined ? "" : "AND thread_id = ?"}
        ORDER BY bm25(thread_title_search)
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
