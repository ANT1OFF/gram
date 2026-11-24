import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { WORKERS_PER_MACHINE_MAX } from "./worker-packing.ts";
import {
  AutomaticDreamThreshold,
  PauseAtLimitPct,
  WorkerPackingDefault,
  WorkersPerMachine,
} from "./workspaces.ts";

const SCALARS: Readonly<
  Record<
    string,
    { readonly schema: Schema.Top; readonly expected: string; readonly unset?: unknown }
  >
> = {
  "workspace.pauseAtLimitPct": {
    schema: PauseAtLimitPct,
    expected: "expected a whole percent from 1 to 100, or null for never",
  },
  "workspace.automaticDreamThreshold": {
    schema: AutomaticDreamThreshold,
    expected: "expected a whole number from 1 to 1000, or null for off",
  },
  "workspace.workerPacking": {
    schema: WorkerPackingDefault,
    expected: `expected one of ${WorkerPackingDefault.literals.join(", ")}, or null for orchestrator`,
    unset: "orchestrator",
  },
  "workspace.workersPerMachine": {
    schema: WorkersPerMachine,
    expected: `expected a whole number from 1 to ${WORKERS_PER_MACHINE_MAX}, or null for what the machine's provider allows`,
  },
};

/**
 * One of the charter keys `settings_propose` takes one number or one word for, decoded: the value
 * to store, `undefined` to clear the field (`null`, or the value that means the same), or what
 * was expected instead.
 */
export const decodeCharterScalar = (
  key: string,
  value: unknown,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly expected: string } => {
  const scalar = SCALARS[key];
  if (scalar === undefined) return { ok: false, expected: "isn't a setting" };
  if (value === null || (scalar.unset !== undefined && value === scalar.unset))
    return { ok: true, value: undefined };
  const decoded = Schema.decodeUnknownResult(scalar.schema as never, {
    onExcessProperty: "error",
  })(value);
  return Result.isFailure(decoded)
    ? { ok: false, expected: scalar.expected }
    : { ok: true, value: decoded.success };
};
