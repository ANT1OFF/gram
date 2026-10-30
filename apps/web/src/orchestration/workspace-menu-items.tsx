import type { WorkspaceState } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { CirclePause, CirclePlay, Settings2, Trash2 } from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { openWorkspaceSettings } from "@/settings/workspace-sheet";
import { DANGER, MoreContextMenuItem, SEPARATOR } from "@/thread/thread-action-items";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { setWorkspacePaused } from "./pause-workspace";

/**
 * A workspace line's context menu: its settings (its name among them), pause or resume, and remove,
 * which asks first and says what goes and what stays. More… is the palette on the workspace.
 */
export function WorkspaceMenuItems({ state }: { state: WorkspaceState }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { workspace, paused } = state;
  const pause = paused === undefined;
  const setPaused = () =>
    void setWorkspacePaused(api, queryClient, workspace, pause).catch((error: unknown) =>
      useThreadDialogs
        .getState()
        .fail(`Couldn't ${pause ? "pause" : "resume"} the workspace: ${errorMessage(error)}`),
    );
  return (
    <>
      <ContextMenuItem
        data-testid="menu-workspace-settings"
        onClick={() => openWorkspaceSettings(workspace.id)}
      >
        <Settings2 aria-hidden className="size-3.5" />
        Workspace settings
      </ContextMenuItem>
      <ContextMenuItem data-testid="menu-workspace-pause" onClick={setPaused}>
        {pause ? (
          <CirclePause aria-hidden className="size-3.5" />
        ) : (
          <CirclePlay aria-hidden className="size-3.5" />
        )}
        {pause ? "Pause workspace" : "Resume workspace"}
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="menu-workspace-remove"
        className={DANGER}
        onClick={() =>
          useThreadDialogs.getState().open({ kind: "removeWorkspace", workspaceId: workspace.id })
        }
      >
        <Trash2 aria-hidden className="size-3.5" />
        Remove workspace…
      </ContextMenuItem>
      {SEPARATOR}
      <MoreContextMenuItem scope={{ kind: "workspace", workspaceId: workspace.id }} />
    </>
  );
}
