import { describe, expect, it } from "@effect/vitest";
import { captureLogs } from "@gram/agents/testing/logs";
import { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { guarded } from "./runtime-state.ts";

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
