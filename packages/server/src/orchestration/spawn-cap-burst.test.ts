import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Orchestration } from "./service.ts";
import {
  GIT_HEAVY,
  makeWorld,
  openOrchestrator,
  waitReal,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

describe.skipIf(!hasGit)("the worker cap under a burst of spawns", () => {
  // Each call is judged against the cap before the spawn lock, so a burst all reads the same count:
  // the cap is counted again under the lock, and a call no card stood behind starts no worker past it.
  it.effect(
    "starts no more workers than the cap without a card, however many calls arrive at once",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const registry = yield* AppToolRegistry;
          const orchestration = yield* Orchestration;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          yield* orchestration.setCharter(workspaceId, {
            ...DEFAULT_CHARTER,
            maxConcurrentWorkers: 2,
          });
          const spawnTool = registry
            .forTransport(thread.id, "orchestrator")
            .find((tool) => tool.descriptor.name === "spawn_worker")!;
          const burst = yield* Effect.all(
            ["one", "two", "three", "four"].map((feature) =>
              spawnTool
                .run({ project: "shop", feature, title: feature, brief: `Do ${feature}.` })
                .pipe(Effect.result),
            ),
            { concurrency: "unbounded" },
          ).pipe(Effect.forkScoped);
          // A call that did get a card is declined: only the uncarded ones count here.
          const carded = new Set<string>();
          const results = yield* waitReal(
            "every call of the burst to end",
            Effect.gen(function* () {
              for (const request of yield* store.listRequests(thread.id)) {
                if (carded.has(request.id)) continue;
                carded.add(request.id);
                yield* runtimes.respond(thread.id, request.id, {
                  kind: "approval",
                  decision: "deny",
                  scope: "once",
                });
              }
              return yield* Fiber.await(burst).pipe(
                Effect.timeoutOption(0),
                Effect.map((exit) => (exit._tag === "Some" ? exit.value : undefined)),
              );
            }),
          );
          expect(results._tag).toBe("Success");
          const started =
            results._tag === "Success"
              ? results.value.filter((each) => each._tag === "Success").length
              : 0;
          expect(started).toBeLessThanOrEqual(2);
          expect((yield* orchestration.ledger(workspaceId)).budget.liveWorkers).toBeLessThanOrEqual(
            2,
          );
          const workers = (yield* store.listThreads).filter(
            (each) => each.spawnedBy?.threadId === (thread.id as ThreadId),
          );
          expect(workers.length).toBeLessThanOrEqual(2);
        }),
      ),
    GIT_HEAVY,
  );

  // A yes is for one past the count its card showed: two cards answered yes at the same count let
  // one worker through, and the other finds the count grown under the lock.
  it.effect(
    "lets a carded spawn through only while the count is still the one its card showed",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const registry = yield* AppToolRegistry;
          const orchestration = yield* Orchestration;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          yield* orchestration.setCharter(workspaceId, {
            ...DEFAULT_CHARTER,
            maxConcurrentWorkers: 1,
          });
          const spawnTool = registry
            .forTransport(thread.id, "orchestrator")
            .find((tool) => tool.descriptor.name === "spawn_worker")!;
          const call = (feature: string) =>
            spawnTool.run({ project: "shop", feature, title: feature, brief: `Do ${feature}.` });
          yield* call("first");
          const second = yield* call("second").pipe(Effect.result, Effect.forkScoped);
          const third = yield* call("third").pipe(Effect.result, Effect.forkScoped);
          const cards = yield* waitReal(
            "both cards",
            store.listRequests(thread.id).pipe(Effect.map((all) => all.length === 2 && all)),
          );
          for (const card of cards)
            yield* runtimes.respond(thread.id, card.id, {
              kind: "approval",
              decision: "allow",
              scope: "once",
            });
          const results = [yield* Fiber.join(second), yield* Fiber.join(third)];
          expect(results.filter((each) => each._tag === "Success")).toHaveLength(1);
          expect((yield* orchestration.ledger(workspaceId)).budget.liveWorkers).toBe(2);
        }),
      ),
    GIT_HEAVY,
  );
});
