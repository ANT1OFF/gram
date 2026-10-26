import type { FsSearchLimit, FsSearchMatch, FsSearchRange, ThreadId } from "@gram/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { SquareArrowOutUpRight } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/format";
import { useOpenInEditor, useOpensLocally } from "@/editor/use-open-in-editor";

import { filesProblem } from "./files-problem";
import type { FilesSearch } from "./files-store";

const MIN_SEARCH_LENGTH = 2;
const PAGE = 100;
const DEBOUNCE_MS = 250;

const LIMIT_TEXT: Record<FsSearchLimit, string> = {
  matches: "The search stopped at 2,000 results. Narrow it down to see the rest.",
  bytes: "The search stopped at its output limit. Narrow it down to see the rest.",
  time: "The search took too long and stopped. Narrow it down and try again.",
};

const count = (n: number, noun: string) => `${formatCount(n)} ${noun}${n === 1 ? "" : "s"}`;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** The status line: what the search found, announced as it changes. */
export function searchStatus(
  state: "idle" | "pending" | "error" | "done",
  matches: ReadonlyArray<FsSearchMatch>,
  more: boolean,
): string {
  if (state === "idle")
    return `Type at least ${MIN_SEARCH_LENGTH} characters to search file contents.`;
  if (state === "pending") return "Searching…";
  if (state === "error") return "The search didn't run.";
  if (matches.length === 0) return "No results";
  const files = new Set(matches.map((match) => match.relativePath)).size;
  return `${count(matches.length, "result")} in ${count(files, "file")}${more ? ", more to load" : ""}`;
}

/**
 * "Search in files": content matches in the checkout as a list of results. Arrow keys move between
 * results; Enter previews one at its line; Shift+Enter opens it in the editor.
 */
export function FilesSearchResults({
  threadId,
  search,
  onOpen,
  onExit,
}: {
  threadId: ThreadId;
  search: FilesSearch;
  onOpen: (match: FsSearchMatch) => void;
  /** Called on ArrowUp from the first result, to hand focus back to the search field. */
  onExit: () => void;
}) {
  const api = useApi();
  const debounced = useDebounced(search, DEBOUNCE_MS);
  const enabled = debounced.query.trim().length >= MIN_SEARCH_LENGTH;
  const results = useInfiniteQuery({
    queryKey: ["fs.search", threadId, debounced.query, debounced.regex, debounced.caseSensitive],
    queryFn: ({ pageParam }) =>
      api.fsSearch(threadId, debounced.query, {
        regex: debounced.regex,
        caseSensitive: debounced.caseSensitive,
        offset: pageParam,
        limit: PAGE,
      }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
    enabled,
    retry: false,
    staleTime: 10_000,
  });
  const matches = results.data?.pages.flatMap((page) => page.matches) ?? [];
  const last = results.data?.pages.at(-1);
  const state = !enabled
    ? "idle"
    : results.status === "pending"
      ? "pending"
      : results.status === "error"
        ? "error"
        : "done";

  return (
    <div data-testid="files-search" className="flex flex-col text-xs">
      <p role="status" aria-live="polite" className="px-2 py-1.5 text-muted-foreground">
        {searchStatus(state, matches, last?.nextOffset !== undefined)}
      </p>
      {results.status === "error" && (
        <p role="alert" className="px-2 pb-2 text-destructive">
          {filesProblem(results.error)}
        </p>
      )}
      {last?.limitedBy && <p className="px-2 pb-1.5 text-warning">{LIMIT_TEXT[last.limitedBy]}</p>}
      {enabled && matches.length > 0 && (
        <ResultList
          // A new search starts from its first result.
          key={JSON.stringify(debounced)}
          threadId={threadId}
          matches={matches}
          onOpen={onOpen}
          onExit={onExit}
        />
      )}
      {enabled && last?.nextOffset !== undefined && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="m-1 self-start"
          disabled={results.isFetchingNextPage}
          onClick={() => void results.fetchNextPage()}
        >
          {results.isFetchingNextPage ? "Loading…" : "Load more results"}
        </Button>
      )}
    </div>
  );
}

function ResultList({
  threadId,
  matches,
  onOpen,
  onExit,
}: {
  threadId: ThreadId;
  matches: ReadonlyArray<FsSearchMatch>;
  onOpen: (match: FsSearchMatch) => void;
  onExit: () => void;
}) {
  const openInEditor = useOpenInEditor();
  const local = useOpensLocally();
  const [active, setActive] = useState(0);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const focus = (index: number) => {
    const next = Math.max(0, Math.min(matches.length - 1, index));
    setActive(next);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (index: number, match: FsSearchMatch) => (event: KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focus(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (index === 0) onExit();
        else focus(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focus(0);
        break;
      case "End":
        event.preventDefault();
        focus(matches.length - 1);
        break;
      case "Enter":
        if (event.shiftKey && local) {
          event.preventDefault();
          void openInEditor(match.path, { threadId, line: match.line });
        }
        break;
    }
  };

  return (
    <ul aria-label="Search results" className="flex flex-col pb-1">
      {matches.map((match, index) => (
        <li key={`${match.relativePath}:${match.line}`} className="group flex items-start">
          <button
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            data-search-result={index}
            tabIndex={index === Math.min(active, matches.length - 1) ? 0 : -1}
            aria-label={`${match.relativePath}, line ${match.line}: ${match.text.trim()}`}
            {...(local ? { "aria-keyshortcuts": "Shift+Enter" } : {})}
            title={
              local
                ? "Enter previews the file at this line; Shift+Enter opens it in your editor"
                : "Enter previews the file at this line"
            }
            onFocus={() => setActive(index)}
            onClick={() => onOpen(match)}
            onKeyDown={onKeyDown(index, match)}
            className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm px-2 py-1 text-left outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="flex min-w-0 font-mono text-[11px] text-muted-foreground">
              <span className="truncate">{match.relativePath}</span>
              <span className="shrink-0">:{match.line}</span>
            </span>
            <span className="truncate font-mono">
              <Snippet text={match.text} ranges={match.ranges} />
            </span>
          </button>
          {local && (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              tabIndex={-1}
              aria-label={`Open ${match.relativePath} at line ${match.line} in editor`}
              title="Open in editor (Shift+Enter)"
              className="mt-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
              onClick={() => void openInEditor(match.path, { threadId, line: match.line })}
            >
              <SquareArrowOutUpRight />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A result's line with its matches marked; leading indentation is dropped. */
function Snippet({ text, ranges }: { text: string; ranges: ReadonlyArray<FsSearchRange> }) {
  const parts = [];
  let at = text.length - text.trimStart().length;
  for (const range of ranges) {
    const start = Math.max(range.start, at);
    if (start >= range.end) continue;
    if (start > at) parts.push(<span key={`t${at}`}>{text.slice(at, start)}</span>);
    parts.push(
      <mark key={`m${start}`} className="rounded-xs bg-primary/25 text-foreground">
        {text.slice(start, range.end)}
      </mark>,
    );
    at = range.end;
  }
  if (at < text.length) parts.push(<span key={`t${at}`}>{text.slice(at)}</span>);
  return <>{parts}</>;
}
