import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

/**
 * How long a provisioned host waits on SIGTERM for its work to be kept before it ends: well inside
 * a pod's usual 60-second grace, leaving the rest for what its launcher does after it.
 */
export const GOING_WITHIN_MS = 35_000;

export type HeldSignal = "SIGTERM" | "SIGINT";

/** Calls `listener` on each signal until the returned function is called. */
export type Signals = (listener: (signal: HeldSignal) => void) => () => void;

const processSignals: Signals = (listener) => {
  const term = () => listener("SIGTERM");
  const int = () => listener("SIGINT");
  process.on("SIGTERM", term);
  process.on("SIGINT", int);
  return () => {
    process.off("SIGTERM", term);
    process.off("SIGINT", int);
  };
};

/**
 * Runs `program` until it ends, or until a signal: on SIGTERM, `beforeExit()` first when it gives
 * an effect (bounded by its own deadline), then `program` is interrupted; on SIGINT at once. The
 * runtime's own interrupt on the signal waits until then, as this runs uninterruptibly around
 * `program`.
 */
export const holdingTerm = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  beforeExit: () => Effect.Effect<void> | undefined,
  signals: Signals = processSignals,
): Effect.Effect<A | void, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.scoped(
      Effect.gen(function* () {
        const signalled = yield* Deferred.make<HeldSignal>();
        const off = signals((signal) => {
          Deferred.doneUnsafe(signalled, Exit.succeed(signal));
        });
        const fiber = yield* Effect.forkScoped(restore(program));
        const first = yield* Effect.raceFirst(
          Fiber.await(fiber).pipe(Effect.map((exit) => ({ exit }) as const)),
          Deferred.await(signalled).pipe(Effect.map((signal) => ({ signal }) as const)),
        );
        if ("exit" in first) {
          off();
          return yield* first.exit;
        }
        const before = first.signal === "SIGTERM" ? beforeExit() : undefined;
        if (before !== undefined) yield* before.pipe(Effect.catchCause(() => Effect.void));
        off();
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
