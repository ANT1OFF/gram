import type { WorkspaceState } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { CirclePause, CirclePlay, Palette, Settings2, Trash2 } from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import {
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { openWorkspaceSettings } from "@/settings/workspace-sheet";
import { DANGER, MoreContextMenuItem, SEPARATOR } from "@/thread/thread-action-items";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { setWorkspacePaused } from "./pause-workspace";
import {
  accentStyle,
  useWorkspaceAccent,
  useWorkspaceAccents,
  WORKSPACE_ACCENTS,
  type WorkspaceAccentId,
} from "./workspace-accent";

const NONE = "none";

/**
 * The workspace's colour, the user's own mark on it: one of a few hues, or none. One submenu, so
 * the menu stays short.
 */
function ColourMenuItems({ workspaceId }: { workspaceId: WorkspaceState["workspace"]["id"] }) {
  const accent = useWorkspaceAccent(workspaceId);
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger data-testid="menu-workspace-colour">
        <Palette aria-hidden className="size-icon-row" />
        Colour
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuRadioGroup
          value={accent ?? NONE}
          onValueChange={(value: string) =>
            useWorkspaceAccents
              .getState()
              .setAccent(workspaceId, value === NONE ? undefined : (value as WorkspaceAccentId))
          }
        >
          <ContextMenuRadioItem value={NONE} closeOnClick data-testid="menu-workspace-colour-none">
            <span aria-hidden className="size-2.5 rounded-full border border-border" />
            None
          </ContextMenuRadioItem>
          {WORKSPACE_ACCENTS.map((each) => (
            <ContextMenuRadioItem
              key={each.id}
              value={each.id}
              closeOnClick
              data-testid={`menu-workspace-colour-${each.id}`}
            >
              <span
                aria-hidden
                className="gram-accent-swatch size-2.5 rounded-full"
                style={accentStyle(each.id)}
              />
              {each.label}
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/**
 * A workspace line's context menu: its settings (its name among them), its colour, pause or resume, and remove,
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
        <Settings2 aria-hidden className="size-icon-row" />
        Workspace settings
      </ContextMenuItem>
      <ColourMenuItems workspaceId={workspace.id} />
      <ContextMenuItem data-testid="menu-workspace-pause" onClick={setPaused}>
        {pause ? (
          <CirclePause aria-hidden className="size-icon-row" />
        ) : (
          <CirclePlay aria-hidden className="size-icon-row" />
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
        <Trash2 aria-hidden className="size-icon-row" />
        Remove workspace…
      </ContextMenuItem>
      {SEPARATOR}
      <MoreContextMenuItem scope={{ kind: "workspace", workspaceId: workspace.id }} />
    </>
  );
}
