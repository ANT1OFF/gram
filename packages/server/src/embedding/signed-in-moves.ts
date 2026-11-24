import { fieldsOf, HostId } from "@gram/contracts";
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

/**
 * What a pass keeps between looks: the runs settled, the tries of those that aren't, and what was
 * last said of each machine and of the pass, so a skip or a failure is logged once as it starts,
 * not at every look.
 */
export interface MoveMemory {
  readonly done: Set<string>;
  readonly tries: Map<string, number>;
  readonly said: Map<string, string>;
}

export const makeMoveMemory = (): MoveMemory => ({
  done: new Set(),
  tries: new Map(),
  said: new Map(),
});

const sayOnceChanged = (
  memory: MoveMemory,
  key: string,
  level: "info" | "warn",
  message: string,
  annotations: Readonly<Record<string, unknown>>,
) =>
  Effect.suspend(() => {
    const said = JSON.stringify([message, annotations]);
    if (memory.said.get(key) === said) return Effect.void;
    memory.said.delete(key);
    memory.said.set(key, said);
    return (level === "warn" ? Effect.logWarning : Effect.logInfo)(message).pipe(
      Effect.annotateLogs(annotations),
    );
  });

const PASS_KEY = "\0pass";

/**
 * One look at the running hosted worker machines: for each its machine provider asks to move
 * (`moveRequested` in `…/status`), this Gram readies it as for any stop, forced, so its threads'
 * work is kept, then asks the provider to move it (`…/move`, fenced to the run the status named).
 * The provider stops that run and starts the next on the same disk elsewhere; the turns the stop
 * cuts off wait for it, saying the machine is moving, and carry on once it is back.
 *
 * A move the provider refuses takes the stop back, so the machine works on where it is, and the run
 * is settled (`done`). One it can't do now (a 503, a 429, a 404 that isn't the provider's own
 * answer) takes the stop back too, and is asked again at the next look. One whose answer was lost
 * keeps the stop, since the move may have gone through; the app reports other 5xx answers and a
 * 401 as lost. Neither is tried past `MOVE_TRIES` looks:
 * the stop is then taken back for good, so a machine is never held off work for longer.
 *
 * The machines are read at each look, never once for all: a server starts before its hosted
 * machines dial in, and a look over the list it started with would never see one of them.
 */
export const moveAskedMachines = (deps: MoveDeps, memory: MoveMemory, now = Date.now) =>
  Effect.suspend(() => {
    const hosted = deps
      .machines()
      .filter((machine) => machine.via !== undefined && machine.onDemand === "worker");
    const online = hosted.filter((machine) => machine.onlineSince !== undefined);
    return sayOnceChanged(
      memory,
      PASS_KEY,
      "info",
      "hosted worker machines are looked at for their provider's asks to move them",
      { online: online.length, offline: hosted.length - online.length },
    ).pipe(
      Effect.andThen(
        Effect.forEach(
          online,
          (machine) =>
            moveOne(deps, machine, memory, now).pipe(
              Effect.catchCause((cause) =>
                sayOnceChanged(
                  memory,
                  machine.name,
                  "warn",
                  "a worker machine its provider asked to move wasn't moved",
                  { machine: machine.name, reason: Cause.pretty(cause).slice(0, 300) },
                ).pipe(Effect.as<MoveOutcome>("unanswered")),
              ),
            ),
          { concurrency: MOVES_AT_ONCE },
        ),
      ),
    );
  });

const PROVIDER_ANSWER = new Set(["not_found", "not_movable", "superseded", "expired"]);

const codeOf = (body: unknown): { code?: string } => {
  const code =
    typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === "string" ? { code: code.slice(0, 40) } : {};
};

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
    const skip = (level: "info" | "warn", message: string, why: Record<string, unknown> = {}) =>
      sayOnceChanged(memory, machine.name, level, message, { machine: machine.name, ...why }).pipe(
        Effect.as<MoveOutcome>("not-asked"),
      );
    if (!asked.ok)
      return yield* skip(
        "warn",
        "a worker machine's provider couldn't be asked whether to move it",
        {
          reason: asked.why.slice(0, 200),
        },
      );
    if (asked.status !== 200)
      return yield* skip("warn", "a worker machine's provider didn't say whether to move it", {
        status: asked.status,
        ...codeOf(asked.body),
      });
    if (parseMachineStatus(asked.body).moveRequested === undefined)
      return yield* skip("info", "a worker machine's provider doesn't ask to move it");
    const run = runOf(asked.body);
    if (run === undefined)
      return yield* skip(
        "warn",
        "a worker machine's provider asks to move it but names no run of it; not moved",
      );
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
    memory.said.delete(machine.name);
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
    const said = fieldsOf(answered.body);
    const code = said.get("code");
    if (
      answered.status < 300 &&
      fenceRefusalOf(answered) === undefined &&
      said.get("moved") === true
    ) {
      yield* Effect.logInfo("a worker machine is being moved by its provider").pipe(
        Effect.annotateLogs({ machine: machine.name, generation: run.generation }),
      );
      return yield* settle("moved");
    }
    yield* deps.takeBack(id).pipe(Effect.ignore);
    const later = providerCantMoveNow(answered.status, code);
    yield* Effect.logInfo(
      later
        ? "the machine provider can't move a worker machine now; it works on, and is asked again"
        : "the machine provider didn't move a worker machine; it works on",
    ).pipe(
      Effect.annotateLogs({
        machine: machine.name,
        status: answered.status,
        ...(typeof code === "string" ? { code: code.slice(0, 40) } : {}),
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
        while (memory.said.size > REMEMBERED_MOST)
          memory.said.delete(memory.said.keys().next().value!);
      }),
    ),
    Effect.catchCause((cause) =>
      sayOnceChanged(memory, PASS_KEY, "warn", "the worker machine move pass failed", {
        reason: Cause.pretty(cause).slice(0, 300),
      }),
    ),
    Effect.repeat(Schedule.spaced(MOVE_LOOK_EVERY)),
    Effect.forkScoped,
  );
};
