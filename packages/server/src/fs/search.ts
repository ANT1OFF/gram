import {
  InvalidState,
  searchSnippet,
  type FsSearchFlags,
  type FsSearchLimit,
  type FsSearchMatch,
  type FsSearchResult,
} from "@gram/contracts";
import { git, ProcTimeout, repoTop, type Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { join } from "node:path";

export const SEARCH_PAGE = 200;
export const SEARCH_MAX_PAGE = 500;
/** Matches a search lists at most, across pages. */
const SEARCH_MAX_RESULTS = 2000;
const SEARCH_MAX_BYTES = 4 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 10_000;
const MAX_QUERY_LENGTH = 1000;

export interface SearchOptions extends FsSearchFlags {
  readonly offset: number;
  readonly limit: number;
  readonly maxBytes?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * `git grep` over the checkout: in a repo, tracked files plus untracked ones git doesn't ignore;
 * elsewhere every file (`--no-index`). `-I` skips binary files, `-z` keeps odd names parseable.
 */
const grepArgs = (query: string, flags: FsSearchFlags, inRepo: boolean): string[] => [
  "grep",
  inRepo ? "--untracked" : "--no-index",
  "-I",
  "-n",
  "-z",
  "--no-color",
  flags.regex ? "-E" : "-F",
  ...(flags.caseSensitive ? [] : ["-i"]),
  "-e",
  query,
  "--",
];

interface Hit {
  readonly relativePath: string;
  readonly line: number;
  readonly text: string;
}

/** `path\0line\0text` records, one per line. Output cut at the byte cap loses its partial last record. */
export const parseGrep = (stdout: string, truncated: boolean): Hit[] => {
  const records = stdout.split("\n");
  if (truncated) records.pop();
  return records.flatMap((record): Hit[] => {
    const first = record.indexOf("\0");
    const second = first === -1 ? -1 : record.indexOf("\0", first + 1);
    if (second === -1) return [];
    const line = Number(record.slice(first + 1, second));
    if (!Number.isInteger(line) || line < 1) return [];
    return [
      {
        relativePath: record.slice(0, first),
        line,
        text: record.slice(second + 1).replace(/\r$/, ""),
      },
    ];
  });
};

const byPathThenLine = (a: Hit, b: Hit) =>
  a.relativePath === b.relativePath ? a.line - b.line : a.relativePath < b.relativePath ? -1 : 1;

/** One page of content matches in `root`, sorted by path and line. */
export const searchFiles = (
  root: string,
  query: string,
  options: SearchOptions,
): Effect.Effect<FsSearchResult, InvalidState, Proc> =>
  Effect.gen(function* () {
    if (query.trim() === "") {
      return yield* new InvalidState({ message: "Enter something to search for" });
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return yield* new InvalidState({ message: "That search is too long" });
    }
    const inRepo = (yield* repoTop(root)) !== undefined;
    const out = yield* git(root, grepArgs(query, options, inRepo), {
      timeoutMs: options.timeoutMs ?? SEARCH_TIMEOUT_MS,
      maxOutputBytes: options.maxBytes ?? SEARCH_MAX_BYTES,
    }).pipe(Effect.result);
    if (Result.isFailure(out)) {
      if (out.failure instanceof ProcTimeout) return { matches: [], limitedBy: "time" };
      return yield* new InvalidState({ message: "Couldn't run git to search the files" });
    }
    const { status, stdout, stderr, truncated } = out.success;
    // 0: matches; 1: none; anything else is git refusing, e.g. a malformed regex.
    if (status > 1) {
      const detail = stderr.trim().replace(/^fatal:\s*/i, "") || "git grep failed";
      return yield* new InvalidState({
        message: options.regex
          ? `Invalid regular expression: ${detail}`
          : `Search failed: ${detail}`,
      });
    }

    const hits = parseGrep(stdout, truncated).toSorted(byPathThenLine);
    const listed = hits.slice(0, SEARCH_MAX_RESULTS);
    const end = Math.min(options.offset + options.limit, listed.length);
    const matches = listed.slice(options.offset, end).map((hit): FsSearchMatch => ({
      path: join(root, hit.relativePath),
      relativePath: hit.relativePath,
      line: hit.line,
      ...searchSnippet(hit.text, query, options),
    }));
    const limitedBy: FsSearchLimit | undefined = truncated
      ? "bytes"
      : hits.length > SEARCH_MAX_RESULTS
        ? "matches"
        : undefined;
    return {
      matches,
      ...(end < listed.length ? { nextOffset: end } : {}),
      ...(limitedBy === undefined ? {} : { limitedBy }),
    };
  });
