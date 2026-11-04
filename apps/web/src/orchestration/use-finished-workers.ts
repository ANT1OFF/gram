import type { FinishedWorker, FinishedWorkersPage, WorkspaceId } from "@gram/contracts";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

import { useApi } from "@/api/context";

// The workers closed with their worktree, which the ledgers no longer have, a page at a time
// (`orchestrator.finishedWorkersPage`). Each workspace reads its first page; Done asks for the next
// only when its rows reach where the loaded ones stop, so the archive is read as far as someone
// scrolls and no further.

/** What is loaded of a workspace's finished workers. */
interface Loaded {
  readonly workers: readonly FinishedWorker[];
  /** Where the next page starts; absent once the archive has nothing older. */
  readonly next?: FinishedWorkersPage["next"];
  readonly pages: number;
}

// Under `finishedWorkers`, so `orchestration.changed` makes every page of the workspace stale.
const pagesKey = (id: WorkspaceId, pages: number) => ["finishedWorkers", id, "pages", pages];

export interface FinishedWorkerPages {
  /** Each workspace's finished workers as loaded so far, newest first; absent until read. */
  readonly finished: ReadonlyMap<WorkspaceId, readonly FinishedWorker[] | undefined>;
  /** For each workspace with older finished workers still to load, the time its next page starts. */
  readonly horizons: ReadonlyMap<WorkspaceId, number>;
  /** A page is loading for one of them. */
  readonly busy: boolean;
  /** Reads `id`'s next page, unless one is loading or there is none. */
  readonly loadMore: (id: WorkspaceId) => void;
}

/** Every workspace in `ids`'s finished workers, a page at a time. */
export function useFinishedWorkerPages(ids: readonly WorkspaceId[]): FinishedWorkerPages {
  const api = useApi();
  const client = useQueryClient();
  const [depth, setDepth] = useState<Readonly<Record<string, number>>>({});
  // What each workspace last had loaded. A deeper page is a new query, and `placeholderData` only
  // carries the previous one over when the same observer is reused, which `useQueries` doesn't
  // promise: without this the list dropped every older row while the next page loaded.
  const lastLoaded = useRef(new Map<WorkspaceId, Loaded>());
  // Stable while `ids` is, so the maps are new only when a page is: what reads them sits still.
  const combine = useCallback(
    (all: readonly { data?: Loaded | undefined; isPlaceholderData: boolean }[]) => {
      const kept = lastLoaded.current;
      const data = ids.map((id, i) => {
        const own = all[i]?.data;
        if (own !== undefined) kept.set(id, own);
        return own ?? kept.get(id);
      });
      return {
        finished: new Map<WorkspaceId, readonly FinishedWorker[] | undefined>(
          ids.map((id, i) => [id, data[i]?.workers]),
        ),
        horizons: new Map<WorkspaceId, number>(
          ids.flatMap((id, i) => {
            const next = data[i]?.next;
            return next === undefined ? [] : [[id, next.at] as const];
          }),
        ),
        loading: new Set(
          ids.filter(
            (_, i) =>
              all[i]?.isPlaceholderData === true ||
              (all[i]?.data === undefined && data[i] !== undefined),
          ),
        ),
      };
    },
    [ids],
  );
  const results = useQueries({
    queries: ids.map((id) => {
      const pages = depth[id] ?? 1;
      return {
        queryKey: pagesKey(id, pages),
        queryFn: async (): Promise<Loaded> => {
          // The pages before, while cached and current: only the new one to read.
          const before =
            pages > 1 ? client.getQueryState<Loaded>(pagesKey(id, pages - 1)) : undefined;
          let loaded: Loaded =
            before?.data !== undefined && !before.isInvalidated
              ? before.data
              : { workers: [], pages: 0 };
          while (loaded.pages < pages && (loaded.pages === 0 || loaded.next !== undefined)) {
            let page: FinishedWorkersPage;
            try {
              page = await api.finishedWorkersPage(id, loaded.next);
            } catch (error) {
              // The first page's failure is the query's; a later one's keeps what is loaded, and
              // stops there until the list is read again.
              if (loaded.pages === 0) throw error;
              return { workers: loaded.workers, pages: loaded.pages };
            }
            const seen = new Set(loaded.workers.map((worker) => worker.threadId));
            loaded = {
              workers: [
                ...loaded.workers,
                ...page.workers.filter((worker) => !seen.has(worker.threadId)),
              ],
              pages: loaded.pages + 1,
              ...(page.next === undefined ? {} : { next: page.next }),
            };
          }
          return loaded;
        },
        // What was loaded stays while the next page comes, so rows never blink out.
        placeholderData: (previous: Loaded | undefined) => previous,
        retry: false,
        staleTime: 30_000,
      };
    }),
    combine,
  });
  const { finished, horizons, loading } = results;
  const loadMore = useCallback(
    (id: WorkspaceId) => {
      if (loading.has(id) || !horizons.has(id)) return;
      setDepth((current) => ({ ...current, [id]: (current[id] ?? 1) + 1 }));
    },
    [loading, horizons],
  );
  return { finished, horizons, busy: loading.size > 0, loadMore };
}
