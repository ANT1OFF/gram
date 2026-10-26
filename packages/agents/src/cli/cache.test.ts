import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import { resettableOnSuccess } from "./cache.ts";

describe("resettableOnSuccess", () => {
  it("shares an in-flight discovery and resets only after that read finishes", async () => {
    const outcomes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let runs = 0;
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const cached = yield* resettableOnSuccess(
            Effect.gen(function* () {
              const result = ++runs;
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return result;
            }),
          );
          const first = yield* Effect.forkScoped(cached.get);
          yield* Deferred.await(started);
          const second = yield* Effect.forkScoped(cached.get);
          const reset = yield* Effect.forkScoped(cached.reset);
          yield* Effect.yieldNow;
          expect(runs).toBe(1);
          yield* Deferred.succeed(release, undefined);
          const reads = [yield* Fiber.join(first), yield* Fiber.join(second)];
          yield* Fiber.join(reset);
          return [...reads, yield* cached.get];
        }),
      ),
    );
    expect(outcomes).toEqual([1, 1, 2]);
  });
  it("tries again after a failure, and keeps the first success", async () => {
    let runs = 0;
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const { get: prepare } = yield* resettableOnSuccess(
          Effect.suspend(() =>
            ++runs === 1 ? Effect.fail("claude-not-found") : Effect.succeed(runs),
          ),
        );
        return [
          yield* Effect.exit(prepare),
          yield* Effect.exit(prepare),
          yield* Effect.exit(prepare),
        ].map((exit) => (exit._tag === "Success" ? exit.value : "failed"));
      }),
    );
    expect(outcomes).toEqual(["failed", 2, 2]);
    expect(runs).toBe(2);
  });

  it("runs again after a reset, as for an executable an update replaced", async () => {
    let runs = 0;
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const cached = yield* resettableOnSuccess(Effect.sync(() => ++runs));
        const first = [yield* cached.get, yield* cached.get];
        yield* cached.reset;
        return [...first, yield* cached.get, yield* cached.get];
      }),
    );
    expect(outcomes).toEqual([1, 1, 2, 2]);
  });
});
