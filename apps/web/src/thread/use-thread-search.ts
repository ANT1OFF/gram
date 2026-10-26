import type { ThreadId, ThreadSearchHit } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage, isNotImplemented } from "@/api/errors";

const SEARCH_DEBOUNCE_MS = 200;
/** Shorter queries don't search. */
const MIN_QUERY_LENGTH = 2;

export type ThreadSearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "unavailable" }
  | { status: "error"; message: string }
  | { status: "done"; hits: readonly ThreadSearchHit[]; truncated: boolean };

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Debounced `thread.search`, across threads or within `threadId`. */
export function useThreadSearch(
  query: string,
  { threadId, limit }: { threadId?: ThreadId | undefined; limit: number },
): ThreadSearchState {
  const api = useApi();
  const debounced = useDebounced(query.trim(), SEARCH_DEBOUNCE_MS);
  const enabled = debounced.length >= MIN_QUERY_LENGTH;
  const result = useQuery({
    queryKey: ["thread.search", debounced, threadId ?? null, limit],
    queryFn: () => api.searchThreads(debounced, { limit, ...(threadId ? { threadId } : {}) }),
    enabled,
    retry: false,
    staleTime: 5_000,
  });

  if (!enabled) return { status: "idle" };
  if (result.isPending) return { status: "searching" };
  if (result.isError) {
    return isNotImplemented(result.error)
      ? { status: "unavailable" }
      : { status: "error", message: errorMessage(result.error) };
  }
  return { status: "done", hits: result.data.hits, truncated: result.data.truncated };
}
