import * as Schema from "effect/Schema";

/**
 * How tightly a worker with a hosted machine is packed:
 *
 * - `own`: a machine started for it. Another worker is placed there only by naming it.
 * - `exclusive`: a machine started for it that is never shared, for work that reads what outsiders
 *   wrote.
 * - `shared`: one of its orchestrator's shared machines, with other workers up to the cap.
 * - `named`: a machine its orchestrator named, which another worker already had.
 */
export const WorkerPacking = Schema.Literals(["own", "exclusive", "shared", "named"]);
export type WorkerPacking = typeof WorkerPacking.Type;

/** The most workers a workspace may put on one machine, whatever its provider allows. */
export const WORKERS_PER_MACHINE_MAX = 8;
/** The cap on a machine whose provider says nothing of how many workers it is for. */
export const WORKERS_PER_MACHINE_DEFAULT = 4;
