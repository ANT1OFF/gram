// Test helpers for routines, which live in a workspace's charter while their runs live in its
// outbox: a routine flattened back into one record (its charter entry and its run state), and the
// ways a test makes, changes, runs and stages one.
import {
  type ProjectId,
  type RoutineId,
  type RoutineSchedule,
  type RoutineState,
  type RoutineStatus,
  type WorkspaceId,
  type WorkspaceRoutine,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { Orchestration } from "../orchestration/service.ts";
import { waitReal } from "../orchestration/test-harness.ts";
import { Routines, routineHandlers } from "./routines.ts";

/** A routine as one record: its charter entry, its id and workspace, and how its runs stand. */
export type Flat = WorkspaceRoutine &
  RoutineState & {
    readonly id: RoutineId;
    readonly workspaceId: WorkspaceId;
    readonly enabled: boolean;
  };

/** Each routine's workspace, so a test can name a routine by its id alone, across a restart. */
const workspaces = new Map<string, WorkspaceId>();

const flat = (workspaceId: WorkspaceId, status: RoutineStatus): Flat => ({
  ...status.routine,
  ...status.state,
  id: status.id,
  workspaceId,
  enabled: status.routine.off !== true,
});

const workspaceOf = (id: string) => {
  const workspaceId = workspaces.get(id);
  if (workspaceId === undefined) throw new Error(`no routine ${id} made in this test`);
  return workspaceId;
};

/** The routine as its charter and outbox have it now. */
export const routineNow = (id: string) =>
  Effect.gen(function* () {
    const workspaceId = workspaceOf(id);
    const status = (yield* (yield* Routines).list(workspaceId)).find((each) => each.id === id);
    if (status === undefined) return yield* Effect.die(new Error(`routine ${id} is gone`));
    return flat(workspaceId, status);
  });

/** Waits until the routine has recorded a run at or after `after`, and returns it. */
export const ranAfter = (id: string, after: number) =>
  waitReal(
    `a run of routine ${id} after ${after}`,
    routineNow(id).pipe(
      Effect.map((routine) =>
        routine.lastRun !== undefined && routine.lastRun.at >= after ? routine : undefined,
      ),
    ),
  );

/** Changes the workspace's routines through the charter's write path, as Settings saves them. */
export const editRoutines = (
  workspaceId: WorkspaceId,
  edit: (routines: ReadonlyArray<WorkspaceRoutine>) => ReadonlyArray<WorkspaceRoutine>,
) =>
  Effect.gen(function* () {
    const orchestration = yield* Orchestration;
    return yield* orchestration.editCharter(workspaceId, (standing) => ({
      ...standing,
      routines: edit(standing.routines ?? []),
    }));
  });

/** Adds `routine` to the workspace's charter, as the user saves one, and returns it. */
export const addRoutine = (workspaceId: WorkspaceId, routine: WorkspaceRoutine) =>
  Effect.gen(function* () {
    const saved = yield* editRoutines(workspaceId, (routines) => [...routines, routine]);
    const id = saved.charter.routines?.find((each) => each.name === routine.name.trim())?.id;
    if (id === undefined) return yield* Effect.die(new Error(`${routine.name} wasn't saved`));
    workspaces.set(id, workspaceId);
    // The engine hears of the charter change and reckons its next run.
    return yield* waitReal(
      `routine ${routine.name} reckoned`,
      routineNow(id).pipe(Effect.map((each) => (each.nextRunAt === undefined ? undefined : each))),
    );
  });

/** A worker routine in `projectId`, as the user makes one in Settings. */
export const workerRoutine = (
  workspaceId: WorkspaceId,
  projectId: string,
  schedule: RoutineSchedule = { every: "hours", hours: 1 },
  name = "CI triage",
) =>
  addRoutine(workspaceId, {
    name,
    brief: "Look at main's failing jobs and open one PR per real failure.",
    project: projectId as ProjectId,
    schedule,
  });

/** Changes the routine's charter entry. */
export const editRoutine = (id: string, change: (routine: WorkspaceRoutine) => WorkspaceRoutine) =>
  editRoutines(workspaceOf(id), (routines) =>
    routines.map((routine) => (routine.id === id ? change(routine) : routine)),
  );

/** The user's Run now. */
export const runNow = (id: string) =>
  Effect.gen(function* () {
    const workspaceId = workspaceOf(id);
    const handlers = yield* routineHandlers;
    const status = yield* handlers["routine.run"]({ workspaceId, id: id as RoutineId });
    return flat(workspaceId, status);
  });

/** Writes the routine's run state as a crash would leave it in the outbox. */
export const stageState = (id: string, state: RoutineState) =>
  Effect.gen(function* () {
    const orchestration = yield* Orchestration;
    yield* orchestration.updateRoutineState(workspaceOf(id), id, () => state);
  });

/** The routine's run state as it stands, for a test to stage a crash from. */
export const stateOf = (routine: Flat): RoutineState => ({
  ...(routine.nextRunAt === undefined ? {} : { nextRunAt: routine.nextRunAt }),
  ...(routine.scheduleKey === undefined ? {} : { scheduleKey: routine.scheduleKey }),
  ...(routine.lastRun === undefined ? {} : { lastRun: routine.lastRun }),
  ...(routine.claim === undefined ? {} : { claim: routine.claim }),
  ...(routine.lastWorker === undefined ? {} : { lastWorker: routine.lastWorker }),
  ...(routine.lastHeld === undefined ? {} : { lastHeld: routine.lastHeld }),
  ...(routine.waiting === undefined ? {} : { waiting: routine.waiting }),
});
