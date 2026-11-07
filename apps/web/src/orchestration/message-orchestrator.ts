import type { ThreadId, WorkspaceId } from "@gram/contracts";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { focusPaneComposer } from "@/shell/pane-focus";
import { useOpenThread } from "@/shell/thread-switcher";
import { useLayoutStore } from "@/stores/layout";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { useViewStore } from "@/views/view-store";

import { useWorkspaces } from "./use-orchestration";

/**
 * The action an empty Board, Docs or Workers tab offers: the workspace's orchestrator, in its chat,
 * with the composer focused to say what to do. Opens the orchestrator first when it isn't yet. Never
 * sends anything, and leaves a draft already typed as it is.
 */
export function useMessageOrchestrator(): (workspaceId: WorkspaceId) => void {
  const api = useApi();
  const openThread = useOpenThread();
  const workspaces = useWorkspaces();
  const show = (threadId: ThreadId) => {
    useViewStore.getState().setView("chat");
    openThread(threadId);
    focusPaneComposer(useLayoutStore.getState().grid.focused, { always: true });
  };
  return (workspaceId) => {
    const threadId = workspaces.find((each) => each.workspace.id === workspaceId)?.workspace
      .orchestratorThreadId;
    if (threadId !== undefined) return show(threadId);
    api
      .openOrchestrator({ workspaceId })
      .then((thread) => show(thread.id))
      .catch((error: unknown) =>
        useThreadDialogs.getState().fail(`Couldn't open the orchestrator: ${errorMessage(error)}`),
      );
  };
}
