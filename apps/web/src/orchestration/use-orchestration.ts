import { WorkspaceId, type OrchestratorLedger, type WorkspaceState } from "@gram/contracts";
import {
  queryOptions,
  skipToken,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useApi } from "@/api/context";
import type { Api } from "@/api/types";
import { useSubscription } from "@/lib/effects";
import { useAttentionStore } from "@/sidebar/attention";

import { createLedgerWatch, type LedgerWatch } from "./ledger-watch";
import { createStageHolds } from "./stage-model";

const NO_WORKSPACES: readonly WorkspaceState[] = [];

/**
 * Every workspace. `settled` is false until the list is in, so a page can tell "no such workspace"
 * from "not yet".
 */
export function useWorkspacesQuery(): {
  readonly workspaces: readonly WorkspaceState[];
  readonly settled: boolean;
  readonly error: unknown;
} {
  const api = useApi();
  const { data, isPending, error } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.listWorkspaces(),
    retry: false,
  });
  return { workspaces: data ?? NO_WORKSPACES, settled: !isPending, error };
}

export const useWorkspaces = (): readonly WorkspaceState[] => useWorkspacesQuery().workspaces;

/**
 * Every ledger goes through this on its way into the cache, so one the server built before a stage
 * was set here can't put the old stage back.
 */
export const stageHolds = createStageHolds();

const ledgerQuery = (api: Api, workspaceId: WorkspaceId | undefined) =>
  queryOptions({
    queryKey: ["orchestratorLedger", workspaceId ?? ""] as const,
    queryFn:
      workspaceId === undefined
        ? skipToken
        : async () => {
            const ledger = stageHolds.settle(await api.orchestratorLedger(workspaceId));
            useAttentionStore.getState().setLedger(ledger);
            return ledger;
          },
    retry: false,
  });

const watches = new WeakMap<Api, LedgerWatch>();

const watchFor = (api: Api, queryClient: QueryClient): LedgerWatch => {
  let watch = watches.get(api);
  if (watch === undefined) {
    watch = createLedgerWatch({
      open: (workspaceId, signal) => api.watchLedger(workspaceId, signal),
      publish: (ledger) => {
        const settled = stageHolds.settle(ledger);
        useAttentionStore.getState().setLedger(settled);
        queryClient.setQueryData(["orchestratorLedger", ledger.workspaceId], settled);
      },
    });
    watches.set(api, watch);
  }
  return watch;
};

/** Whether `api`'s connection streams the workspace's ledger now, so a refetch would read it twice. */
export const ledgerStreamLive = (api: Api, workspaceId: WorkspaceId): boolean =>
  watches.get(api)?.isLive(workspaceId) === true;

const isWorkspaceId = Schema.is(WorkspaceId);

function useLedgerWatch(workspaceIds: readonly WorkspaceId[]) {
  const api = useApi();
  const queryClient = useQueryClient();
  const key = workspaceIds.join(" ");
  useSubscription(() => {
    const watch = watchFor(api, queryClient);
    const releases = key
      .split(" ")
      .filter(isWorkspaceId)
      .map((id) => watch.retain(id));
    return () => releases.forEach((release) => release());
  }, [api, queryClient, key]);
}

/** One workspace's ledger, kept live for as long as something shows it. */
export function useOrchestratorLedger(workspaceId: WorkspaceId | undefined) {
  const api = useApi();
  useLedgerWatch(useMemo(() => (workspaceId === undefined ? [] : [workspaceId]), [workspaceId]));
  return useQuery({
    ...ledgerQuery(api, workspaceId),
    enabled: workspaceId !== undefined,
  });
}

/** The ledgers of several workspaces by id, for the sidebar's feature states; missing until fetched. */
export function useOrchestratorLedgers(
  workspaceIds: readonly WorkspaceId[],
): ReadonlyMap<WorkspaceId, OrchestratorLedger> {
  const api = useApi();
  useLedgerWatch(workspaceIds);
  return useQueries({
    queries: workspaceIds.map((id) => ledgerQuery(api, id)),
    combine: (results) =>
      new Map(
        results.flatMap(({ data }) => (data === undefined ? [] : [[data.workspaceId, data]])),
      ),
  });
}
