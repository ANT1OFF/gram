import { HostId } from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { parseMachineStatus } from "./signed-in-calls.ts";
import { fenceRefusalOf, runOf } from "./signed-in-fences.ts";
import type { WorkerMachinePortShape } from "./signed-in-port.ts";
import type { ProvidedMachine } from "./worker-machines.ts";

/** How often each running hosted worker machine is asked whether its provider wants it moved. */
export const MOVE_LOOK_EVERY = Duration.minutes(1);

/**
 * How long after it is asked a move may still act there: the app's call and the server's own wait,
 * with some to spare. Later, it does nothing (`expired`), and the machine stays where it is.
 */
export const MOVE_ACTS_WITHIN_MS = 60_000;

/** What moving one machine reads and changes here. */
export interface MoveDeps {
  readonly port: Pick<WorkerMachinePortShape, "call">;
  readonly machines: () => ReadonlyArray<ProvidedMachine>;
  /**
   * Readies the machine to stop, forced (`prepareStop`): each thread's work there is kept, its idle
   * sessions put to rest, and the turns still running wait for the machine as a move once it goes.
   */
  readonly prepare: (id: HostId) => Effect.Effect<unknown, unknown>;
  /** Whether it is readied to stop and still there (`StopMarks.holding`): the move may go. */
  readonly readied: (id: HostId) => boolean;
  /** Takes the stop back (`cancelStop`): the machine takes work again where it is. */
  readonly takeBack: (id: HostId) => Effect.Effect<unknown, unknown>;
}

/** How one machine's move went, for the log and for tests. */
export type MoveOutcome =
  | "moved"
  | "not-asked"
  | "not-readied"
  | "refused"
  | "unanswered"
  | "already-done";

/**
 * One look at the running hosted worker machines: for each its machine provider asks to move
 * (`moveRequested` in `…/status`), this Gram readies it as for any stop, forced, so its threads'
 * work is kept, then asks the provider to move it (`…/move`, fenced to the run the status named).
 * The provider stops that run and starts the next on the same disk elsewhere; the turns the stop
 * cuts off wait for it, saying the machine is moving, and carry on once it is back. A move the
 * provider refuses takes the stop back, so the machine works on where it is; a run is moved, or
 * refused, once (`done`), and a move whose answer was lost is asked again at the next look.
 */
export const moveAskedMachines = (deps: MoveDeps, done: Set<string>, now = Date.now) =>
  Effect.forEach(
    deps.machines().filter(
      (machine) =>
        machine.via !== undefined &&
        machine.onDemand === "worker" &&
        machine.onlineSince !== undefined,
    ),
    (machine) =>
      moveOne(deps, machine, done, now).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("a worker machine its provider asked to move wasn't moved").pipe(
            Effect.annotateLogs({ machine: machine.name, reason: Cause.pretty(cause).slice(0, 300) }),
            Effect.as<MoveOutcome>("unanswered"),
          ),
        ),
      ),
  );

const moveOne = (
  deps: MoveDeps,
  machine: ProvidedMachine,
  done: Set<string>,
  now: () => number,
): Effect.Effect<MoveOutcome, unknown> =>
  Effect.gen(function* () {
    const via = machine.via!;
    const account = machine.viaAccount;
    const asked = yield* deps.port.call(via, "status", { name: machine.name }, { account });
    if (!asked.ok || asked.status !== 200) return "not-asked";
    if (parseMachineStatus(asked.body).moveRequested === undefined) return "not-asked";
    const run = runOf(asked.body);
    if (run === undefined) return "not-asked";
    const key = JSON.stringify([via, machine.name, run.sandboxId, run.generation]);
    if (done.has(key)) return "already-done";
    const id = HostId.make(machine.id);
    yield* Effect.logInfo("the machine provider asks to move a worker machine; readying it").pipe(
      Effect.annotateLogs({ machine: machine.name }),
    );
    yield* deps.prepare(id);
    if (!deps.readied(id)) {
      yield* Effect.logWarning("a worker machine to move wasn't readied to stop; not moved").pipe(
        Effect.annotateLogs({ machine: machine.name }),
      );
      return "not-readied";
    }
    const answered = yield* deps.port.call(
      via,
      "move",
      { name: machine.name, notAfter: now() + MOVE_ACTS_WITHIN_MS },
      { account, run },
    );
    if (!answered.ok || answered.status >= 500) return "unanswered";
    const said = answered.body as { moved?: unknown; code?: unknown } | null;
    if (answered.status < 300 && fenceRefusalOf(answered) === undefined && said?.moved === true) {
      done.add(key);
      yield* Effect.logInfo("a worker machine is being moved by its provider").pipe(
        Effect.annotateLogs({ machine: machine.name, generation: run.generation }),
      );
      return "moved";
    }
    done.add(key);
    yield* deps.takeBack(id).pipe(Effect.ignore);
    yield* Effect.logInfo("the machine provider didn't move a worker machine; it works on").pipe(
      Effect.annotateLogs({
        machine: machine.name,
        status: answered.status,
        ...(typeof said?.code === "string" ? { code: said.code.slice(0, 40) } : {}),
      }),
    );
    return "refused";
  });

/** Looks every `MOVE_LOOK_EVERY`, one look at a time, for as long as the scope lasts. */
export const startMovingAsked = (deps: MoveDeps) => {
  const done = new Set<string>();
  return moveAskedMachines(deps, done).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        while (done.size > 512) done.delete(done.values().next().value!);
      }),
    ),
    Effect.catchCause((cause) => Effect.logWarning("the worker machine move pass failed", cause)),
    Effect.repeat(Schedule.spaced(MOVE_LOOK_EVERY)),
    Effect.forkScoped,
  );
};
