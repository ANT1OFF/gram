import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import {
  attestShutdown,
  failedEssential,
  isShutdownRequest,
  isUpdateShutdownRequest,
  SESSIONS_TIMEOUT_MS,
  shutdownDiagnostics,
  stopForShutdown,
  unattestedEssential,
  UPDATE_ESSENTIALS,
} from "./shutdown.ts";
import { ThreadRuntimes, type ThreadRuntimesShape } from "./thread-runtimes.ts";

// Only the shutdown service port is provided. No agent, database or provider process is started.
const service = (shutdown: Effect.Effect<void>, remaining: () => number) =>
  ({
    stopAccepting: Effect.void,
    openSessions: Effect.sync(remaining),
    working: Effect.succeed([]),
    shutdown,
  }) as unknown as ThreadRuntimesShape;

describe("update shutdown completion", () => {
  it.effect("attests only after session persistence and provided layer teardown finish", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      let remaining = 1;
      const exit = yield* stopForShutdown(() => {}).pipe(
        Effect.provideService(
          ThreadRuntimes,
          service(
            Effect.sync(() => {
              calls.push("sessions persisted");
              remaining = 0;
            }),
            () => remaining,
          ),
        ),
        Effect.provide(
          Layer.effectDiscard(
            Effect.addFinalizer(() =>
              Effect.sync(() => {
                calls.push("layers closed");
              }),
            ),
          ),
        ),
        Effect.exit,
      );
      expect(attestShutdown(exit, true, () => calls.push("attested"))).toBe(0);
      expect(shutdownDiagnostics(exit, true, true).result).toBe("complete");
      expect(calls).toEqual(["sessions persisted", "layers closed", "attested"]);
    }),
  );

  it.effect("does not attest when sessions time out while normal quit may finish", () =>
    Effect.gen(function* () {
      const fiber = yield* stopForShutdown(() => {}).pipe(
        Effect.provideService(
          ThreadRuntimes,
          service(Effect.never, () => 1),
        ),
        Effect.forkScoped,
      );
      yield* TestClock.adjust(SESSIONS_TIMEOUT_MS + 1);
      const exit = yield* Fiber.await(fiber);
      const posted: unknown[] = [];
      expect(attestShutdown(exit, true, (message) => posted.push(message))).toBe(0);
      expect(posted).toEqual([]);
      expect(shutdownDiagnostics(exit, false, true).result).toBe("incomplete");
    }),
  );

  it.effect("does not attest session or layer teardown failure", () =>
    Effect.gen(function* () {
      for (const layerFailure of [false, true]) {
        const exit = yield* stopForShutdown(() => {}).pipe(
          Effect.provideService(
            ThreadRuntimes,
            service(layerFailure ? Effect.void : Effect.die("fake persistence failure"), () => 0),
          ),
          Effect.provide(
            Layer.effectDiscard(
              Effect.addFinalizer(() =>
                layerFailure ? Effect.die("fake database teardown failure") : Effect.void,
              ),
            ),
          ),
          Effect.exit,
        );
        const posted: unknown[] = [];
        expect(attestShutdown(exit, true, (message) => posted.push(message))).toBe(1);
        expect(shutdownDiagnostics(exit, layerFailure ? true : undefined, true)).toEqual({
          phase: layerFailure ? "teardown" : "sessions",
          sessionsStopped: layerFailure,
          ownedChildrenOrderly: true,
          result: "failed",
          failure: { error: false, defect: true, interrupted: false },
        });
        expect(posted).toEqual([]);
      }
    }),
  );

  it("refuses successful sessions with forced owned-child cleanup", () => {
    const posted: unknown[] = [];
    expect(attestShutdown(Exit.succeed(true), false, (message) => posted.push(message))).toBe(0);
    expect(posted).toEqual([]);
    expect(shutdownDiagnostics(Exit.succeed(true), true, false).result).toBe("incomplete");
  });

  it("does not serialize arbitrary failure payloads into updater diagnostics", () => {
    const payload = {
      token: "synthetic-secret",
      path: "/private/user-state",
      transcript: "private-content",
    };
    for (const exit of [Exit.fail(payload), Exit.die(payload)]) {
      const diagnostic = shutdownDiagnostics(exit, true, true);
      expect(diagnostic.result).toBe("failed");
      expect(JSON.stringify(diagnostic)).not.toMatch(/synthetic-secret|private-content|user-state/);
      expect(
        attestShutdown(exit, true, () => {
          throw new Error("must not attest");
        }),
      ).toBe(1);
    }
    expect(shutdownDiagnostics(Exit.fail(payload), true, true).failure).toEqual({
      error: true,
      defect: false,
      interrupted: false,
    });
    expect(shutdownDiagnostics(Exit.interrupt(42), undefined, true).failure).toEqual({
      error: false,
      defect: false,
      interrupted: true,
    });
  });
});

describe("update essentials", () => {
  it("tells an update's request from a quit's", () => {
    expect(isUpdateShutdownRequest({ type: "shutdown", reason: "update" })).toBe(true);
    expect(isUpdateShutdownRequest({ type: "shutdown" })).toBe(false);
    expect(isUpdateShutdownRequest({ type: "shutdown", reason: "quit" })).toBe(false);
    expect(isUpdateShutdownRequest({ type: "boot", reason: "update" })).toBe(false);
    expect(isShutdownRequest({ type: "shutdown", reason: "update" })).toBe(true);
  });

  it("names the first failed essential and seals the database only after the others", async () => {
    const sealed: string[] = [];
    const database = (result: boolean | Error) => () => {
      sealed.push("database");
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    };
    expect(UPDATE_ESSENTIALS).toEqual(["sessions", "agents", "database"]);
    expect(
      await failedEssential({ sessions: false, agents: false, database: database(true) }),
    ).toBe("sessions");
    expect(await failedEssential({ sessions: true, agents: false, database: database(true) })).toBe(
      "agents",
    );
    expect(sealed).toEqual([]);
    expect(await failedEssential({ sessions: true, agents: true, database: database(false) })).toBe(
      "database",
    );
    expect(
      await failedEssential({
        sessions: true,
        agents: true,
        database: database(new Error("invented")),
      }),
    ).toBe("database");
    expect(
      await failedEssential({ sessions: true, agents: true, database: database(true) }),
    ).toBeUndefined();
    expect(sealed).toHaveLength(3);
  });

  it("names the essential a teardown that ended before the seal left unattested", () => {
    const stopped = Exit.succeed(true);
    // rc.14 at 09:38:57Z: sessions stopped, an owned agent's exit not orderly.
    expect(unattestedEssential(stopped, true, false)).toBe("agents");
    expect(unattestedEssential(Exit.succeed(false), false, false)).toBe("sessions");
    expect(unattestedEssential(stopped, undefined, true)).toBe("sessions");
    expect(unattestedEssential(stopped, true, true)).toBeUndefined();
    expect(unattestedEssential(Exit.fail("invented"), true, false)).toBeUndefined();
  });
});
