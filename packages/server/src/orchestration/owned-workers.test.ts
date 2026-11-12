import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  HostId,
  LIMIT_PAUSE_TOOL,
  LOCAL_HOST_ID,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { NOT_YOUR_MACHINE, OWNERS_DIFFER, RoutedFor } from "../host/ownership.ts";
import { RemoteHosts, type RemoteHostsShape } from "../host/remote-hosts.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import type { FakeSession } from "../runtime/fake-agent.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { Orchestration } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  outboxOf,
  serverLayer,
  settle,
  spawn,
  waitReal,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

// Ownership is a machine's (`host/ownership.ts`), and an orchestration has one owner. Each test
// here drives one family of entry points into the choke point it must pass:
//
// - links between threads (a spawn, a join): refused between two owners, so a workspace's
//   orchestrator and its workers are always one person's;
// - what acts on a whole orchestration (stages, groups, held spawns): refused outright on a
//   person's machine in this version;
// - kept work (an owed answer): attempted as who it was written for, a retry included.
//
// The host and session resolver (`WorkerHosts.get`, the session lookup, the runtimes' deliveries)
// has its own tests: `host/placed.test.ts` (terminals by id, sessions, files and git) and
// `http/fronted-sign-in.test.ts` (every RPC and HTTP answer, on a real server).

/** In these tests this machine is Grace's: the orchestrator and what it spawns here are hers. */
const gracesHere = (world: World) => {
  world.owners = new Map([[LOCAL_HOST_ID, "grace"]]);
};

const as =
  (person: string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, RoutedFor, { person });

const QUESTION = {
  question: "Should a deleted cart answer 404 or 410?",
  context: "Clients cache 404s for a day.",
  options: [
    { label: "404", description: "What the API does today" },
    { label: "410", description: "Gone, so clients drop it" },
  ],
  recommended: "410",
};

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

/** A joined machine no one owns, beside this one. */
const SHARED = {
  id: HostId.make("m-0123456789abcdef0shared01"),
  name: "build box",
  confirmed: true,
};
const withShared = Layer.succeed(RemoteHosts, {
  machines: { list: () => [] },
  list: () => [SHARED],
} as unknown as RemoteHostsShape);

const inServerWithShared = <A, E>(world: World, body: Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(serverLayer(world).pipe(Layer.provide(withShared)));
      return yield* body.pipe(Effect.provide(context));
    }),
  );

/** The orchestrator's agent reports its 5-hour window at `utilization`, resetting in an hour. */
const report = (session: FakeSession, utilization: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* session.emit({
      type: "rateLimit",
      status: "warning",
      window: "five_hour",
      utilization,
      resetsAt: now + 3_600_000,
    });
    const readings = yield* UsageLimitReadings;
    yield* waitReal(
      "the reading",
      readings.current.pipe(
        Effect.map((all) => all.some((each) => each.utilization === utilization)),
      ),
    );
  });

describe("an orchestration on a person's machine", () => {
  it.effect("links no thread on another owner's machine to it: no spawn there, no join", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      gracesHere(world);
      yield* inServerWithShared(
        world,
        Effect.gen(function* () {
          const { session, workspaceId } = yield* openOrchestrator(world);
          // Her orchestrator's worker on a machine no one owns: refused before anything is made.
          const spawned = yield* session
            .callTool("spawn_worker", {
              project: "shop",
              feature: "cart",
              title: "Cart API",
              brief: "Synthetic",
              machine: "build box",
            })
            .pipe(Effect.flip);
          expect(spawned.message).toContain(OWNERS_DIFFER);
          // A thread on that machine asks to join her orchestration: refused, whoever asks.
          const store = yield* ThreadStore;
          const worker = yield* spawn(session, { feature: "mine", title: "Mine" });
          yield* completeTurn(session);
          yield* store.updateThread(worker.thread.id, (thread) => {
            const { workspaceId: _ws, spawnedBy: _by, ...rest } = thread;
            return { ...rest, checkout: { ...thread.checkout, hostId: SHARED.id } };
          });
          for (const person of ["grace", undefined])
            expect(
              (yield* as(person)(
                (yield* Orchestration).joinWorkspace(worker.thread.id, workspaceId, {
                  feature: "back",
                }),
              ).pipe(Effect.flip)).message,
            ).toContain(OWNERS_DIFFER);
        }),
      );
    }),
  );

  it.effect("keeps no stages or groups, for its owner or its orchestrator alike", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      gracesHere(world);
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { session, workspaceId } = yield* openOrchestrator(world);
          yield* spawn(session, { feature: "cart", title: "Cart API" });
          yield* completeTurn(session);
          const orchestration = yield* Orchestration;
          for (const call of [
            orchestration.setStage(workspaceId, { feature: "cart", stage: "build" }),
            orchestration.setStage(workspaceId, { group: "release", stage: "build" }),
            orchestration.setGroup(workspaceId, { feature: "cart", group: "release" }),
          ])
            expect((yield* as("grace")(call).pipe(Effect.flip)).message).toContain(
              "keeps no stages or groups",
            );
          for (const [tool, input] of [
            ["set_stage", { feature: "cart", stage: "build" }],
            ["set_group", { feature: "cart", group: "release" }],
          ] as const)
            expect((yield* session.callTool(tool, input).pipe(Effect.flip)).message).toContain(
              "keeps no stages or groups",
            );
          const state = yield* (yield* ThreadStore).getWorkspace(workspaceId);
          expect(state.stages).toBeUndefined();
          expect(state.groups).toBeUndefined();
        }),
      );
    }),
  );

  it.effect("holds no spawn for later: a low-priority brief at the limit is not kept", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      gracesHere(world);
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { thread, workspaceId } = yield* openOrchestrator(world);
          yield* (yield* Orchestration).setCharter(workspaceId, {
            ...DEFAULT_CHARTER,
            pauseAtLimitPct: 80,
          });
          yield* settle;
          const fake = yield* FakeAgentControl;
          const runtimes = yield* ThreadRuntimes;
          const session = yield* waitReal(
            "the orchestrator on its new charter",
            Effect.sync(() =>
              fake.sessions.filter((each) => each.options.threadId === thread.id).at(-1),
            ),
          );
          for (let i = 0; i < 10 && (yield* runtimes.status(thread.id)) !== "idle"; i++) {
            if ((yield* runtimes.status(thread.id)) === "running") yield* session.completeTurn();
            yield* settle;
          }
          yield* report(session, 0.9);
          // Not held: it goes the way a normal brief at the limit does, to the pause card.
          yield* session
            .callTool("spawn_worker", {
              project: "shop",
              feature: "chores",
              title: "Chores",
              brief: "Synthetic",
              priority: "low",
            })
            .pipe(Effect.forkScoped);
          const store = yield* ThreadStore;
          yield* waitReal(
            "the pause card",
            Effect.map(store.listRequests(thread.id), (requests) =>
              requests.some(
                (request) => request.kind === "approval" && request.toolName === LIMIT_PAUSE_TOOL,
              ),
            ),
          );
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
        }),
      );
    }),
  );
});

describe("kept work for a person's machine", () => {
  // The durable-intent choke point (`durable-work.ts`): an owed answer is attempted as who gave
  // it, never as the server's own because the retry after a restart has no caller.
  it.effect("delivers an owed answer only as its maker, a retry after a restart included", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const saved = yield* withServer(
        world,
        Effect.gen(function* () {
          const opened = yield* openOrchestrator(world);
          const worker = yield* spawn(opened.session, { feature: "cart", title: "Cart API" });
          yield* completeTurn(opened.session);
          yield* worker.session.callTool("ask_question", QUESTION);
          // Ada answers while the machine is no one's, and her notice is cut off.
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
          return { workspaceId: opened.workspaceId, threadId: worker.thread.id };
        }),
      );
      // By the restart the machine is Grace's: the callerless retry goes as Ada's, and is refused.
      gracesHere(world);
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
          // A notice in Ada's own call is refused the same way, at the runtimes.
          expect(
            (yield* as("ada")(
              (yield* ThreadRuntimes).sendNotice(saved.threadId, "ada", { text: "Ada's" }),
            ).pipe(Effect.flip)).message,
          ).toBe(NOT_YOUR_MACHINE);
        }),
      );
    }),
  );
});
