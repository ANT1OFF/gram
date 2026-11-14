import { describe, expect, it } from "@effect/vitest";
import { captureLogs } from "@gram/agents/testing/logs";
import { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import { guarded, lockedAhead } from "./runtime-state.ts";

const threadId = ThreadId.make("invented-guarded-thread");

describe("guarded", () => {
  it.effect("logs another subsystem's failure as a warning, and keeps it from the caller", () => {
    const logs = captureLogs();
    return Effect.gen(function* () {
      yield* guarded(threadId, "runtime observer onTurnEnd", Effect.die(new Error("invented")));
      expect(logs.warnings()).toMatchObject([
        {
          message: "runtime observer onTurnEnd failed",
          annotations: { threadId, cause: expect.stringContaining("invented") },
        },
      ]);
    }).pipe(Effect.provide(logs.layer));
  });

  it.effect("warns of nothing when the callback is only interrupted, as at shutdown", () => {
    const logs = captureLogs();
    return Effect.gen(function* () {
      const running = yield* Effect.forkScoped(
        guarded(threadId, "runtime observer onTurnEnd", Effect.interrupt),
      );
      yield* Fiber.await(running);
      expect(logs.warnings()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(logs.layer));
  });
});

describe("lockedAhead", () => {
  it.effect("lets a fiber that releases the lock take it again before the waiter it woke", () =>
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      const order: Array<string> = [];
      const section = (name: string) =>
        lockedAhead(
          lock,
          Effect.sync(() => void order.push(name)),
        );
      let waiter: Fiber.Fiber<void> | undefined;
      yield* lockedAhead(
        lock,
        Effect.gen(function* () {
          waiter = yield* Effect.forkScoped(section("waiter"));
          // Let it reach the lock and queue on it.
          yield* Effect.yieldNow;
          order.push("first");
        }),
      );
      // Back to back, with no yield between: Effect 4.0.7's Semaphore runs the waiter here.
      yield* section("second");
      yield* Fiber.join(waiter!);
      expect(order).toEqual(["first", "second", "waiter"]);
    }).pipe(Effect.scoped),
  );

  it.effect("gives the lock back when a queued section is interrupted", () =>
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      const holder = yield* lockedAhead(lock, Effect.never).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      const queued = yield* lockedAhead(lock, Effect.void).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(queued);
      yield* Fiber.interrupt(holder);
      expect(yield* lock.takeIfAvailable(1)).toBe(true);
    }).pipe(Effect.scoped),
  );
});
