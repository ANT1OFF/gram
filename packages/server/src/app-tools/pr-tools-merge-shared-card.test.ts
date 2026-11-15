// merge_when_ready: one merge intent is one card, and a card goes when its PR ends.
import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { hasGit, removeDir, run, tempDir } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  atAutonomy,
  completeTurn,
  makeWorld,
  openOrchestrator,
  publishGit,
  spawn,
  waitReal,
  withServer,
  type World,
} from "../orchestration/test-harness.ts";
import { MERGE_CARD_ENDED_POLL } from "./pr-tools.ts";
import { ready } from "./pr-tools-kit.ts";
import { AppToolRegistry } from "./registry.ts";

/**
 * A worker at full autonomy whose PR #12 was opened from a worktree it made itself, so a merge of
 * it needs the user, as on 2026-11-15: and that worker's orchestrator.
 */
let made = 0;
const selfMadeWorkerPr = (world: World) =>
  Effect.gen(function* () {
    const branch = `feat/self-made-${++made}`;
    const runtimes = yield* ThreadRuntimes;
    const registry = yield* AppToolRegistry;
    const { session, thread } = yield* openOrchestrator(world);
    const worker = yield* spawn(session, { feature: `shared-card-${made}` });
    yield* completeTurn(worker.session);
    yield* atAutonomy(thread, "full");
    const selfMade = tempDir();
    yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(selfMade)));
    run(world.repo, "worktree", "add", "-q", "-b", branch, selfMade);
    world.prHeads.set(12, { headRefName: branch });
    yield* runtimes.updateThread(worker.thread.id, (t) => ({
      ...t,
      boundPr: { repo: "acme/app", number: 12, monitor: false },
    }));
    const mergeFor = (threadId: ThreadId, audience: "worker" | "orchestrator") =>
      registry
        .forTransport(threadId, audience)
        .find((t) => t.descriptor.name === "merge_when_ready")!;
    return {
      orchestrator: thread,
      worker: worker.thread,
      workerMerge: mergeFor(worker.thread.id, "worker"),
      orchestratorMerge: mergeFor(thread.id, "orchestrator"),
    };
  });

const cardIn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return yield* waitReal(
      `the approval card in ${threadId}`,
      store.listRequests(threadId).pipe(Effect.map((all) => all[0])),
    );
  });

/** A second call's outcome: what it returned, or the card it raised in its own thread instead. */
const secondCall = <A, E>(threadId: ThreadId, call: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const fiber = yield* Effect.forkScoped(call);
    return yield* waitReal(
      "the second call to return or raise a card",
      Effect.gen(function* () {
        const requests = yield* store.listRequests(threadId);
        if (requests.length > 0) return { card: requests[0], result: undefined };
        const done = fiber.pollUnsafe();
        return done === undefined
          ? undefined
          : { card: undefined, result: yield* Fiber.join(fiber).pipe(Effect.option) };
      }),
    );
  });

describe("merge_when_ready shared card", () => {
  it.effect.skipIf(!hasGit)(
    "an orchestrator's call on its worker's pending merge raises no second card and isn't held",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const { orchestrator, worker, workerMerge, orchestratorMerge } =
              yield* selfMadeWorkerPr(world);
            const workerCall = yield* Effect.forkScoped(workerMerge.run({}));
            const card = yield* cardIn(worker.id);

            const second = yield* secondCall(
              orchestrator.id,
              orchestratorMerge.run({ threadId: worker.id }),
            );
            // Before: a second card in the orchestrator's thread, which held its turn and stayed
            // up after the worker's was answered.
            expect(second.card).toBeUndefined();
            expect(second.result?._tag === "Some" ? second.result.value : undefined).toMatchObject({
              askedElsewhere: worker.id,
              done: false,
            });
            expect(yield* runtimes.status(orchestrator.id)).not.toBe("needsApproval");

            yield* runtimes.respond(worker.id, card.id, {
              kind: "approval",
              decision: "allow",
              scope: "once",
            });
            yield* Fiber.join(workerCall);
            expect((yield* store.getThread(worker.id)).boundPr?.mergeWhenReady).toMatchObject({
              allowedBy: "user",
            });
            expect(yield* store.listRequests(orchestrator.id)).toEqual([]);
            expect(yield* store.listRequests(worker.id)).toEqual([]);
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)(
    "a worker's call on the merge its orchestrator is asking about joins that card",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const { orchestrator, worker, workerMerge, orchestratorMerge } =
              yield* selfMadeWorkerPr(world);
            const orchestratorCall = yield* Effect.forkScoped(
              orchestratorMerge.run({ threadId: worker.id }),
            );
            const card = yield* cardIn(orchestrator.id);

            const second = yield* secondCall(worker.id, workerMerge.run({}));
            expect(second.card).toBeUndefined();
            expect(second.result?._tag === "Some" ? second.result.value : undefined).toMatchObject({
              askedElsewhere: orchestrator.id,
            });

            yield* runtimes.respond(orchestrator.id, card.id, {
              kind: "approval",
              decision: "allow",
              scope: "once",
            });
            yield* Fiber.join(orchestratorCall);
            expect((yield* store.getThread(worker.id)).boundPr?.mergeWhenReady).toMatchObject({
              allowedBy: "user",
            });
            expect(yield* store.listRequests(worker.id)).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)("an answered card shares nothing with a later call", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const { orchestrator, worker, workerMerge, orchestratorMerge } =
            yield* selfMadeWorkerPr(world);
          const workerCall = yield* Effect.forkScoped(workerMerge.run({}));
          const card = yield* cardIn(worker.id);
          yield* runtimes.respond(worker.id, card.id, {
            kind: "approval",
            decision: "deny",
            scope: "once",
          });
          expect((yield* Fiber.join(workerCall).pipe(Effect.flip)).message).toContain(
            "The user declined merge_when_ready.",
          );
          // The decision was made and declined: asking again is a new question, put to the user.
          const later = yield* secondCall(
            orchestrator.id,
            orchestratorMerge.run({ threadId: worker.id }),
          );
          expect(later.card).toBeDefined();
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)("a different method is a different decision, with its own card", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { orchestrator, worker, workerMerge, orchestratorMerge } =
            yield* selfMadeWorkerPr(world);
          yield* Effect.forkScoped(workerMerge.run({}));
          yield* cardIn(worker.id);
          const second = yield* secondCall(
            orchestrator.id,
            orchestratorMerge.run({ threadId: worker.id, method: "rebase" }),
          );
          expect(second.card).toBeDefined();
        }),
      );
    }).pipe(Effect.scoped),
  );

  for (const state of ["MERGED", "CLOSED"] as const) {
    it.effect.skipIf(!hasGit)(`a waiting merge card is withdrawn once its PR is ${state}`, () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const { orchestrator, worker, orchestratorMerge } = yield* selfMadeWorkerPr(world);
            const call = yield* Effect.forkScoped(orchestratorMerge.run({ threadId: worker.id }));
            yield* cardIn(orchestrator.id);

            yield* publishGit(world, worker, {
              pr: ready({ number: 12, url: "https://github.com/acme/app/pull/12", state }),
            });
            yield* TestClock.adjust(MERGE_CARD_ENDED_POLL);

            const refused = yield* Fiber.join(call).pipe(Effect.flip);
            // Before: the card stayed up, to be answered for a PR that had already ended.
            expect(refused.message).toBe(
              `acme/app#12 ${state.toLowerCase()} while the user was being asked, so there is nothing to merge: the card was withdrawn. Check it with pr_status.`,
            );
            expect(yield* store.listRequests(orchestrator.id)).toEqual([]);
            expect(yield* runtimes.status(orchestrator.id)).not.toBe("needsApproval");
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
    );
  }
});
