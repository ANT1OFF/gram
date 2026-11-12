import { describe, expect, it } from "@effect/vitest";
import { HostId, type ThreadId, type WorkspaceId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { NOT_YOUR_MACHINE, RoutedFor } from "../host/ownership.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Orchestration } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  outboxOf,
  settle,
  spawn,
  waitReal,
  withServer,
  type World,
} from "./test-harness.ts";

// A workspace whose orchestrator is on no one's machine, with a worker on a machine started for
// Grace (`host/ownership.ts`): the worker is hers, whatever the workspace. The review's case: Ada
// answers its question, dismisses it, or pauses its feature, now and in a retry with no caller.

const GRACES = HostId.make("m-0123456789abcdef0grace01");

const QUESTION = {
  question: "Should a deleted cart answer 404 or 410?",
  context: "Clients cache 404s for a day.",
  options: [
    { label: "404", description: "What the API does today" },
    { label: "410", description: "Gone, so clients drop it" },
  ],
  recommended: "410",
};

const as =
  (person: string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, RoutedFor, { person });

const stored = (workspaceId: WorkspaceId, id: string) =>
  Effect.map(outboxOf(workspaceId), (outbox) =>
    (outbox.questions ?? []).find((question) => question.id === id),
  );

/** What reached the worker of a closed question: the notices queued or sent to it. */
const answerNotices = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const queued = (yield* store.listQueue(threadId)).map((item) => item.input.text);
    const recorded = (yield* store.listMessages(threadId)).flatMap((message) =>
      message.role === "user"
        ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    );
    return [...queued, ...recorded].filter((text) => text.includes("your question WQ1"));
  });

/** The orchestrator, on this machine, and its worker, asking WQ1 from Grace's machine. */
const mixed = (world: World) =>
  Effect.gen(function* () {
    const opened = yield* openOrchestrator(world);
    const worker = yield* spawn(opened.session, { feature: "cart", title: "Cart API" });
    yield* completeTurn(opened.session);
    yield* worker.session.callTool("ask_question", QUESTION);
    // Its checkout is on Grace's machine: the worker is hers. Its session runs already, so a
    // notice reaches it with no machine looked up.
    yield* (yield* ThreadStore).updateThread(worker.thread.id, (thread) => ({
      ...thread,
      checkout: { ...thread.checkout, hostId: GRACES },
    }));
    world.owners = new Map([[GRACES, "grace"]]);
    return { ...opened, worker };
  });

describe("a worker on another person's machine, under an orchestrator on no one's", () => {
  it.effect("takes no answer, dismissal or feature pause from anyone but its owner", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { workspaceId, worker, session } = yield* mixed(world);
          const orchestration = yield* Orchestration;
          const before = yield* answerNotices(worker.thread.id);
          for (const call of [
            orchestration.answerQuestionAsUser({
              workspaceId,
              questionId: "WQ1",
              answer: "Ada's instructions for Grace's worker",
            }),
            orchestration.dismissQuestionAsUser({
              workspaceId,
              questionId: "WQ1",
              reason: "Ada's instructions instead",
            }),
          ])
            expect((yield* as("ada")(call).pipe(Effect.flip)).message).toBe(NOT_YOUR_MACHINE);
          // Nothing was written to send later, and nothing reached the worker.
          const open = yield* stored(workspaceId, "WQ1");
          expect(open?.stage).toBe("triage");
          expect(open?.deliveryOwed).toBeUndefined();
          expect(yield* answerNotices(worker.thread.id)).toEqual(before);
          // The orchestrator, on no one's machine, answers for no one: not hers either.
          const byOrchestrator = yield* session
            .callTool("answer_worker", {
              questionId: "WQ1",
              answer: "410",
              source: "the brief",
            })
            .pipe(Effect.flip);
          expect(byOrchestrator.message).toContain(NOT_YOUR_MACHINE);
          expect((yield* stored(workspaceId, "WQ1"))?.stage).toBe("triage");

          // A pause of its feature would interrupt her running worker: refused before any change.
          const runtimes = yield* ThreadRuntimes;
          expect(
            (yield* as("ada")(orchestration.setFeaturePaused(workspaceId, "cart", true)).pipe(
              Effect.flip,
            )).message,
          ).toBe(NOT_YOUR_MACHINE);
          expect((yield* (yield* ThreadStore).getWorkspace(workspaceId)).pausedFeatures).toBe(
            undefined,
          );
          expect(
            (yield* as("ada")(orchestration.archiveFeature(workspaceId, "cart")).pipe(Effect.flip))
              .message,
          ).toBe(NOT_YOUR_MACHINE);
          // Nor can anyone else's call interrupt it, or hand it a notice, directly.
          expect(
            (yield* as("ada")(runtimes.interrupt(worker.thread.id)).pipe(Effect.flip))._tag,
          ).toBe("ThreadNotFound");
          expect(
            (yield* as("ada")(runtimes.sendNotice(worker.thread.id, "ada", { text: "Ada's" })).pipe(
              Effect.flip,
            )).message,
          ).toBe(NOT_YOUR_MACHINE);

          // Grace answers it, and it reaches her worker.
          const answered = yield* as("grace")(
            orchestration.answerQuestionAsUser({ workspaceId, questionId: "WQ1", answer: "410" }),
          );
          expect(answered).toMatchObject({ stage: "answered", answer: "410" });
          expect(answered.delivered).toBeDefined();
          expect((yield* stored(workspaceId, "WQ1"))?.closedFor).toEqual({ person: "grace" });
          expect(yield* answerNotices(worker.thread.id)).toHaveLength(before.length + 1);
        }),
      );
    }),
  );

  // A decision kept to send later is sent as the person it was made for, never as the server's.
  it.effect("a retry with no caller sends an owed answer only if its maker may still", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const saved = yield* withServer(
        world,
        Effect.gen(function* () {
          const opened = yield* openOrchestrator(world);
          const worker = yield* spawn(opened.session, { feature: "cart", title: "Cart API" });
          yield* completeTurn(opened.session);
          yield* worker.session.callTool("ask_question", QUESTION);
          // Ada answers while the worker is on no one's machine, and her notice is cut off.
          const runtimes = yield* ThreadRuntimes;
          const entered = yield* Deferred.make<void>();
          const original = runtimes.sendNotice;
          const mutable = runtimes as {
            -readonly [K in keyof typeof runtimes]: (typeof runtimes)[K];
          };
          mutable.sendNotice = (threadId, key, input, options) =>
            key.startsWith("question:")
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
              : original(threadId, key, input, options);
          const call = yield* as("ada")(
            (yield* Orchestration).answerQuestionAsUser({
              workspaceId: opened.workspaceId,
              questionId: "WQ1",
              answer: "Ada's word",
            }),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(call);
          mutable.sendNotice = original;
          expect(yield* stored(opened.workspaceId, "WQ1")).toMatchObject({
            stage: "answered",
            deliveryOwed: true,
            closedFor: { person: "ada" },
          });
          // Then the worker goes onto a machine started for Grace.
          yield* (yield* ThreadStore).updateThread(worker.thread.id, (thread) => ({
            ...thread,
            checkout: { ...thread.checkout, hostId: GRACES },
          }));
          return { workspaceId: opened.workspaceId, threadId: worker.thread.id };
        }),
      );
      world.owners = new Map([[GRACES, "grace"]]);
      // The restart's retry has no caller: it goes as Ada's, so it is settled and never sent.
      yield* withServer(
        world,
        Effect.gen(function* () {
          const settled = yield* waitReal(
            "the owed answer settled after the restart",
            Effect.map(stored(saved.workspaceId, "WQ1"), (question) =>
              question?.deliveryOwed === undefined ? question : undefined,
            ),
          );
          expect(settled?.delivered).toBeUndefined();
          yield* settle;
          expect(yield* answerNotices(saved.threadId)).toEqual([]);
        }),
      );
    }),
  );
});
