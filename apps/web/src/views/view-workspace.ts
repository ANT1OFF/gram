import type { Thread, ThreadId, WorkspaceState } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";

import { readLast } from "@/orchestration/home";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { useThreadsStore } from "@/stores/threads";

/**
 * The workspace the window is on: the one of the thread in view, else the one whose orchestrator
 * was shown last, else the first. `undefined` without workspaces.
 */
export function viewWorkspace(
  thread: Pick<Thread, "workspaceId"> | undefined,
  workspaces: readonly WorkspaceState[],
  last: string | undefined,
): WorkspaceState | undefined {
  const find = (id: string | undefined) =>
    id === undefined ? undefined : workspaces.find((state) => state.workspace.id === id);
  return find(thread?.workspaceId) ?? find(last) ?? workspaces[0];
}

/** `viewWorkspace` for the window's route. The switcher and Board read this one. */
export function useViewWorkspace(): WorkspaceState | undefined {
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined;
  const thread = useThreadsStore((s) =>
    threadId === undefined ? undefined : s.byId[threadId]?.thread,
  );
  const workspaces = useWorkspaces();
  return viewWorkspace(thread, workspaces, readLast());
}
