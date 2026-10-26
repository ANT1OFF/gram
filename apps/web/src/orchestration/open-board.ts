import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import { create } from "zustand";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { useLayoutStore } from "@/stores/layout";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";
import { useViewStore } from "@/views/view-store";

import { useWorkspaces } from "./use-orchestration";

// Where every "Open board" goes: the Board view over the workspace's orchestrator, which is what
// the window's workspace follows. `waiting` unfolds its Waiting on you band.

interface BoardBandState {
  /** Workspaces whose Waiting on you band is unfolded, in this window. */
  readonly open: Readonly<Record<string, boolean>>;
  setOpen(workspaceId: WorkspaceId, open: boolean): void;
}

export const useBoardBand = create<BoardBandState>()((set) => ({
  open: {},
  setOpen: (workspaceId, open) => set((s) => ({ open: { ...s.open, [workspaceId]: open } })),
}));

export interface OpenBoardOptions {
  /** Unfold Waiting on you as it opens. */
  readonly waiting?: boolean;
}

/**
 * Opens a workspace's Board: its orchestrator's thread under it, the view kept through that
 * navigation, and nothing else changed when the window is there already.
 */
export function useOpenBoard(): (workspaceId: WorkspaceId, options?: OpenBoardOptions) => void {
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
  return (workspaceId, { waiting = false } = {}) => {
    if (waiting) useBoardBand.getState().setOpen(workspaceId, true);
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
