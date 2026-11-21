import {
  autonomyOf,
  readSettingsRows,
  workerModeText,
  type Project,
  type Settings,
  type Thread,
  type WorkspaceState,
} from "@gram/contracts";

/** One workspace as `workspace_list` shows it, with its orchestrator `holder` when one is open. */
export const workspaceListing = (
  state: WorkspaceState,
  projects: ReadonlyArray<Project>,
  settings: Settings,
  holder: Pick<Thread, "id" | "model"> | undefined,
) => {
  const { workspace, charter } = state;
  const own = workspace.projectIds.flatMap((id) => {
    const project = projects.find((each) => each.id === id);
    return project === undefined
      ? []
      : [{ id: project.id, name: project.name, root: project.root }];
  });
  return {
    id: workspace.id,
    name: workspace.name,
    projects: own,
    home: own.find((project) => project.id === workspace.homeProjectId),
    autonomy: autonomyOf(charter),
    workerMode: workerModeText(charter.workerMode),
    ...(holder === undefined ? {} : { orchestratorThreadId: holder.id }),
    ...(state.paused === undefined ? {} : { pausedReason: state.paused.reason }),
    settings: readSettingsRows(
      { settings, workspace: state, orchestrator: holder?.model },
      "workspace",
    ),
  };
};
