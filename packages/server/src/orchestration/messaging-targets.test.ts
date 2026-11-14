import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, AppToolError, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
  openOrchestrator,
  outboxOf,
  spawn,
  waitReal,
  waitStatus,
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
    const registry = yield* AppToolRegistry;
    return { thread, workspaceId, session, worker, registry };
  });

describe.skipIf(!hasGit)("message target validation", () => {
  it.effect.each(
    (["descriptor", "effective", "transport"] as const).flatMap((seam) =>
      (["full", "prefix"] as const).map((identity) => [seam, identity] as const),
    ),
  )("unknown targets fail before %s approval and deliver nothing", ([seam, identity]) =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, worker, registry } = yield* setup(world);
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const tool = (
          seam === "descriptor"
            ? registry.forThread(worker.thread.id, "worker")
            : registry.forTransport(worker.thread.id, "worker")
        ).find((candidate) => candidate.descriptor.name === "send_message")!;
        for (const id of [
          identity === "full" ? "00000000-0000-4000-8000-000000000001" : thread.id.slice(0, 8),
        ]) {
          const input = { threadId: id, text: "Coordinate." };
          let error: unknown;
          if (seam === "transport") {
            const attempted = yield* tool.run(input).pipe(Effect.flip, Effect.forkScoped);
            yield* waitReal(
              "message failure or card",
              Effect.gen(function* () {
                return (
                  (yield* store.listRequests(worker.thread.id)).length > 0 ||
                  (yield* Effect.sync(() => attempted.pollUnsafe() !== undefined))
                );
              }),
            );
            expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            error = yield* Fiber.join(attempted);
          } else {
            const result = yield* tool.needsApproval!(input).pipe(
              Effect.map((asked) =>
                seam === "effective" ? approvalFor(tool.descriptor.class, asked) : asked,
              ),
              Effect.match({ onFailure: (failure) => failure, onSuccess: (answer) => answer }),
            );
            error = result;
          }
          expect(error).toBeInstanceOf(AppToolError);
          expect((error as AppToolError).message).toContain(`This thread does not exist: ${id}`);
          expect((error as AppToolError).message).toContain("list_threads");
          expect((error as AppToolError).message).toContain("list_workers");
          expect((error as AppToolError).message).toContain("full threadId");
          expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          expect((yield* runtimes.snapshot).flatMap((s) => s.queue)).toEqual([]);
        }
      }),
    ),
  );
  it.effect(
    "message_orchestrator routes without an ID, preserves origins and shares retry records",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, workspaceId, session, worker, registry } = yield* setup(world);
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          yield* runtimes.send(thread.id, { text: "Coordinate." });
          yield* waitStatus(thread.id, "running");
          for (const audience of ["plain", "orchestrator"] as const)
            expect(
              registry
                .forTransport(thread.id, audience)
                .some((t) => t.descriptor.name === "message_orchestrator"),
            ).toBe(false);
          const tool = registry
            .forTransport(worker.thread.id, "worker")
            .find((t) => t.descriptor.name === "message_orchestrator")!;
          expect(tool.descriptor.class).toBe("crossThread");
          const message = {
            text: "Please clarify the API contract.",
            clientRequestId: "coordination-1",
          };
          for (const binding of [registry.forThread, registry.forSession, registry.forTransport]) {
            const bound = binding(worker.thread.id, "worker").find(
              (t) => t.descriptor.name === "message_orchestrator",
            )!;
            expect(approvalFor(bound.descriptor.class, yield* bound.needsApproval!(message))).toBe(
              "none",
            );
          }
          expect(yield* tool.run(message)).toMatchObject({
            threadId: thread.id,
            delivered: "steered",
          });
          for (let i = 0; i < 6; i++)
            expect(yield* tool.run(message)).toMatchObject({ repeated: true });
          const general = registry
            .forTransport(worker.thread.id, "worker")
            .find((t) => t.descriptor.name === "send_message")!;
          expect(yield* general.run({ ...message, threadId: thread.id })).toMatchObject({
            repeated: true,
          });
          expect(
            (yield* tool.run({ ...message, text: "Different text." }).pipe(Effect.flip)).message,
          ).toContain("already sent another message");
          expect(
            (yield* tool.run({ ...message, clientRequestId: "new-message" }).pipe(Effect.flip))
              .message,
          ).toContain("already came from this thread");
          // Steered into the orchestrator's running turn, once, as the worker's.
          expect((yield* runtimes.snapshot).find((s) => s.thread.id === thread.id)?.queue).toEqual(
            [],
          );
          const steered = session.steered.filter(
            (input) => input.origin?.threadId === worker.thread.id,
          );
          expect(steered).toHaveLength(1);
          expect(steered[0]).toMatchObject({
            origin: {
              threadId: worker.thread.id,
              title: worker.thread.title,
              depth: 2,
              mode: "steer",
            },
          });
          expect(steered[0]?.text).toContain(message.text);
          expect(steered[0]?.origin?.role).toBeUndefined();
          expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
          expect(Object.keys((yield* outboxOf(workspaceId)).sentRequests ?? {})).toHaveLength(1);
          expect(worker.session.options.instructions).toContain(
            "use `message_orchestrator` with `text`",
          );
          expect(worker.session.options.instructions).toContain("shortened IDs are refused");
          expect(worker.session.options.instructions).toContain("Prefer `report` for progress");
        }),
      ),
  );

  it.effect("message_orchestrator rejects client routing overrides before approval", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, worker, registry } = yield* setup(world);
        const store = yield* ThreadStore;
        const tool = registry
          .forTransport(worker.thread.id, "worker")
          .find((t) => t.descriptor.name === "message_orchestrator")!;
        for (const override of [
          { threadId: thread.id },
          { workspaceId: thread.workspaceId },
          { parent: { threadId: thread.id } },
          { mode: "steer" },
        ]) {
          const input = { text: "Coordinate.", ...override };
          expect((yield* tool.needsApproval!(input).pipe(Effect.flip)).message).toContain(
            "Invalid input",
          );
          expect((yield* tool.run(input).pipe(Effect.flip)).message).toContain("Invalid input");
        }
        expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
      }),
    ),
  );

  it.effect.each(["supervised", "publish"] as const)(
    "message_orchestrator at %s reaches the parent without a card in Bypass",
    (autonomy) =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, workspaceId, worker, registry } = yield* setup(world);
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const orchestration = yield* Orchestration;
          yield* runtimes.send(thread.id, { text: "Coordinate." });
          yield* waitStatus(thread.id, "running");
          yield* orchestration.setCharter(workspaceId, {
            ...DEFAULT_CHARTER,
            autonomy,
            workerMode: "bypassPermissions",
          });
          const tool = registry
            .forTransport(worker.thread.id, "worker")
            .find((t) => t.descriptor.name === "message_orchestrator")!;
          const input = { text: "Clarify the contract." };
          expect(yield* tool.needsApproval!(input)).toBe(false);
          expect(yield* tool.run(input)).toMatchObject({
            threadId: thread.id,
            delivered: "steered",
          });
          expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
        }),
      ),
  );

  it.effect(
    "message_orchestrator refuses stale membership, paused workspaces and held workers before approval",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, workspaceId, worker, registry } = yield* setup(world);
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const tool = registry
            .forTransport(worker.thread.id, "worker")
            .find((t) => t.descriptor.name === "message_orchestrator")!;
          const input = { text: "Coordinate." };
          const fails = (prefix: RegExp) =>
            Effect.gen(function* () {
              expect((yield* tool.needsApproval!(input).pipe(Effect.flip)).message).toMatch(prefix);
              expect((yield* tool.run(input).pipe(Effect.flip)).message).toMatch(prefix);
              expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
            });
          yield* orchestration.setPaused(workspaceId, true);
          yield* fails(/^paused:/);
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
          yield* fails(/^user_intervened:/);
          yield* store.putOutbox(workspaceId, encodeOutbox({ ...outbox, workers: {} }));
          yield* fails(/^no_authority:/);
          yield* store.putOutbox(workspaceId, encodeOutbox(outbox));
          yield* store.updateThread(worker.thread.id, (current) => {
            const { spawnedBy: _spawnedBy, ...detached } = current;
            return detached;
          });
          yield* fails(/^no_authority:/);
          yield* store.updateThread(worker.thread.id, () => worker.thread);
          yield* store.updateWorkspace(workspaceId, (s) => ({
            ...s,
            workspace: { ...s.workspace, orchestratorThreadId: "stale-parent" as ThreadId },
          }));
          yield* fails(/^no_authority:/);
          yield* store.updateWorkspace(workspaceId, (s) => ({
            ...s,
            workspace: { ...s.workspace, orchestratorThreadId: thread.id },
          }));
          yield* store.removeThread(thread.id);
          yield* fails(/^no_authority:/);
        }),
      ),
  );

  it.effect(
    "known dormant external targets still ask, and deletion during approval refuses delivery",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { worker, registry } = yield* setup(world);
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const external = yield* runtimes.create({
            projectRoot: world.repo,
            checkout: { kind: "main", path: world.repo },
            title: "Dormant user thread",
          });
          yield* waitStatus(external.id, "idle");
          const tool = registry
            .forTransport(worker.thread.id, "worker")
            .find((t) => t.descriptor.name === "send_message")!;
          const input = { threadId: external.id, text: "Coordinate." };
          expect(yield* tool.needsApproval!(input)).toBe(true);
          const pending = yield* tool.run(input).pipe(Effect.flip, Effect.forkScoped);
          const [card] = yield* waitReal(
            "valid external target approval",
            store.listRequests(worker.thread.id).pipe(Effect.map((all) => all.length === 1 && all)),
          );
          expect(card).toMatchObject({ displayName: "send_message", scopes: ["once"] });
          yield* store.removeThread(external.id);
          yield* runtimes.respond(worker.thread.id, card!.id, {
            kind: "approval",
            decision: "allow",
            scope: "once",
          });
          expect((yield* Fiber.join(pending)).message).toContain(
            `This thread does not exist: ${external.id}`,
          );
          expect((yield* runtimes.snapshot).flatMap((s) => s.queue)).toEqual([]);
        }),
      ),
  );

  it.effect.each(["deletion", "pause", "hold", "membership"] as const)(
    "message_orchestrator rechecks %s between approval query and Full Auto dispatch",
    (change) =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, worker, registry, workspaceId } = yield* setup(world);
          const store = yield* ThreadStore;
          const orchestration = yield* Orchestration;
          const definition = registry.definitions.find(
            (t) => t.descriptor.name === "message_orchestrator",
          )!;
          const tool = bindAppTools(
            [
              {
                ...definition,
                needsApproval: (caller, input, target) =>
                  Effect.gen(function* () {
                    const asked = yield* definition.needsApproval!(caller, input, target);
                    expect(asked).toBe(false);
                    if (change === "deletion") yield* store.removeThread(thread.id);
                    if (change === "pause") yield* orchestration.setPaused(workspaceId, true);
                    if (change === "hold" || change === "membership") {
                      const outbox = yield* outboxOf(workspaceId);
                      yield* store.putOutbox(
                        workspaceId,
                        encodeOutbox({
                          ...outbox,
                          workers:
                            change === "membership"
                              ? {}
                              : {
                                  ...outbox.workers,
                                  [worker.thread.id]: {
                                    ...outbox.workers[worker.thread.id]!,
                                    userIntervened: true,
                                  },
                                },
                        }),
                      );
                    }
                    return asked;
                  }).pipe(Effect.provideService(ThreadStore, store), Effect.orDie),
              },
            ],
            worker.thread.id,
            { approve: () => Effect.die("unexpected approval") },
          )[0]!;
          expect((yield* tool.run({ text: "Coordinate." }).pipe(Effect.flip)).message).toMatch(
            change === "pause"
              ? /^paused:/
              : change === "hold"
                ? /^user_intervened:/
                : /^no_authority:/,
          );
          expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
        }),
      ),
  );
  it.effect("message_orchestrator preserves the per-sender rate and two-hop guards", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, worker, registry } = yield* setup(world);
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        yield* runtimes.send(thread.id, { text: "Coordinate." });
        yield* waitStatus(thread.id, "running");
        const tool = registry
          .forTransport(worker.thread.id, "worker")
          .find((t) => t.descriptor.name === "message_orchestrator")!;
        for (let i = 0; i < 5; i++) {
          expect(yield* tool.run({ text: `Context ${i}` })).toMatchObject({ delivered: "steered" });
          yield* runtimes.send(thread.id, { text: `Human context ${i}` });
        }
        expect((yield* tool.run({ text: "Sixth." }).pipe(Effect.flip)).message).toContain(
          "5 messages a minute per thread",
        );
        yield* runtimes.steer(worker.thread.id, {
          text: "Forwarded message.",
          origin: {
            threadId: "synthetic-sender" as ThreadId,
            title: "Other thread",
            depth: 2,
          },
        });
        expect((yield* tool.run({ text: "Forward again." }).pipe(Effect.flip)).message).toContain(
          "messages stop after 2 hops",
        );
        expect(yield* store.listRequests(worker.thread.id)).toEqual([]);
      }),
    ),
  );
});
