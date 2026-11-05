import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { useLayoutStore } from "@/stores/layout";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { useViewStore } from "@/views/view-store";

import { useWorkspaces } from "./use-orchestration";

// Where every "Open board" goes: the Board view over the workspace's orchestrator, which is what
// the window's workspace follows.

/**
 * Opens a workspace's Board: its orchestrator's thread under it, the view kept through that
 * navigation, and nothing else changed when the window is there already.
 */
export function useOpenBoard(): (workspaceId: WorkspaceId) => void {
  const api = useApi();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const show = (threadId: ThreadId) => {
    const view = useViewStore.getState();
    view.setQuiet(false);
    const pathname = `/t/${threadId}`;
    if (window.location.pathname === pathname) return view.setView("board");
    view.carryView(pathname);
    useLayoutStore.getState().openThread(threadId);
    void navigate({ to: "/t/$threadId", params: { threadId } }).then(() =>
      useViewStore.getState().setView("board"),
    );
  };
  return (workspaceId) => {
    const state = workspaces.find((each) => each.workspace.id === workspaceId);
    const threadId = state?.workspace.orchestratorThreadId;
    if (threadId !== undefined) return show(threadId);
    api
      .openOrchestrator({ workspaceId })
      .then((thread) => show(thread.id))
      .catch((error: unknown) =>
        useThreadDialogs.getState().fail(`Couldn't open the board: ${errorMessage(error)}`),
      );
  };
}
