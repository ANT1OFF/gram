// A provisioned host keeps its work on SIGTERM before it ends: the program it serves stays up until
// then, and anything else (SIGINT, the program ending on its own) is as it was.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { type HeldSignal, holdingTerm, type Signals } from "./term-hold.ts";

/** Signals a test sends by hand. */
const handSignals = () => {
  let listener: ((signal: HeldSignal) => void) | undefined;
  const signals: Signals = (on) => {
    listener = on;
    return () => {
      listener = undefined;
    };
  };
  return { signals, send: (signal: HeldSignal) => listener?.(signal), listening: () => !!listener };
};

const until = (check: () => boolean) =>
  Effect.gen(function* () {
    while (!check()) yield* Effect.sleep("5 millis");
  });

describe("holding SIGTERM for a last keep", () => {
  it.live("keeps the program up through the keep on SIGTERM, then ends it", () =>
    Effect.gen(function* () {
      const { signals, send, listening } = handSignals();
      const order: Array<string> = [];
      const keepStarted = yield* Deferred.make<void>();
      const keepDone = yield* Deferred.make<void>();
      const program = Effect.never.pipe(
        Effect.onInterrupt(() => Effect.sync(() => order.push("program ended"))),
      );
      const held = yield* Effect.forkScoped(
        holdingTerm(
          program,
          () =>
            Deferred.succeed(keepStarted, undefined).pipe(
              Effect.andThen(Deferred.await(keepDone)),
              Effect.andThen(Effect.sync(() => order.push("kept"))),
            ),
          signals,
        ),
      );
      yield* until(listening);
      send("SIGTERM");
      yield* Deferred.await(keepStarted);
      yield* Effect.sleep("20 millis");
      expect(order).toEqual([]);
      yield* Deferred.succeed(keepDone, undefined);
      yield* Fiber.join(held);
      expect(order).toEqual(["kept", "program ended"]);
      expect(listening()).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("ends the program at once on SIGINT, with no keep", () =>
    Effect.gen(function* () {
      const { signals, send, listening } = handSignals();
      let kept = false;
      const held = yield* Effect.forkScoped(
        holdingTerm(
          Effect.never,
          () =>
            Effect.sync(() => {
              kept = true;
            }),
          signals,
        ),
      );
      yield* until(listening);
      send("SIGINT");
      yield* Fiber.join(held);
      expect(kept).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("answers as the program does when it ends on its own", () =>
    Effect.gen(function* () {
      const { signals, listening } = handSignals();
      expect(yield* holdingTerm(Effect.succeed(7), () => Effect.void, signals)).toBe(7);
      expect(listening()).toBe(false);
      const failed = yield* Effect.flip(
        holdingTerm(Effect.fail("broken" as const), () => Effect.void, signals),
      );
      expect(failed).toBe("broken");
    }),
  );
});
