import {
  AppToolError,
  type Checkout,
  hostOf,
  type Thread,
  type ThreadId,
  type WorkerPlacement,
} from "@gram/contracts";
import * as Effect from "effect/Effect";

/**
 * The placement decision as the service calls it (`worker-admission.ts`): `confirm` as a worker's
 * folder is made on a machine, `adopting` as a thread is taken on as a worker.
 */
export interface WorkerAdmissionHook {
  readonly confirm: (
    caller: ThreadId,
    hostId: string | undefined,
    given: WorkerPlacement | undefined,
  ) => Effect.Effect<WorkerPlacement | undefined, AppToolError>;
  readonly adopting: (
    thread: Thread,
    holder: ThreadId,
    target: Checkout,
  ) => Effect.Effect<WorkerPlacement | undefined, string>;
}

/**
 * A thread's `spawnedBy` once `holder` takes it on: the placement it keeps says which workers'
 * machine it is still on, and the seat it holds there.
 */
export const joinedBy = (
  threadId: ThreadId,
  feature: string,
  placement: WorkerPlacement | undefined,
) => ({ threadId, feature, ...(placement === undefined ? {} : { placement }) });

const NOT_DECIDED =
  "is a machine for an orchestrator's workers, and nothing here decides who may be placed on one, so no worker is.";

/**
 * Where the service finds the placement decision. It is installed once the tools that plan a
 * worker's machine are made (`setWorkerAdmission`). Until then, and on a server that makes none,
 * a workers' machine takes no worker at all: with nothing to decide, the answer is no.
 */
export const makeWorkerAdmitting = (
  joinedMachines: () => ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly onDemand?: string | undefined;
  }>,
) => {
  let installed: WorkerAdmissionHook | undefined;
  const workers = (hostId: string | undefined) =>
    hostId === undefined
      ? undefined
      : joinedMachines().find((each) => each.id === hostId && each.onDemand === "worker");
  return {
    set: (hook: WorkerAdmissionHook) =>
      Effect.sync(() => {
        installed = hook;
      }),
    confirm: ((caller, hostId, given) => {
      if (installed !== undefined) return installed.confirm(caller, hostId, given);
      const machine = workers(hostId);
      return machine === undefined
        ? Effect.succeed(given)
        : Effect.fail(
            new AppToolError({ tool: "spawn_worker", message: `${machine.name} ${NOT_DECIDED}` }),
          );
    }) satisfies WorkerAdmissionHook["confirm"],
    adopting: ((thread, holder, target) => {
      if (installed !== undefined) return installed.adopting(thread, holder, target);
      const machine = workers(hostOf(target));
      return machine === undefined
        ? Effect.succeed(undefined)
        : Effect.fail(`${machine.name} ${NOT_DECIDED}`);
    }) satisfies WorkerAdmissionHook["adopting"],
  };
};
export type WorkerAdmitting = ReturnType<typeof makeWorkerAdmitting>;
