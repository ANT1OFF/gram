import type { RoutineId, RoutineStatus, WorkspaceId } from "@gram/contracts";

/**
 * `routine.*`: how a workspace's routines' runs stand, and the user's Run now. Routines themselves
 * live in the workspace's charter and change through `setOrchestratorCharter`.
 */
export interface RoutinesApi {
  /** The workspace's routines as its charter has them, by name, each with how its runs stand. */
  listRoutines(workspaceId: WorkspaceId): Promise<readonly RoutineStatus[]>;
  /**
   * Runs it now, off its schedule. Rejects with `InvalidState` while the workspace is paused or a
   * worker or held brief of its last run is still going.
   */
  runRoutine(workspaceId: WorkspaceId, id: RoutineId): Promise<RoutineStatus>;
}
