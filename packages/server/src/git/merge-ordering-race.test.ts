// Regression for the final #627 review's lost-ordering finding: a dependency committed after the
// merge attempt's initial read but before it takes the per-thread lock (leaving the intent's
// `setAt` untouched) must still be carried into ordering. The characterization probe asserted the
// unsafe behavior at the reviewed head; here it asserts the fix — the dependency is checked and no
// merge launches. The control keeps a dependency declared before the read from launching too.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { hasGit } from "./test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import {
  atAutonomy,
  completeTurn,
  makeWorld,
  openOrchestrator,
  publishGit,
  settle,
  spawn,
  waitReal,
  withServer,
  type World,
} from "../orchestration/test-harness.ts";
import { armedWorkerBadge } from "../app-tools/pr-tools-kit.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";

/**
 * The line of the attempt's initial thread read: the first `store.getThread(` after the attempt
 * starts. It is found in the source so the stack filter follows the call, not a frozen number, and
 * only the call itself is matched so a rename or reshaping of the statement around it doesn't
 * break the test. The dependency must land right after this read and before the per-thread lock
 * the attempt then takes.
 */
const initialReadLine = (() => {
  const source = readFileSync(new URL("./merge-when-ready.ts", import.meta.url), "utf8");
  const start = source.search(/\battempt\s*=/);
  const at = start < 0 ? -1 : source.indexOf("store.getThread(", start);
  if (at < 0) throw new Error("merge-ordering-race: the attempt's initial read was not found");
  return source.slice(0, at).split("\n").length;
})();

const open99 = (world: World) =>
  world.prBadges.set("acme/app#99", {
    ...armedWorkerBadge(false),
    number: 99,
    url: "https://github.com/acme/app/pull/99",
  });

const viewed99 = (world: World) =>
  world.ghCalls.some((c) => c[2] === "view" && c[3] === "99" && c.includes("--jq"));

describe("merge_when_ready dependency ordering", () => {
  it.effect.skipIf(!hasGit)(
    "carries a dependency declared after the initial read but before the lock into ordering",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const registry = yield* AppToolRegistry;
            const { session, thread } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "dependent" });
            yield* completeTurn(worker.session);
            yield* atAutonomy(thread, "full");
            world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
            open99(world);
            const tools = registry.forTransport(worker.thread.id, "worker");
            yield* tools
              .find((t) => t.descriptor.name === "pr_bind")!
              .run({
                repo: "acme/app",
                number: 12,
              });
            const publish = (approved: boolean) =>
              store
                .getThread(worker.thread.id)
                .pipe(
                  Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
                );
            yield* publish(false);
            yield* tools.find((t) => t.descriptor.name === "merge_when_ready")!.run({});
            const original = store.getThread;
            let changed = false;
            // On the attempt's own initial read, commit an open dependency on acme/app#99 through the
            // orchestrator's real tool, then restore the method. Its `setAt` leaves the intent's
            // stamp untouched, the window the review found.
            store.getThread = ((id: Parameters<typeof original>[0]) => {
              const inInitialRead = new Error().stack?.includes(
                `merge-when-ready.ts:${initialReadLine}:`,
              );
              if (id !== worker.thread.id || changed || !inInitialRead) return original(id);
              return original(id).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    changed = true;
                    yield* registry
                      .forTransport(thread.id, "orchestrator")
                      .find((t) => t.descriptor.name === "depends_on")!
                      .run({ threadId: worker.thread.id, pr: "acme/app#99" });
                  }),
                ),
              );
            }) as typeof original;
            yield* Effect.gen(function* () {
              yield* publish(true);
              yield* waitReal(
                "dependency declared",
                Effect.sync(() => changed || undefined),
              );
              yield* waitReal(
                "dependency checked",
                Effect.sync(() => viewed99(world) || undefined),
              );
              yield* settle;
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toHaveLength(0);
              expect((yield* store.getThread(worker.thread.id)).boundPr?.dependsOn).toContainEqual(
                expect.objectContaining({ number: 99, setBy: "orchestrator" }),
              );
            }).pipe(Effect.ensuring(Effect.sync(() => (store.getThread = original))));
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)("a dependency declared before the attempt prevents its launch", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "dependent-control" });
          yield* completeTurn(worker.session);
          yield* atAutonomy(thread, "full");
          world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
          open99(world);
          const tools = registry.forTransport(worker.thread.id, "worker");
          yield* tools
            .find((t) => t.descriptor.name === "pr_bind")!
            .run({
              repo: "acme/app",
              number: 12,
            });
          const publish = (approved: boolean) =>
            store
              .getThread(worker.thread.id)
              .pipe(
                Effect.flatMap((t) => publishGit(world, t, { pr: armedWorkerBadge(approved) })),
              );
          yield* publish(false);
          yield* tools.find((t) => t.descriptor.name === "merge_when_ready")!.run({});
          yield* registry
            .forTransport(thread.id, "orchestrator")
            .find((t) => t.descriptor.name === "depends_on")!
            .run({ threadId: worker.thread.id, pr: "acme/app#99" });
          yield* publish(true);
          yield* waitReal(
            "dependency checked",
            Effect.sync(() => viewed99(world) || undefined),
          );
          yield* settle;
          expect(world.ghCalls.filter((c) => c[2] === "merge")).toHaveLength(0);
          expect((yield* store.getThread(worker.thread.id)).boundPr?.mergeWhenReady).toBeDefined();
        }),
      );
    }).pipe(Effect.scoped),
  );
});
