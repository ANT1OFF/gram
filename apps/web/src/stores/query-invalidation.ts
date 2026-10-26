import type { WorkspaceId } from "@gram/contracts";
import type { QueryClient } from "@tanstack/react-query";

import type { ApiServerEvent } from "@/api/types";

type StaleKeys = readonly (readonly string[])[];

/** Queries each server event makes stale; events that change no query cache are absent. */
const STALE_QUERIES: {
  readonly [T in ApiServerEvent["type"]]?:
    | StaleKeys
    | ((event: Extract<ApiServerEvent, { type: T }>) => StaleKeys);
} = {
  "profiles.changed": [["profiles"], ["models"], ["agents-available"]],
  "reviewRequests.changed": [["reviewRequests"]],
  "openPrs.changed": [["openPrs"]],
  "threadWakes.changed": [["threadWakes"]],
  // A repo the orchestrator was allowed to add may be a project nobody had opened, so no list has it.
  "workspaces.changed": [["workspaces"], ["projects"], ["automaticDreamStatus"]],
  // The user's own memory edits and answers come as this one. Ledgers are `invalidateLedgers`'.
  "orchestration.changed": ({ workspaceId }) => [
    ["workspaces"],
    ["automaticDreamStatus", workspaceId],
    ["memory", workspaceId],
    // A worker closed with its worktree moves from the ledger to the finished list.
    ["finishedWorkers", workspaceId],
  ],
  // The orchestrator's memory tools, `ask_user` and `close_question` among them: every list of
  // questions reads the one `["memory", id, "questions"]` query, so they all move together.
  "memory.changed": ({ workspaceId }) => [["memory", workspaceId]],
  // A thread of the workspace produced a file: the Files view's pages read it again.
  "outputs.changed": ({ workspaceId }) => [["outputs", workspaceId]],
  // An adoption or a restore replaces memory wholesale, so both go stale together.
  "dreams.changed": ({ workspaceId }) => [
    ["dreams", workspaceId],
    ["automaticDreamStatus", workspaceId],
    ["memory", workspaceId],
  ],
};

/**
 * Every workspace's ledger goes stale on `orchestration.changed`, but the changed workspace's own:
 * while its `watchLedger` stream is live, that stream rebuilds and sends it, and a refetch would have
 * the server build it a second time. The refetch is what a view has while the stream is down.
 */
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
  const stale = STALE_QUERIES[event.type] as
    | StaleKeys
    | ((event: ApiServerEvent) => StaleKeys)
    | undefined;
  for (const queryKey of typeof stale === "function" ? stale(event) : (stale ?? [])) {
    void queryClient.invalidateQueries({ queryKey });
  }
  if (event.type === "orchestration.changed") {
    invalidateLedgers(queryClient, event.workspaceId, ledgerLive);
  }
}
