// merge_when_ready: one merge intent is one card, and a card goes when its PR ends.
import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

/**
 * A worker at `publish` autonomy whose PR #12 is its own (its branch, in the worktree Gram gave it),
 * bound: every merge call of either thread asks the user.
 */
const ownWorkerPr = (world: World) =>
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const { session, thread } = yield* openOrchestrator(world);
    const worker = yield* spawn(session, { feature: `own-pr-${++made}` });
    yield* completeTurn(worker.session);
    // The harness's orchestrator starts at `publish`.
    world.prHeads.set(12, { headRefName: worker.thread.checkout.branch! });
    const tools = registry.forTransport(worker.thread.id, "worker");
    yield* tools
      .find((t) => t.descriptor.name === "pr_bind")!
      .run({ repo: "acme/app", number: 12 });
    return {
      orchestrator: thread,
      worker: worker.thread,
      workerMerge: tools.find((t) => t.descriptor.name === "merge_when_ready")!,
      orchestratorMerge: registry
        .forTransport(thread.id, "orchestrator")
        .find((t) => t.descriptor.name === "merge_when_ready")!,
    };
  });

const allow = { kind: "approval", decision: "allow", scope: "once" } as const;

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
        if (requests.length > 0) return { card: requests[0], result: undefined, fiber };
        const done = fiber.pollUnsafe();
        return done === undefined
          ? undefined
          : { card: undefined, result: yield* Fiber.join(fiber).pipe(Effect.option), fiber };
      }),
    );
  });

describe("merge_when_ready shared card", () => {
  // 2026-11-15: the worker's plain arm and its orchestrator's each raised a card; approving the
  // worker's left the orchestrator's up, holding its turn. They are separate approvals (only an
  // orchestrator's carries its `userAuthorization`), so each keeps its card, but one answer settles
  // both.
  for (const first of ["worker", "orchestrator"] as const) {
    it.effect.skipIf(!hasGit)(
      `approving the ${first}'s plain arm takes the other's card down and releases its thread`,
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
              const calls = {
                worker: [worker.id, workerMerge.run({})] as const,
                orchestrator: [
                  orchestrator.id,
                  orchestratorMerge.run({ threadId: worker.id }),
                ] as const,
              };
              const [firstId, firstRun] = calls[first];
              const [secondId, secondRun] = calls[first === "worker" ? "orchestrator" : "worker"];
              const firstCall = yield* Effect.forkScoped(firstRun);
              const card = yield* cardIn(firstId);
              const second = yield* secondCall(secondId, secondRun);
              // Each caller's own decision: no call stands in for another's.
              expect(second.card).toBeDefined();

              yield* runtimes.respond(firstId, card.id, allow);
              yield* Fiber.join(firstCall);
              // Before: the other card stayed up, and its thread waited on it.
              expect(yield* Fiber.join(second.fiber)).toMatchObject({
                settledElsewhere: firstId,
                done: false,
              });
              expect(yield* store.listRequests(secondId)).toEqual([]);
              expect(yield* runtimes.status(secondId)).not.toBe("needsApproval");
              const intent = (yield* store.getThread(worker.id)).boundPr?.mergeWhenReady;
              expect(intent).toMatchObject({ allowedBy: "user" });
              // The intent is the approved call's: a worker's approval carries no orchestrator's
              // authorization, so the orchestrator is asked again before it maintains the intent.
              if (first === "worker") expect(intent?.userAuthorization).toBeUndefined();
              expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
            }),
          );
        }).pipe(Effect.scoped),
    );
  }

  it.effect.skipIf(!hasGit)("declining one plain arm declines the other's card", () =>
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
          expect(second.card).toBeDefined();
          yield* runtimes.respond(worker.id, card.id, { ...allow, decision: "deny" });
          expect((yield* Fiber.join(workerCall).pipe(Effect.flip)).message).toContain(
            "The user declined merge_when_ready.",
          );
          expect((yield* Fiber.join(second.fiber).pipe(Effect.flip)).message).toContain(
            `The user declined the same merge_when_ready in another thread (${worker.id})`,
          );
          expect(yield* store.listRequests(orchestrator.id)).toEqual([]);
          expect((yield* store.getThread(worker.id)).boundPr?.mergeWhenReady).toBeUndefined();
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!hasGit)("the same caller's identical call joins its own waiting card", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const { orchestrator, worker, orchestratorMerge } = yield* ownWorkerPr(world);
          const input = { threadId: worker.id, hold: "release order" };
          yield* Effect.forkScoped(orchestratorMerge.run(input));
          yield* cardIn(orchestrator.id);
          const again = yield* Effect.exit(orchestratorMerge.run(input));
          expect(Exit.isSuccess(again) ? again.value : undefined).toMatchObject({
            askedElsewhere: orchestrator.id,
          });
          expect(yield* store.listRequests(orchestrator.id)).toHaveLength(1);
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
          yield* runtimes.respond(worker.id, card.id, { ...allow, decision: "deny" });
          yield* Fiber.join(workerCall).pipe(Effect.flip);
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

  it.effect.skipIf(!hasGit)("a different method is a different decision, settled on its own", () =>
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
            orchestratorMerge.run({ threadId: worker.id, method: "rebase" }),
          );
          expect(second.card).toBeDefined();
          yield* runtimes.respond(worker.id, card.id, allow);
          yield* Fiber.join(workerCall);
          expect(yield* store.listRequests(orchestrator.id)).toHaveLength(1);
        }),
      );
    }).pipe(Effect.scoped),
  );

  // The review of #657: a hold says who holds the merge. The orchestrator's is one its worker can't
  // lift, so the worker's pending card for the same hold is not the orchestrator's decision.
  it.effect.skipIf(!hasGit)(
    "an orchestrator's hold keeps its own card beside its worker's identical one, and stands",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const { orchestrator, worker, workerMerge, orchestratorMerge } =
              yield* ownWorkerPr(world);
            const workerCall = yield* Effect.forkScoped(
              workerMerge.run({ hold: "independent review" }),
            );
            const workerCard = yield* cardIn(worker.id);
            const second = yield* secondCall(
              orchestrator.id,
              orchestratorMerge.run({ threadId: worker.id, hold: "independent review" }),
            );
            // At 42938b0c it joined the worker's card, and only `heldBy: "thread"` came of it.
            expect(second.card).toBeDefined();
            yield* runtimes.respond(worker.id, workerCard.id, allow);
            yield* Fiber.join(workerCall);
            // The worker's answer is not the orchestrator's: its card stays up for its own.
            expect(yield* store.listRequests(orchestrator.id)).toHaveLength(1);
            expect((yield* store.getThread(worker.id)).boundPr?.mergeWhenReady).toMatchObject({
              heldBy: "thread",
            });
            yield* runtimes.respond(orchestrator.id, second.card!.id, allow);
            yield* Fiber.join(second.fiber);
            expect((yield* store.getThread(worker.id)).boundPr?.mergeWhenReady).toMatchObject({
              hold: "independent review",
              heldBy: "orchestrator",
            });

            // At full auto the worker's release is delegated on its own PR, but not over this hold.
            yield* atAutonomy(orchestrator, "full");
            const release = yield* secondCall(worker.id, workerMerge.run({ release: true }));
            expect(release.card !== undefined || release.result?._tag === "None").toBe(true);
            expect((yield* store.getThread(worker.id)).boundPr?.mergeWhenReady).toMatchObject({
              hold: "independent review",
              heldBy: "orchestrator",
            });
            expect(world.ghCalls.filter((c) => c[2] === "merge")).toEqual([]);
          }),
        );
      }).pipe(Effect.scoped),
  );

  const scoped: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["a hold", { hold: "release order" }],
    ["a hold on an agent", { hold: "re-review", holdWaitsOn: "agent" }],
    ["a release", { release: true }],
    ["a cleared hold", { hold: null }],
    ["an after", { after: ["acme/app#13"] }],
  ];
  for (const [what, input] of scoped) {
    for (const first of ["worker", "orchestrator"] as const) {
      it.effect.skipIf(!hasGit)(
        `${what} from the ${first} shares no card across roles, nor settles the other's`,
        () =>
          Effect.gen(function* () {
            const world = yield* makeWorld;
            yield* withServer(
              world,
              Effect.gen(function* () {
                const store = yield* ThreadStore;
                const runtimes = yield* ThreadRuntimes;
                const { orchestrator, worker, workerMerge, orchestratorMerge } =
                  yield* ownWorkerPr(world);
                const calls = {
                  worker: [worker.id, workerMerge.run(input)] as const,
                  orchestrator: [
                    orchestrator.id,
                    orchestratorMerge.run({ ...input, threadId: worker.id }),
                  ] as const,
                };
                const [firstId, firstRun] = calls[first];
                const [secondId, secondRun] = calls[first === "worker" ? "orchestrator" : "worker"];
                const firstCall = yield* Effect.forkScoped(firstRun);
                const card = yield* cardIn(firstId);
                expect((yield* secondCall(secondId, secondRun)).card).toBeDefined();
                yield* runtimes.respond(firstId, card.id, allow);
                yield* Effect.exit(Fiber.join(firstCall));
                expect(yield* store.listRequests(secondId)).toHaveLength(1);
              }),
            );
          }).pipe(Effect.scoped),
      );
    }
  }

  it.effect.skipIf(!hasGit)(
    "a worker's plain arm on an orchestrator-held intent is not its orchestrator's decision",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const runtimes = yield* ThreadRuntimes;
            const { orchestrator, worker, workerMerge, orchestratorMerge } =
              yield* ownWorkerPr(world);
            yield* runtimes.updateThread(worker.id, (t) => ({
              ...t,
              boundPr: {
                ...t.boundPr!,
                mergeWhenReady: {
                  allowedBy: "user",
                  method: "squash",
                  heldBy: "orchestrator",
                  hold: "release order",
                  setAt: 0,
                },
              },
            }));
            const orchestratorCall = yield* Effect.forkScoped(
              orchestratorMerge.run({ threadId: worker.id }),
            );
            const card = yield* cardIn(orchestrator.id);
            const second = yield* secondCall(worker.id, workerMerge.run({}));
            expect(second.card).toBeDefined();
            yield* runtimes.respond(orchestrator.id, card.id, allow);
            yield* Fiber.join(orchestratorCall);
            expect(yield* store.listRequests(worker.id)).toHaveLength(1);
            yield* runtimes.respond(worker.id, second.card!.id, allow);
            yield* Fiber.join(second.fiber);
            // The worker's arm under its orchestrator's hold is `locked`: the hold stands.
            expect((yield* store.getThread(worker.id)).boundPr?.mergeWhenReady).toMatchObject({
              hold: "release order",
              heldBy: "orchestrator",
            });
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
