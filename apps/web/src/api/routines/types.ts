import type { Routine, RoutineDraft, RoutineId, RoutinePatch, WorkspaceId } from "@gram/contracts";

/** `routine.*`: a workspace's routines, saved briefs that run on a schedule. */
export interface RoutinesApi {
  /** The workspace's routines, by name. */
  listRoutines(workspaceId: WorkspaceId): Promise<readonly Routine[]>;
  /** Rejects with `InvalidState` for a project outside the workspace, a name taken or one too many. */
  createRoutine(workspaceId: WorkspaceId, draft: RoutineDraft): Promise<Routine>;
  /** Changes the fields given; turning one on reckons its next run from now. */
  updateRoutine(id: RoutineId, patch: RoutinePatch): Promise<Routine>;
  removeRoutine(id: RoutineId): Promise<void>;
  /**
   * Runs it now, off its schedule. Rejects with `InvalidState` while the workspace is paused or the
   * worker from its last run is still live.
   */
  runRoutine(id: RoutineId): Promise<Routine>;
}
