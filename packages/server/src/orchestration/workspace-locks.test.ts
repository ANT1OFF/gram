// The orchestration locks are per workspace: a slow call in one workspace doesn't hold up another,
// and two calls in one workspace still run one after the other.
import { describe, expect, it } from "@effect/vitest";
import type { WorkspaceId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { Orchestration } from "./service.ts";
import { underKeysOf } from "./service/kit.ts";
import {
  makeWorld,
  openOrchestrator,
  openProject,
  openOrchestratorAcross,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

/** A pause in real time: the server's fibers wait on real git processes, not the test clock. */
const realPause = (ms: number) =>
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** `effect`, which must finish within five seconds of real time rather than wait on another workspace. */
const unheld = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.raceFirst(
    effect,
    realPause(5_000).pipe(Effect.andThen(Effect.die("held up by another workspace's lock"))),
  );

/** Holds `hold(gate)` in a fiber until `release` succeeds, once it has started. */
const holding = <E, R>(hold: (body: Effect.Effect<void>) => Effect.Effect<unknown, E, R>) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fiber = yield* hold(
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    return { fiber, release: Deferred.succeed(release, undefined) };
  });

describe("workspace locks", () => {
  it.effect("a workspace held by a removal check holds up only itself", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const a = (yield* openOrchestrator(world)).workspaceId;
        const b = (yield* openOrchestratorAcross(world)).workspaceId;
        expect(a).not.toBe(b);
        const held = yield* holding((body) => orchestration.whileWorkspaceStays(a, body));

        // Another workspace goes ahead while `a` is held.
        expect(yield* unheld(orchestration.whileWorkspaceStays(b, Effect.succeed("b")))).toBe("b");

        // The same workspace waits for it.
        const ran = yield* Ref.make(false);
        const second = yield* orchestration
          .whileWorkspaceStays(a, Ref.set(ran, true))
          .pipe(Effect.forkScoped);
        yield* realPause(50);
        expect(yield* Ref.get(ran)).toBe(false);
        yield* held.release;
        yield* Fiber.join(held.fiber);
        yield* Fiber.join(second);
        expect(yield* Ref.get(ran)).toBe(true);
      }),
    ),
  );

  it.effect("a task starting in one workspace holds up only its own", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const a = (yield* openOrchestrator(world)).workspaceId;
        const b = (yield* openOrchestratorAcross(world)).workspaceId;
        const start = (workspaceId: WorkspaceId, run: Effect.Effect<unknown>) =>
          orchestration.withTaskStartup({ target: { workspaceId } }, undefined, () => run);
        const held = yield* holding((body) => start(a, body));

        expect(yield* unheld(start(b, Effect.succeed("b")))).toBe("b");

        const ran = yield* Ref.make(false);
        const second = yield* start(a, Ref.set(ran, true)).pipe(Effect.forkScoped);
        yield* realPause(50);
        expect(yield* Ref.get(ran)).toBe(false);
        yield* held.release;
        yield* Fiber.join(held.fiber);
        yield* Fiber.join(second);
        expect(yield* Ref.get(ran)).toBe(true);
      }),
    ),
  );

  it.effect("a task for a project with no workspace yet holds the workspace its run makes", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const project = yield* openProject(world);
        const startOn = (run: Effect.Effect<unknown>) =>
          orchestration.withTaskStartup(
            { target: { projectId: project.id } },
            undefined,
            () => run,
          );
        // The first task's run makes the project's workspace, as `open` does, and stays in it.
        const made = yield* Deferred.make<WorkspaceId>();
        const held = yield* holding((body) =>
          startOn(
            orchestration
              .saveWorkspace({
                name: project.name,
                projectIds: [project.id],
                homeProjectId: project.id,
              })
              .pipe(
                Effect.flatMap((state) => Deferred.succeed(made, state.workspace.id)),
                Effect.andThen(body),
                Effect.orDie,
              ),
          ),
        );
        const workspaceId = yield* Deferred.await(made);

        // A second task for the project, now found through its workspace, waits for the first.
        const ran = yield* Ref.make(false);
        const second = yield* startOn(Ref.set(ran, true)).pipe(Effect.forkScoped);
        yield* realPause(50);
        expect(yield* Ref.get(ran)).toBe(false);
        // So does a task named by the workspace.
        const third = yield* orchestration
          .withTaskStartup({ target: { workspaceId } }, undefined, () => Effect.void)
          .pipe(Effect.forkScoped);
        yield* realPause(50);
        expect(third.pollUnsafe()).toBeUndefined();

        yield* held.release;
        yield* Fiber.join(held.fiber);
        yield* Fiber.join(second);
        yield* Fiber.join(third);
        expect(yield* Ref.get(ran)).toBe(true);
      }),
    ),
  );
});

describe("underKeysOf", () => {
  it.effect("takes the keys again when they moved before it got them", () =>
    Effect.gen(function* () {
      const lock = makeKeyedLock<string>();
      const key = yield* Ref.make("a");
      const seen: Array<string> = [];
      const held = yield* holding((body) => lock.withLock("a", body));
      const call = yield* underKeysOf(
        lock,
        Ref.get(key).pipe(Effect.map((each) => [each])),
        Ref.get(key).pipe(Effect.map((each) => void seen.push(each))),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      // While it waits for "a", what it reads its key from moves to "b".
      yield* Ref.set(key, "b");
      yield* held.release;
      yield* Fiber.join(held.fiber);
      yield* Fiber.join(call);
      expect(seen).toEqual(["b"]);
      expect(lock.size()).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("takes several keys in sorted order, whatever order they are named in", () =>
    Effect.gen(function* () {
      const lock = makeKeyedLock<string>();
      const held = yield* holding((body) => lock.withLock("x", body));
      const ran = yield* Ref.make(false);
      // Named "y" first, it waits for "x" before taking "y".
      const both = yield* lock
        .withLocks(["y", "x", "y"], Ref.set(ran, true))
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(yield* lock.withLock("y", Effect.succeed("y is free"))).toBe("y is free");
      expect(yield* Ref.get(ran)).toBe(false);
      yield* held.release;
      yield* Fiber.join(held.fiber);
      yield* Fiber.join(both);
      expect(yield* Ref.get(ran)).toBe(true);
      expect(lock.size()).toBe(0);
    }).pipe(Effect.scoped),
  );
});
