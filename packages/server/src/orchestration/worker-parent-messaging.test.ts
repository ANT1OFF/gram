import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, fenceThreadMessage, type Thread } from "@gram/contracts";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { AppToolRegistry, approvalFor, bindAppTools } from "../app-tools/registry.ts";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { encodeOutbox } from "./outbox.ts";
import { Orchestration } from "./service.ts";
import {
  atAutonomy,
  makeWorld,
  outboxOf,
  settle,
  waitReal,
  waitStatus,
  openOrchestrator,
  spawn,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

const setup = (world: World) =>
  Effect.gen(function* () {
    const { thread, workspaceId } = yield* openOrchestrator(world);
    const session = yield* atAutonomy(thread, "full", { workerMode: "bypassPermissions" });
    const worker = yield* spawn(session, { feature: "sender" });
    const runtimes = yield* ThreadRuntimes;
    yield* runtimes.send(thread.id, { text: "Continue coordinating." });
    yield* waitStatus(thread.id, "running");
    const registry = yield* AppToolRegistry;
    const tool = registry
      .forTransport(worker.thread.id, "worker")
      .find((candidate) => candidate.descriptor.name === "send_message")!;
    return { thread, workspaceId, session, worker, registry, tool };
  });

describe.skipIf(!hasGit)("Full Auto worker parent messaging", () => {
  it.effect("sameparent Full Auto approval descriptor recognizes the actual parent", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, tool } = yield* setup(world);
        expect(tool.descriptor.class).toBe("crossThread");
        expect(yield* tool.needsApproval!({ threadId: thread.id, text: "Coordinate." })).toBe(
          false,
        );
      }),
    ),
  );

  it.effect("sameparent Full Auto effective approval method is none", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, tool } = yield* setup(world);
        const asked = yield* tool.needsApproval!({ threadId: thread.id, text: "Coordinate." });
        expect(approvalFor(tool.descriptor.class, asked)).toBe("none");
      }),
    ),
  );

  it.effect("sameparent Full Auto launch dispatch accepts an uncarded parent send", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, worker, registry } = yield* setup(world);
        const definition = registry.definitions.find(
          (candidate) => candidate.descriptor.name === "send_message",
        )!;
        expect(
          yield* definition.handle(
            worker.thread.id,
            {
              threadId: thread.id,
              text: "Coordinate.",
            },
            { carded: false },
          ),
        ).toMatchObject({ threadId: thread.id, delivered: "queued" });
      }),
    ),
  );
  it.effect.each([undefined, "queue", "steer"] as const)(
    "sameparent Full Auto transport mode %s preserves origin and sender-scoped retries",
    (mode) =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, worker, tool, session, registry, workspaceId } = yield* setup(world);
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const second = yield* spawn(session, { feature: "second" });
          const message = {
            threadId: thread.id,
            text: "Coordinate.",
            clientRequestId: "parent-1",
            ...(mode === undefined ? {} : { mode }),
          };
          expect(worker.session.options.instructions).toContain(
            "resolves your current bound orchestrator",
          );
          expect(worker.session.options.instructions).toContain("Prefer `report` for progress");
          expect(tool.descriptor.description).toContain("Prefer `report`");
          const delivered = mode === "steer" ? "steered" : "queued";
          expect(yield* tool.run(message)).toMatchObject({ delivered });
          for (let i = 0; i < 6; i++)
            expect(yield* tool.run(message)).toMatchObject({ delivered, repeated: true });
          expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          const parent = (yield* runtimes.snapshot).find((s) => s.thread.id === thread.id)!;
          const input = mode === "steer" ? session.steered.at(-1) : parent.queue.at(-1)?.input;
          expect(input).toMatchObject({
            origin: { threadId: worker.thread.id, title: worker.thread.title, depth: 2 },
          });
          // The queue holds the worker's words as written; the orchestrator's agent reads them fenced.
          expect(input?.text).toBe(
            mode === "steer" ? fenceThreadMessage(input!.origin!, "Coordinate.") : "Coordinate.",
          );
          expect(input?.origin).not.toHaveProperty("role", "orchestrator");
          for (const change of [
            { text: "Actually, the API changed." },
            { mode: mode === "steer" ? "queue" : "steer" },
            { threadId: second.thread.id },
          ])
            expect(
              (yield* tool.run({ ...message, ...change }).pipe(Effect.flip)).message,
            ).toContain("already sent another message");
          if (mode !== "steer") {
            expect(
              parent.queue.filter((q) => q.input.origin?.threadId === worker.thread.id),
            ).toHaveLength(1);
            expect(
              (yield* tool.run({ ...message, clientRequestId: "parent-2" }).pipe(Effect.flip))
                .message,
            ).toContain("already came from this thread");
          }
          const secondTool = registry
            .forTransport(second.thread.id, "worker")
            .find((candidate) => candidate.descriptor.name === "send_message")!;
          expect(yield* secondTool.run({ ...message, mode: "queue" })).toMatchObject({
            delivered: "queued",
          });
          expect(Object.keys((yield* outboxOf(workspaceId)).sentRequests ?? {})).toHaveLength(2);
          for (const name of ["stop_thread", "archive_thread", "set_thread_model"]) {
            const otherTool = registry
              .forThread(worker.thread.id, "worker")
              .find((candidate) => candidate.descriptor.name === name)!;
            expect(yield* otherTool.needsApproval!({ threadId: thread.id, model: "opus" })).toBe(
              true,
            );
          }
          expect(
            registry
              .forThread(worker.thread.id, "worker")
              .some((t) => t.descriptor.name === "adopt_thread"),
          ).toBe(false);
        }),
      ),
  );

  it.effect("sameparent relationship rejects foreign, historical, unowned and stale threads", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, workspaceId, worker, tool } = yield* setup(world);
        const store = yield* ThreadStore;
        const orchestration = yield* Orchestration;
        const message = { threadId: thread.id, text: "Coordinate." };
        const definition = (yield* AppToolRegistry).definitions.find(
          (candidate) => candidate.descriptor.name === "send_message",
        )!;
        const refused = Effect.gen(function* () {
          const asked = yield* tool.needsApproval!(message);
          expect(asked).toBe(true);
          expect(approvalFor(tool.descriptor.class, asked)).toBe("forced");
          expect(
            (yield* definition
              .handle(worker.thread.id, message, { carded: false })
              .pipe(Effect.flip)).message,
          ).toMatch(/^no_authority:/);
        });
        for (const change of [
          { parked: true },
          { role: "dream" },
          { workspaceId: "other-workspace" },
          { spawnedBy: undefined },
          { spawnedBy: { ...worker.thread.spawnedBy!, threadId: "foreign-orchestrator" } },
          { model: { agent: "grok", model: "unadmitted" } },
        ]) {
          yield* store.updateThread(
            worker.thread.id,
            () =>
              Object.fromEntries(
                Object.entries({ ...worker.thread, ...change }).filter(
                  ([, value]) => value !== undefined,
                ),
              ) as Thread,
          );
          yield* refused;
        }
        yield* store.updateThread(worker.thread.id, () => worker.thread);
        for (const change of [
          { parked: true },
          { role: undefined },
          { workspaceId: "other-workspace" },
          { model: { agent: "grok", model: "unadmitted" } },
        ]) {
          yield* store.updateThread(
            thread.id,
            () =>
              Object.fromEntries(
                Object.entries({ ...thread, ...change }).filter(([, value]) => value !== undefined),
              ) as Thread,
          );
          yield* refused;
        }
        yield* store.updateThread(thread.id, () => thread);
        const workspace = yield* store.getWorkspace(workspaceId);
        for (const id of [undefined, "different-orchestrator" as typeof thread.id]) {
          yield* store.updateWorkspace(workspaceId, (s) => ({
            ...s,
            workspace: Object.fromEntries(
              Object.entries({ ...s.workspace, orchestratorThreadId: id }).filter(
                ([, value]) => value !== undefined,
              ),
            ) as typeof s.workspace,
          }));
          yield* refused;
        }
        yield* store.putWorkspace(workspace);
        const outbox = yield* store.getOutbox(workspaceId);
        const decoded = yield* outboxOf(workspaceId);
        const { [worker.thread.id]: _worker, ...workers } = decoded.workers;
        for (const bad of [encodeOutbox({ ...decoded, workers }), "invalid-json"]) {
          yield* store.putOutbox(workspaceId, bad);
          yield* refused;
        }
        yield* store.putOutbox(workspaceId, outbox!);
        for (const autonomy of ["supervised", "publish"] as const) {
          yield* orchestration.setCharter(workspaceId, {
            ...DEFAULT_CHARTER,
            autonomy,
            workerMode: "bypassPermissions",
          });
          yield* refused;
        }
        yield* orchestration.setCharter(workspaceId, { ...DEFAULT_CHARTER, autonomy: "full" });
        expect(yield* tool.needsApproval!(message)).toBe(false);
        expect(
          (yield* tool.needsApproval!({ ...message, threadId: "unknown-thread" }).pipe(Effect.flip))
            .message,
        ).toContain("This thread does not exist");
        expect(yield* tool.needsApproval!({ ...message, threadId: worker.thread.id })).toBe(true);
      }),
    ),
  );

  it.effect.each(["supervised", "publish"] as const)(
    "sameparent %s forces an actual Bypass card; Full preserves the pending request",
    (autonomy) =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, worker, tool, workspaceId } = yield* setup(world);
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const orchestration = yield* Orchestration;
          yield* orchestration.setCharter(workspaceId, {
            ...DEFAULT_CHARTER,
            autonomy,
            workerMode: "bypassPermissions",
          });
          const pending = yield* tool
            .run({ threadId: thread.id, text: "Coordinate." })
            .pipe(Effect.flip, Effect.forkScoped);
          const [card] = yield* waitReal(
            "the parent message approval",
            store.listRequests(worker.thread.id).pipe(Effect.map((all) => all.length === 1 && all)),
          );
          expect(card).toMatchObject({
            kind: "approval",
            displayName: "send_message",
            scopes: ["once"],
          });
          yield* orchestration.setCharter(workspaceId, { ...DEFAULT_CHARTER, autonomy: "full" });
          yield* settle;
          expect(yield* store.listRequests(worker.thread.id)).toEqual([card]);
          yield* runtimes.respond(worker.thread.id, card!.id, {
            kind: "approval",
            decision: "deny",
            scope: "once",
          });
          expect((yield* Fiber.join(pending)).message).toContain("declined send_message");
          expect((yield* runtimes.snapshot).find((s) => s.thread.id === thread.id)?.queue).toEqual(
            [],
          );
        }),
      ),
  );

  it.effect.each(["pause", "hold", "autonomy", "ownership", "slot"] as const)(
    "sameparent rechecks %s after the approval decision and before dispatch",
    (change) =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, workspaceId, worker, registry } = yield* setup(world);
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const runtimes = yield* ThreadRuntimes;
          const definition = registry.definitions.find(
            (candidate) => candidate.descriptor.name === "send_message",
          )!;
          const tool = bindAppTools(
            [
              {
                ...definition,
                needsApproval: (caller, decoded, target) =>
                  Effect.gen(function* () {
                    const asked = yield* definition.needsApproval!(caller, decoded, target);
                    expect(asked).toBe(false);
                    if (change === "pause") yield* orchestration.setPaused(workspaceId, true);
                    if (change === "hold") {
                      const outbox = yield* outboxOf(workspaceId);
                      yield* store.putOutbox(
                        workspaceId,
                        encodeOutbox({
                          ...outbox,
                          workers: {
                            ...outbox.workers,
                            [worker.thread.id]: {
                              ...outbox.workers[worker.thread.id]!,
                              userIntervened: true,
                            },
                          },
                        }),
                      );
                    }
                    if (change === "autonomy")
                      yield* orchestration.setCharter(workspaceId, {
                        ...DEFAULT_CHARTER,
                        autonomy: "publish",
                      });
                    if (change === "ownership")
                      yield* store.updateThread(worker.thread.id, (t) => ({
                        ...t,
                        spawnedBy: {
                          ...t.spawnedBy!,
                          threadId: "foreign-orchestrator" as typeof thread.id,
                        },
                      }));
                    if (change === "slot")
                      yield* store.updateWorkspace(workspaceId, (s) => ({
                        ...s,
                        workspace: {
                          ...s.workspace,
                          orchestratorThreadId: "foreign-orchestrator" as typeof thread.id,
                        },
                      }));
                    return asked;
                  }).pipe(Effect.provideService(ThreadStore, store), Effect.orDie),
              },
            ],
            worker.thread.id,
            { approve: () => Effect.die("unexpected approval") },
          )[0]!;
          const refused = yield* tool
            .run({ threadId: thread.id, text: "Coordinate.", clientRequestId: "racy-send" })
            .pipe(Effect.flip);
          expect(refused.message).toMatch(
            change === "pause"
              ? /^paused:/
              : change === "hold"
                ? /^user_intervened:/
                : /^no_authority:/,
          );
          expect((yield* runtimes.snapshot).find((s) => s.thread.id === thread.id)?.queue).toEqual(
            [],
          );
          expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          expect((yield* outboxOf(workspaceId)).sentRequests).toBeUndefined();
        }),
      ),
  );
  it.effect("sameparent rejects unrelated targets with actual per-call cards in Bypass", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { worker, tool, workspaceId, thread } = yield* setup(world);
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const plain = yield* runtimes.create({
          projectRoot: world.repo,
          checkout: { kind: "main", path: world.repo },
          workspaceId,
          title: "Independent user thread",
        });
        const state = yield* store.getWorkspace(workspaceId);
        const foreignId = "foreign-workspace" as typeof workspaceId;
        yield* store.putWorkspace({
          ...state,
          workspace: {
            ...state.workspace,
            id: foreignId,
            name: "Foreign workspace",
            orchestratorThreadId: "foreign-parent" as typeof thread.id,
          },
        });
        const foreign = yield* runtimes.create({
          id: "foreign-parent" as typeof thread.id,
          projectRoot: world.repo,
          checkout: { kind: "main", path: world.repo },
          workspaceId: foreignId,
          role: "orchestrator",
          title: "Foreign orchestrator",
        });
        for (const target of [plain, foreign]) {
          const message = { threadId: target.id, text: "Coordinate." };
          expect(yield* tool.needsApproval!(message)).toBe(true);
          const pending = yield* tool.run(message).pipe(Effect.flip, Effect.forkScoped);
          const [card] = yield* waitReal(
            "the unrelated message card",
            store.listRequests(worker.thread.id).pipe(Effect.map((all) => all.length === 1 && all)),
          );
          expect(card).toMatchObject({ displayName: "send_message", scopes: ["once"] });
          yield* runtimes.respond(worker.thread.id, card!.id, {
            kind: "approval",
            decision: "deny",
            scope: "once",
          });
          expect((yield* Fiber.join(pending)).message).toContain("declined send_message");
        }
      }),
    ),
  );

  it.effect("sameparent preserves per-sender rate and two-hop refusal", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, worker, tool } = yield* setup(world);
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        for (let i = 0; i < 5; i++) {
          expect(
            yield* tool.run({ threadId: thread.id, text: `Context ${i}`, mode: "steer" }),
          ).toMatchObject({ delivered: "steered" });
          // Human context between messages preserves the ordinary back-to-back guard.
          yield* runtimes.send(thread.id, { text: `User context ${i}` });
        }
        expect(
          (yield* tool.run({ threadId: thread.id, text: "Sixth." }).pipe(Effect.flip)).message,
        ).toContain("5 messages a minute per thread");
        yield* runtimes.steer(worker.thread.id, {
          text: "Forwarded context.",
          origin: {
            threadId: "synthetic-sender" as typeof thread.id,
            title: "Other thread",
            depth: 2,
          },
        });
        expect(
          (yield* tool.run({ threadId: thread.id, text: "Forward again." }).pipe(Effect.flip))
            .message,
        ).toContain("messages stop after 2 hops");
        expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
      }),
    ),
  );

  it.effect("sameparent pauses and user holds refuse existing relationships and retries", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, worker, tool, workspaceId } = yield* setup(world);
        const orchestration = yield* Orchestration;
        const store = yield* ThreadStore;
        const message = {
          threadId: thread.id,
          text: "Coordinate.",
          clientRequestId: "parent-once",
        };
        expect(yield* tool.run(message)).toMatchObject({ delivered: "queued" });
        yield* orchestration.setPaused(workspaceId, true);
        expect(yield* tool.needsApproval!(message)).toBe(false);
        expect((yield* tool.run(message).pipe(Effect.flip)).message).toMatch(/^paused:/);
        yield* orchestration.setPaused(workspaceId, false);
        const outbox = yield* outboxOf(workspaceId);
        yield* store.putOutbox(
          workspaceId,
          encodeOutbox({
            ...outbox,
            workers: {
              ...outbox.workers,
              [worker.thread.id]: { ...outbox.workers[worker.thread.id]!, userIntervened: true },
            },
          }),
        );
        expect(yield* tool.needsApproval!(message)).toBe(false);
        expect((yield* tool.run(message).pipe(Effect.flip)).message).toMatch(/^user_intervened:/);
        expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
      }),
    ),
  );
});
