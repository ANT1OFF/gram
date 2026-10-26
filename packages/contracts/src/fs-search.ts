import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";

/** `fs.search`: content search in a thread's checkout, git-ignored and binary files left out. */
export const FsSearchFields = {
  threadId: ThreadId,
  query: Schema.String,
  /** An extended regular expression; otherwise the query is matched literally. */
  regex: Schema.optionalKey(Schema.Boolean),
  caseSensitive: Schema.optionalKey(Schema.Boolean),
  /** Matches to skip, from a previous page's `nextOffset`. */
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Matches per page; the server clamps it. */
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
};

/** UTF-16 offsets into a match's `text`, end exclusive. */
export const FsSearchRange = Schema.Struct({ start: Schema.Int, end: Schema.Int });
export type FsSearchRange = typeof FsSearchRange.Type;

export const FsSearchMatch = Schema.Struct({
  /** Absolute, for `fs.file` and the editor. */
  path: Schema.String,
  /** Relative to the checkout, `/`-separated. */
  relativePath: Schema.String,
  /** 1-based. */
  line: Schema.Int,
  /** The matching line, cut to a window around the first match when it's long. */
  text: Schema.String,
  ranges: Schema.Array(FsSearchRange),
});
export type FsSearchMatch = typeof FsSearchMatch.Type;

/** Why a search stopped before listing every match; what it did list is still right. */
export const FsSearchLimit = Schema.Literals(["matches", "bytes", "time"]);
export type FsSearchLimit = typeof FsSearchLimit.Type;

export const FsSearchResult = Schema.Struct({
  /** Sorted by path, then line. */
  matches: Schema.Array(FsSearchMatch),
  /** Present when more matches follow; pass it as `offset`. */
  nextOffset: Schema.optionalKey(Schema.Int),
  limitedBy: Schema.optionalKey(FsSearchLimit),
});
export type FsSearchResult = typeof FsSearchResult.Type;

export interface FsSearchFlags {
  readonly regex?: boolean | undefined;
  readonly caseSensitive?: boolean | undefined;
}

/** A match line longer than this is cut to a window around its first match. */
export const SEARCH_SNIPPET_MAX = 240;
const MAX_RANGES = 20;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where `query` matches in `text`, for highlighting. A regex JavaScript can't compile highlights
 * nothing rather than failing: git's extended syntax isn't quite JavaScript's.
 */
export function searchRanges(text: string, query: string, flags: FsSearchFlags): FsSearchRange[] {
  let pattern: RegExp;
  try {
    pattern = new RegExp(
      flags.regex ? query : escapeRegExp(query),
      flags.caseSensitive ? "g" : "gi",
    );
  } catch {
    return [];
  }
  const ranges: FsSearchRange[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0] === "") break;
    ranges.push({ start: match.index, end: match.index + match[0].length });
    if (ranges.length === MAX_RANGES) break;
  }
  return ranges;
}

/** The line as a match's `text` and `ranges`: whole when short, else a window around the first match. */
export function searchSnippet(
  line: string,
  query: string,
  flags: FsSearchFlags,
): { readonly text: string; readonly ranges: FsSearchRange[] } {
  const ranges = searchRanges(line, query, flags);
  if (line.length <= SEARCH_SNIPPET_MAX) return { text: line, ranges };
  const first = ranges[0]?.start ?? 0;
  const start = Math.max(0, Math.min(first - 40, line.length - SEARCH_SNIPPET_MAX));
  const end = start + SEARCH_SNIPPET_MAX;
  return {
    text: line.slice(start, end),
    ranges: ranges
      .filter((range) => range.start >= start && range.end <= end)
      .map((range) => ({ start: range.start - start, end: range.end - start })),
  };
}
