import type { Project, Workspace, WorkspaceId } from "@gram/contracts";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import type { Api } from "@/api/types";
import { Button } from "@/components/ui/button";
import { prefillDraftProject } from "@/composer/draft-prefill";
import { AddRepository } from "@/new-thread/add-repository";
import {
  projectNameOf,
  withoutWorkspaceRepo,
  withWorkspaceRepo,
} from "@/settings/workspace-settings-model";
import { showUndo } from "@/stores/undo-toasts";
import { Dialog, DialogShell } from "@/thread/dialog-shell";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { useWorkspaces } from "./use-orchestration";

/** The folder a repo's siblings sit in, where a workspace's next repo is most likely to be. */
export const parentFolder = (root: string): string | undefined => {
  const cut = root.replace(/[\\/]+$/, "").search(/[\\/][^\\/]*$/);
  return cut > 0 ? root.slice(0, cut) : undefined;
};

const fail = (message: string) => useThreadDialogs.getState().fail(message);

/**
 * Adds a registered project to the workspace, once. The workspace is read again first: a clone
 * takes long enough for it to have changed since the dialog opened, and saving that older copy
 * would drop whatever joined meanwhile.
 */
async function addWorkspaceRepo(
  api: Pick<Api, "listWorkspaces" | "saveWorkspace">,
  queryClient: QueryClient,
  workspace: Workspace,
  project: Project,
): Promise<void> {
  const current =
    (await api.listWorkspaces()).find((state) => state.workspace.id === workspace.id)?.workspace ??
    workspace;
  await api.saveWorkspace(withWorkspaceRepo(current, project.id));
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["workspaces"] }),
    queryClient.invalidateQueries({ queryKey: ["projects"] }),
  ]);
}

/**
 * Takes a repository out of the workspace, saying so with Undo, which adds it back to the workspace
 * as it is then.
 */
export function removeWorkspaceRepo(
  api: Pick<Api, "listWorkspaces" | "saveWorkspace">,
  queryClient: QueryClient,
  workspace: Workspace,
  projectId: Workspace["projectIds"][number],
  project: Project | undefined,
): void {
  const result = withoutWorkspaceRepo(workspace, projectId);
  if ("error" in result) return fail(result.error);
  api
    .saveWorkspace(result.input)
    .then(() => queryClient.invalidateQueries({ queryKey: ["workspaces"] }))
    .then(() =>
      showUndo({
        key: `workspace:${workspace.id}`,
        title: `Removed ${project?.name ?? projectId} from ${workspace.name}`,
        undo: () =>
          project === undefined
            ? api
                .saveWorkspace(withWorkspaceRepo(workspace, projectId))
                .then(() => queryClient.invalidateQueries({ queryKey: ["workspaces"] }))
            : addWorkspaceRepo(api, queryClient, workspace, project),
      }),
    )
    .catch((error: unknown) => fail(`Couldn't remove the repository: ${errorMessage(error)}`));
}

/**
 * "Add repository…": a GitHub repository to clone or a folder, added to the workspace when there is
 * one, and otherwise opened on New thread.
 */
export function AddRepoDialog({
  workspaceId,
  onClose,
}: {
  workspaceId?: WorkspaceId | undefined;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const workspace =
    workspaceId === undefined
      ? undefined
      : workspaces.find((state) => state.workspace.id === workspaceId)?.workspace;
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const home = projects.find((project) => project.id === workspace?.homeProjectId)?.root;

  const added = async (project: Project) => {
    if (workspace !== undefined) {
      await addWorkspaceRepo(api, queryClient, workspace, project);
    } else {
      prefillDraftProject(project.root);
      void navigate({ to: "/new" });
    }
    onClose();
  };

  return (
    <DialogShell
      testId="add-repo-dialog"
      title={workspace === undefined ? "Add repository" : `Add a repository to ${workspace.name}`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {workspace !== undefined ? (
          <p className="text-xs text-muted-foreground">
            The orchestrator can then start workers there. In it now:{" "}
            {workspace.projectIds.map((id) => projectNameOf(projects, id)).join(", ")}.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Clone a repository from GitHub, or add one that is already on this computer. It opens on
            New thread.
          </p>
        )}
        <AddRepository
          defaultPath={home === undefined ? undefined : parentFolder(home)}
          disabled={workspaceId !== undefined && workspace === undefined}
          onAdded={added}
        />
        <div className="flex justify-end">
          <Dialog.Close render={<Button type="button" variant="ghost" size="sm" />}>
            Cancel
          </Dialog.Close>
        </div>
      </div>
    </DialogShell>
  );
}
