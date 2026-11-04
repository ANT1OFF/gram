import type { Thread, ThreadId, WorkspaceState } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";

import { readLast } from "@/orchestration/home";
import { useWorkspaces } from "@/orchestration/use-orchestration";
import { useThreadsStore } from "@/stores/threads";

import { useViewStore } from "./view-store";

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

/**
 * Whether the thread in view is a solo thread, outside every workspace. The window still has a
 * workspace for its Board (`viewWorkspace`), but where the thread is shown it is in none: the
 * header says Solo and no workspace's line is marked as the one the window is on.
 */
export const viewSolo = (thread: Pick<Thread, "workspaceId"> | undefined): boolean =>
  thread !== undefined && thread.workspaceId === undefined;

/**
 * `viewSolo` for the window's route, in Chat: Board and Quiet show a workspace whatever thread the
 * route has, so over them the window is on that workspace.
 */
export function useViewSolo(): boolean {
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined;
  const chat = useViewStore((s) => s.view === "chat");
  const solo = useThreadsStore((s) =>
    viewSolo(threadId === undefined ? undefined : s.byId[threadId]?.thread),
  );
  return chat && solo;
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
