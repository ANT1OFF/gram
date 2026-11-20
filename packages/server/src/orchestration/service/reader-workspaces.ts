import { NotFound, type ProjectId, type WorkspaceState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { currentReader, readerMayWorkspace } from "../../embedding/readable-by.ts";

/**
 * The one-project workspace of `projectId` among `states` that this fiber's reader may act on: a
 * call naming a project never reaches a workspace readable by someone else, who is answered as if
 * the project had none yet.
 */
export const projectWorkspaceOf = (
  states: ReadonlyArray<WorkspaceState>,
  projectId: ProjectId,
): Effect.Effect<WorkspaceState | undefined> =>
  Effect.map(currentReader, (reader) =>
    states.find(
      (row) =>
        row.workspace.projectIds.length === 1 &&
        row.workspace.projectIds[0] === projectId &&
        readerMayWorkspace(reader, row.workspace, "act"),
    ),
  );

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
