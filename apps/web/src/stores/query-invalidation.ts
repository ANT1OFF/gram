import { WorkspaceId } from "@gram/contracts";
import type { QueryClient } from "@tanstack/react-query";
import * as Schema from "effect/Schema";

import type { ApiServerEvent } from "@/api/types";

type StaleKeys = readonly (readonly string[])[];

type EventOf = { [T in ApiServerEvent["type"]]: Extract<ApiServerEvent, { type: T }> };

const STALE_QUERIES: {
  readonly [T in keyof EventOf]?: StaleKeys | ((event: EventOf[T]) => StaleKeys);
} = {
  "profiles.changed": [["profiles"], ["models"], ["agents-available"]],
  "reviewRequests.changed": [["reviewRequests"]],
  "openPrs.changed": [["openPrs"]],
  "threadWakes.changed": [["threadWakes"]],
  "machines.snapshot": [["machines.status"]],
  "workspaces.changed": [["workspaces"], ["projects"], ["automaticDreamStatus"]],
  "orchestration.changed": ({ workspaceId }) => [
    ["workspaces"],
    ["automaticDreamStatus", workspaceId],
    ["memory", workspaceId],
    ["finishedWorkers", workspaceId],
  ],
  "memory.changed": ({ workspaceId }) => [["memory", workspaceId]],
  "outputs.changed": ({ workspaceId }) => [["outputs", workspaceId]],
  "routines.changed": ({ workspaceId }) => [["routines", workspaceId]],
  "docs.changed": ({ workspaceId }) => [["docs", workspaceId]],
  "pages.changed": ({ workspaceId }) => [["pages", workspaceId]],
  "dreams.changed": ({ workspaceId }) => [
    ["dreams", workspaceId],
    ["automaticDreamStatus", workspaceId],
    ["memory", workspaceId],
  ],
};

const staleKeysOf = <T extends keyof EventOf>(
  event: EventOf[T] & { readonly type: T },
): StaleKeys => {
  const stale = STALE_QUERIES[event.type];
  return typeof stale === "function" ? stale(event) : (stale ?? []);
};

const isWorkspaceId = Schema.is(WorkspaceId);

const invalidateLedgers = (
  queryClient: QueryClient,
  workspaceId: WorkspaceId,
  ledgerLive: (workspaceId: WorkspaceId) => boolean,
) =>
  void queryClient.invalidateQueries({
    queryKey: ["orchestratorLedger"],
    predicate: (query) => query.queryKey[1] !== workspaceId || !ledgerLive(workspaceId),
  });

/**
 * Invalidates the queries `event` makes stale, so mounted views refetch. `ledgerLive` says which
 * workspaces' ledgers are streamed now; without it, none are.
 */
export function invalidateForEvent(
  queryClient: QueryClient,
  event: ApiServerEvent,
  ledgerLive: (workspaceId: WorkspaceId) => boolean = () => false,
): void {
  for (const queryKey of staleKeysOf(event)) {
    void queryClient.invalidateQueries({ queryKey });
  }
  if (event.type === "orchestration.changed") {
    invalidateLedgers(queryClient, event.workspaceId, ledgerLive);
  }
}

/**
 * Everything goes stale after the event feed resubscribes, since the events missed in the gap are
 * gone: but a live ledger stream, which resubscribes and sends its own snapshot.
 */
export function invalidateAfterResync(
  queryClient: QueryClient,
  ledgerLive: (workspaceId: WorkspaceId) => boolean = () => false,
): void {
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] !== "orchestratorLedger" ||
      !(isWorkspaceId(query.queryKey[1]) && ledgerLive(query.queryKey[1])),
  });
}
