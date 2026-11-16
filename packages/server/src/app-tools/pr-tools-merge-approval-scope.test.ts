// merge_when_ready: a user's approval covers the head and base its card named, and says whether the
// PR is from a fork, so a push to the fork or a retarget while the card waits asks again.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  spawn,
  waitReal,
  withServer,
  type World,
} from "../orchestration/test-harness.ts";
import { AppToolRegistry } from "./registry.ts";

const HEAD = "a".repeat(40);
const PUSHED = "d".repeat(40);
const allow = { kind: "approval", decision: "allow", scope: "once" } as const;

/** A worker at `publish` autonomy asked to merge PR #12, whose head `prHeads` says. */
const workerMerge = (world: World) =>
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const { session } = yield* openOrchestrator(world);
    const worker = yield* spawn(session, { feature: "approval-scope" });
    yield* completeTurn(worker.session);
    const merge = registry
      .forTransport(worker.thread.id, "worker")
      .find((t) => t.descriptor.name === "merge_when_ready")!;
    return { worker: worker.thread, merge };
  });

const cardIn = (threadId: Parameters<ThreadStore["Service"]["listRequests"]>[0]) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return yield* waitReal(
      "the approval card",
      store.listRequests(threadId).pipe(Effect.map((all) => all[0])),
    );
  });

describe("merge_when_ready approval scope", () => {
  it.effect.skipIf(!hasGit)(
    "the card names a fork, its head and base, and the intent keeps them",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const { worker, merge } = yield* workerMerge(world);
            world.prHeads.set(12, {
              headRefName: "patch-1",
              fork: true,
              headRefOid: HEAD,
              baseRef: "main",
            });
            const call = yield* Effect.forkScoped(merge.run({ pr: 12 }));
            const card = yield* cardIn(worker.id);
            expect(card).toMatchObject({ displayName: "merge_when_ready" });
            expect(JSON.stringify(card)).toContain(
              "from a fork, its head aaaaaaa exactly, into main; a new push to the fork asks again",
            );
            yield* runtimes.respond(worker.id, card.id, allow);
            yield* Fiber.join(call);
            expect((yield* store.getThread(worker.id)).boundPr?.mergeWhenReady).toMatchObject({
              allowedBy: "user",
              approved: { head: HEAD, baseRef: "main", fork: true },
            });
          }),
        );
      }).pipe(Effect.scoped),
  );

  for (const [what, moved] of [
    ["a push to the fork", { headRefOid: PUSHED, baseRef: "main" }],
    ["a retarget", { headRefOid: HEAD, baseRef: "release" }],
  ] as const) {
    it.effect.skipIf(!hasGit)(`${what} while the card waits arms nothing`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const { worker, merge } = yield* workerMerge(world);
            const shown = { headRefName: "patch-1", fork: true, baseRef: "main" };
            world.prHeads.set(12, { ...shown, headRefOid: HEAD });
            const call = yield* Effect.forkScoped(merge.run({ pr: 12 }).pipe(Effect.flip));
            const card = yield* cardIn(worker.id);
            world.prHeads.set(12, { ...shown, ...moved });
            yield* runtimes.respond(worker.id, card.id, allow);
            expect((yield* Fiber.join(call)).message).toContain("changed while the user was asked");
            expect((yield* store.getThread(worker.id)).boundPr?.mergeWhenReady).toBeUndefined();
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }
});
