import type { LabelId, ThreadId, WorkspaceId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { useHandoffStore } from "@/orchestration/use-board-actions";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { useThreadsStore } from "@/stores/threads";

import { requestRestart } from "./restart-session";
import { useThreadDialogs } from "./thread-dialogs-store";

/** Why a thread in a main checkout or outside git can't join a workspace. */
export const JOIN_NEEDS_WORKTREE =
  "Only a thread in a worktree of its own can be a workspace's worker";

export function useLabels() {
  const api = useApi();
  const { data = [] } = useQuery({ queryKey: ["labels"], queryFn: () => api.labels() });
  return data;
}

/** What the sidebar row menu, the pane menu and the palette can do to a thread. */
export function useThreadActions(threadId: ThreadId) {
  const api = useApi();
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const labels = useLabels();
  const workspaces = useWorkspaces();
  // The server matches the thread's checkouts to projects by resolved path, as the join does, so
  // the repos a target says it adds are the ones the click consents to.
  const { data: joinTargets = [] } = useQuery({
    queryKey: ["joinTargets", threadId, thread?.workspaceId, thread?.spawnedBy?.threadId],
    queryFn: () => api.threadJoinTargets(threadId),
    enabled: workspaces.length > 0 && thread !== undefined && thread.role === undefined,
    staleTime: 0,
  });
  const open = useThreadDialogs((s) => s.open);
  const fail = useThreadDialogs((s) => s.fail);

  const attempt = (what: string, run: () => Promise<void>) => {
    run().catch((error: unknown) => fail(`Couldn't ${what}: ${errorMessage(error)}`));
  };

  return {
    thread,
    labels,
    rename: () => open({ kind: "rename", threadId }),
    close: () => open({ kind: "close", threadId }),
    editLabels: () => open({ kind: "labels" }),
    togglePin: () => {
      if (!thread) return;
      attempt(thread.pinned ? "unpin the thread" : "pin the thread", () =>
        api.pin(threadId, !thread.pinned),
      );
    },
    togglePark: () => {
      if (!thread) return;
      attempt(thread.parked ? "unpark the thread" : "park the thread", () =>
        api.park(threadId, !thread.parked),
      );
    },
    /**
     * Marks a thread done, or reopens it: what the sidebar's Done line holds. A worker's finish is
     * its orchestrator's call and an orchestrator's work never ends, so `undefined` for both.
     */
    toggleDone:
      thread === undefined || thread.role !== undefined || thread.spawnedBy !== undefined
        ? undefined
        : () =>
            attempt(
              thread.completedAt === undefined ? "mark the thread done" : "reopen the thread",
              () => api.markCompleted(threadId, thread.completedAt === undefined),
            ),
    /**
     * Asks before replacing an orchestrator's agent session with a fresh one; `undefined` for a
     * thread that isn't the orchestrator of a workspace.
     */
    freshSession:
      thread?.role === "orchestrator" && thread.workspaceId !== undefined
        ? () => useHandoffStore.getState().confirm(thread.workspaceId)
        : undefined,
    /** Asks before removing the workspace an orchestrator runs; `undefined` for any other thread. */
    removeWorkspace:
      thread?.role === "orchestrator" && thread.workspaceId !== undefined
        ? () => open({ kind: "removeWorkspace", workspaceId: thread.workspaceId! })
        : undefined,
    /** Restarts the agent session so it reloads its config, asking first if that stops work. */
    restartSession: () => requestRestart(api, threadId),
    /** Makes a worker a plain thread again; its orchestrator stops seeing and steering it. */
    detach: () =>
      attempt(
        "remove the thread from its workspace",
        async () => void (await api.threadDetach(threadId)),
      ),
    /**
     * The workspaces the thread can join as a worker, or move to from the one it is a worker of:
     * each with an orchestrator open, and whether joining adds the thread's repo to it. Empty for
     * an orchestrator or a dream, and while workspaces are off.
     */
    joinTargets,
    /** Makes the thread a worker of the workspace's orchestrator, adding its repos if asked to. */
    join: (workspaceId: WorkspaceId, addRepos: boolean) =>
      attempt(
        thread?.spawnedBy === undefined ? "add the thread to the workspace" : "move the thread",
        async () =>
          void (await api.threadJoinWorkspace({
            threadId,
            workspaceId,
            ...(addRepos ? { addRepos } : {}),
          })),
      ),
    /** Hands a worker the user wrote to back to its orchestrator, saying nothing to the worker. */
    release: () => attempt("hand the worker back", () => api.releaseWorker(threadId)),
    /** Holds the worker for the user as a typed message would, sending it nothing. */
    takeOver: () => attempt("take the worker over", () => api.takeOverWorker(threadId)),
    setLabel: (labelId: LabelId | undefined) =>
      attempt("set the label", () => api.label(threadId, labelId ? [labelId] : [])),
  };
}
