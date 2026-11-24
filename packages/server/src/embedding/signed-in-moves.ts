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

/**
 * How many looks one run's move is tried at without a final answer (no answer, the provider busy,
 * the machine not readied) before it is given up: the stop is taken back and the run left where
 * it is, so a request that can't be met never holds the machine's threads for long.
 */
export const MOVE_TRIES = 3;

/** How many machines are readied and moved at once: a slow keep holds up no other machine. */
export const MOVES_AT_ONCE = 4;

/** What a forced stop says it kept, as much as moving reads of it. */
export interface MovePrepared {
  readonly kept: ReadonlyArray<{ readonly pushed: boolean; readonly note?: string | undefined }>;
}

/** What moving one machine reads and changes here. */
export interface MoveDeps {
  readonly port: Pick<WorkerMachinePortShape, "call">;
  readonly machines: () => ReadonlyArray<ProvidedMachine>;
  /**
   * Readies the machine to stop, forced (`prepareStop`): each thread's work there is kept, its idle
   * sessions put to rest, and the turns still running wait for the machine as a move once it goes.
   */
  readonly prepare: (id: HostId) => Effect.Effect<MovePrepared, unknown>;
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
  | "busy"
  | "unanswered"
  | "given-up"
  | "already-done";

/** What a pass keeps between looks: the runs settled, and the tries of those that aren't. */
export interface MoveMemory {
  readonly done: Set<string>;
  readonly tries: Map<string, number>;
}

export const makeMoveMemory = (): MoveMemory => ({ done: new Set(), tries: new Map() });

/**
 * One look at the running hosted worker machines: for each its machine provider asks to move
 * (`moveRequested` in `…/status`), this Gram readies it as for any stop, forced, so its threads'
 * work is kept, then asks the provider to move it (`…/move`, fenced to the run the status named).
 * The provider stops that run and starts the next on the same disk elsewhere; the turns the stop
 * cuts off wait for it, saying the machine is moving, and carry on once it is back.
 *
 * A move the provider refuses takes the stop back, so the machine works on where it is, and the run
 * is settled (`done`). One it can't do now (a 5xx, a 429, a 404 that isn't the provider's own
 * answer) takes the stop back too, and is asked again at the next look. One whose answer was lost
 * keeps the stop, since the move may have gone through. Neither is tried past `MOVE_TRIES` looks:
 * the stop is then taken back for good, so a machine is never held off work for longer.
 */
export const moveAskedMachines = (deps: MoveDeps, memory: MoveMemory, now = Date.now) =>
  Effect.forEach(
    deps
      .machines()
      .filter(
        (machine) =>
          machine.via !== undefined &&
          machine.onDemand === "worker" &&
          machine.onlineSince !== undefined,
      ),
    (machine) =>
      moveOne(deps, machine, memory, now).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("a worker machine its provider asked to move wasn't moved").pipe(
            Effect.annotateLogs({
              machine: machine.name,
              reason: Cause.pretty(cause).slice(0, 300),
            }),
            Effect.as<MoveOutcome>("unanswered"),
          ),
        ),
      ),
    { concurrency: MOVES_AT_ONCE },
  );

const PROVIDER_ANSWER = new Set(["not_found", "not_movable", "superseded", "expired"]);

const providerCantMoveNow = (status: number, code: unknown) =>
  status >= 500 ||
  status === 429 ||
  (status === 404 && !(typeof code === "string" && PROVIDER_ANSWER.has(code)));

const moveOne = (
  deps: MoveDeps,
  machine: ProvidedMachine,
  memory: MoveMemory,
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
    if (memory.done.has(key)) return "already-done";
    const id = HostId.make(machine.id);
    const settle = (outcome: MoveOutcome) =>
      Effect.sync(() => {
        memory.done.add(key);
        memory.tries.delete(key);
        return outcome;
      });
    const tried = (memory.tries.get(key) ?? 0) + 1;
    if (tried > MOVE_TRIES) {
      yield* deps.takeBack(id).pipe(Effect.ignore);
      yield* Effect.logWarning("a worker machine to move was given up after its tries").pipe(
        Effect.annotateLogs({ machine: machine.name, tries: MOVE_TRIES }),
      );
      return yield* settle("given-up");
    }
    memory.tries.set(key, tried);
    yield* Effect.logInfo("the machine provider asks to move a worker machine; readying it").pipe(
      Effect.annotateLogs({ machine: machine.name, try: tried }),
    );
    const prepared = yield* deps.prepare(id).pipe(Effect.option);
    if (prepared._tag === "None" || !deps.readied(id)) {
      yield* Effect.logWarning("a worker machine to move wasn't readied to stop; not moved").pipe(
        Effect.annotateLogs({ machine: machine.name }),
      );
      return "not-readied";
    }
    const missed = prepared.value.kept.filter((work) => !work.pushed);
    if (missed.length > 0)
      yield* Effect.logWarning(
        "a worker machine to move was readied with some work not kept at its remote",
      ).pipe(
        Effect.annotateLogs({
          machine: machine.name,
          missed: missed.length,
          notes: missed.slice(0, 8).map((work) => work.note ?? ""),
        }),
      );
    const answered = yield* deps.port.call(
      via,
      "move",
      { name: machine.name, notAfter: now() + MOVE_ACTS_WITHIN_MS },
      { account, run },
    );
    if (!answered.ok) return "unanswered";
    const said = answered.body as { moved?: unknown; code?: unknown } | null;
    if (answered.status < 300 && fenceRefusalOf(answered) === undefined && said?.moved === true) {
      yield* Effect.logInfo("a worker machine is being moved by its provider").pipe(
        Effect.annotateLogs({ machine: machine.name, generation: run.generation }),
      );
      return yield* settle("moved");
    }
    yield* deps.takeBack(id).pipe(Effect.ignore);
    const later = providerCantMoveNow(answered.status, said?.code);
    yield* Effect.logInfo(
      later
        ? "the machine provider can't move a worker machine now; it works on, and is asked again"
        : "the machine provider didn't move a worker machine; it works on",
    ).pipe(
      Effect.annotateLogs({
        machine: machine.name,
        status: answered.status,
        ...(typeof said?.code === "string" ? { code: said.code.slice(0, 40) } : {}),
      }),
    );
    return later ? "busy" : yield* settle("refused");
  });

const REMEMBERED_MOST = 512;

/** Looks every `MOVE_LOOK_EVERY`, one look at a time, for as long as the scope lasts. */
export const startMovingAsked = (deps: MoveDeps) => {
  const memory = makeMoveMemory();
  return moveAskedMachines(deps, memory).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        while (memory.done.size > REMEMBERED_MOST)
          memory.done.delete(memory.done.values().next().value!);
        while (memory.tries.size > REMEMBERED_MOST)
          memory.tries.delete(memory.tries.keys().next().value!);
      }),
    ),
    Effect.catchCause((cause) => Effect.logWarning("the worker machine move pass failed", cause)),
    Effect.repeat(Schedule.spaced(MOVE_LOOK_EVERY)),
    Effect.forkScoped,
  );
};
