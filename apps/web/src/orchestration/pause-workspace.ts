import type { Workspace, WorkspaceState } from "@gram/contracts";
import type { QueryClient } from "@tanstack/react-query";

import type { Api } from "@/api/types";
import { showUndo } from "@/stores/undo-toasts";

/**
 * Pauses or resumes a workspace's orchestration from a menu, as the board's button does: a pause says
 * so with Undo; resuming needs no way back.
 */
export async function setWorkspacePaused(
  api: Pick<Api, "setOrchestratorPaused">,
  queryClient: QueryClient,
  workspace: Pick<Workspace, "id" | "name">,
  paused: boolean,
): Promise<void> {
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
      queryClient.invalidateQueries({ queryKey: ["orchestratorLedger", workspace.id] }),
    ]);
  await api.setOrchestratorPaused(workspace.id, paused);
  await refresh();
  if (paused) {
    showUndo({
      key: `workspace:${workspace.id}`,
      title: `Paused ${workspace.name}`,
      undo: () => api.setOrchestratorPaused(workspace.id, false).then(refresh),
    });
  }
}

/** Whether every workspace is paused, so Pause all reads Resume all; false with none. */
export const allWorkspacesPaused = (
  workspaces: readonly Pick<WorkspaceState, "paused">[],
): boolean => workspaces.length > 0 && workspaces.every((w) => w.paused !== undefined);

/**
 * Pause all (`paused`) or Resume all, from Quiet's menu or the menu bar: only the workspaces not
 * already so change.
 */
export async function setAllWorkspacesPaused(
  api: Pick<Api, "setOrchestratorPaused">,
  queryClient: QueryClient,
  workspaces: readonly Pick<WorkspaceState, "workspace" | "paused">[],
  paused: boolean,
): Promise<void> {
  await Promise.all(
    workspaces
      .filter((w) => (w.paused !== undefined) !== paused)
      .map((w) => api.setOrchestratorPaused(w.workspace.id, paused)),
  );
  await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
}
