import { NotFound, type Project, type ProjectId, type WorkspaceState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import {
  currentReader,
  readerMayWorkspace,
  touchesUnreadable,
} from "../../embedding/readable-by.ts";

/**
 * The one-project workspace of `projectId` among `states`, for this fiber's reader. A project
 * whose workspace is someone else's, or whose folder is a private thread's (a profile's home), is
 * answered as no such project: a call naming it never reaches that workspace, nor makes another
 * over the same folder.
 */
export const projectWorkspaceOf = (
  states: ReadonlyArray<WorkspaceState>,
  projectId: ProjectId,
  projects: ReadonlyArray<Pick<Project, "id" | "root">>,
): Effect.Effect<WorkspaceState | undefined, NotFound> =>
  Effect.flatMap(currentReader, (reader) => {
    const own = states.filter(
      (row) => row.workspace.projectIds.length === 1 && row.workspace.projectIds[0] === projectId,
    );
    const root = projects.find((project) => project.id === projectId)?.root;
    const hidden =
      own.some((row) => !readerMayWorkspace(reader, row.workspace, "act")) ||
      (root !== undefined && touchesUnreadable(reader, [root], "act"));
    return hidden
      ? Effect.fail(new NotFound({ entity: "project", id: projectId }))
      : Effect.succeed(own[0]);
  });

/**
 * Refuses `state` unless this fiber's reader may act on it, with the answer a workspace that
 * doesn't exist gets: however a call named it, by id, by its project or through a tool.
 */
export const admitWorkspaceReader = (state: WorkspaceState): Effect.Effect<void, NotFound> =>
  Effect.flatMap(currentReader, (reader) =>
    readerMayWorkspace(reader, state.workspace, "act")
      ? Effect.void
      : Effect.fail(new NotFound({ entity: "workspace", id: state.workspace.id })),
  );
