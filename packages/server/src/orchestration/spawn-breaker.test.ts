import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  type AgentFailureKind,
  type MessageId,
  type ProfileId,
  type ThreadId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import type { FakeSession } from "../runtime/fake-agent.ts";
import { Orchestration, type HeldSpawn } from "./service.ts";
import { inServer } from "./service-kit.ts";
import { makeBreakerState, SPAWN_BREAKER_WINDOW_MS, tripsSpawnBreaker } from "./spawn-breaker.ts";
import {
  makeWorld,
  withServer,
  atAutonomy,
  openOrchestrator,
  outboxOf,
  settle,
  spawn,
  waitReal,
  waitSent,
} from "./test-harness.ts";

const MODEL = { agent: "claude", model: "fake-opus" } as const;
const call = (session: FakeSession, feature: string, extra: Record<string, unknown> = {}) =>
  session.callTool("spawn_worker", {
    project: "shop",
    feature,
    title: feature,
    brief: `Build ${feature}`,
    ...extra,
  }) as Effect.Effect<HeldSpawn | { threadId: ThreadId }, unknown>;
const fail = (session: FakeSession, id: ThreadId, kind: AgentFailureKind = "network") =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* session.emit({
      type: "turnEnd",
      reason: "error",
      error: "Synthetic provider unavailable",
      failure: { kind, retryable: true },
    });
    yield* waitReal(
      "the failed turn",
      store.getThread(id).pipe(Effect.map((thread) => thread.lastError?.kind === kind)),
    );
    yield* settle;
  });
const progress = (session: FakeSession, messageId = "recovery") =>
  session.emit(
    { type: "chunk", messageId: messageId as MessageId, chunk: { type: "start" } },
    { type: "chunk", messageId: messageId as MessageId, chunk: { type: "text-start", id: "text" } },
    {
      type: "chunk",
      messageId: messageId as MessageId,
      chunk: { type: "text-delta", id: "text", delta: "Model reached" },
    },
  );
const threadsOn = (feature: string) =>
  Effect.gen(function* () {
    return (yield* (yield* ThreadStore).listThreads).filter(
      (thread) => thread.spawnedBy?.feature === feature,
    );
  });

describe("spawn breaker state", () => {
  it("trips only on launch failures, and isolates models/profiles while sharing effort", () => {
    const state = makeBreakerState();
    for (const kind of ["rateLimit", "gatewayRefused", "costGuard", "unknown"] as const) {
      state.fail({ model: MODEL, kind, at: 100 });
      expect(state.failure(MODEL)).toBeUndefined();
      expect(tripsSpawnBreaker(kind)).toBe(false);
    }
    for (const kind of ["auth", "modelUnavailable", "network"] as const) {
      state.fail({ model: MODEL, kind, at: 100 });
      expect(state.failure({ ...MODEL, variant: "high" })?.kind).toBe(kind);
      expect(state.failure({ ...MODEL, model: "fake-haiku" })).toBeUndefined();
      expect(state.failure({ ...MODEL, profileId: "gateway" as ProfileId })).toBeUndefined();
      expect(state.probeAt(MODEL, 200)).toBe(100 + SPAWN_BREAKER_WINDOW_MS);
      state.clear(MODEL);
    }
  });
  it("admits one probe per window until output clears it", () => {
    const state = makeBreakerState();
    state.fail({ model: MODEL, kind: "network", at: 100 });
    const at = 100 + SPAWN_BREAKER_WINDOW_MS;
    expect(state.probeAt(MODEL, at)).toBe(at);
    state.claim(MODEL, at);
    expect(state.probeAt(MODEL, at)).toBe(at + SPAWN_BREAKER_WINDOW_MS);
    state.fail({ model: MODEL, kind: "auth", at: at + 1 });
    expect(state.probeAt(MODEL, at + 2)).toBe(at + 1 + SPAWN_BREAKER_WINDOW_MS);
    expect(state.clear(MODEL)).toBe(true);
    expect(state.failure(MODEL)).toBeUndefined();
  });
});

describe.skipIf(!hasGit)("spawn circuit breaker through held briefs", () => {
  it.effect(
    "holds a burst without worktrees, deduplicates, lists clear models, and resets on output before turn end",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* atAutonomy(thread, "full", {
            maxConcurrentWorkers: 8,
            workerModels: [
              { ...MODEL, default: true },
              { agent: "claude", model: "fake-haiku", useFor: "small chores" },
            ],
          });
          const healthy = yield* spawn(session, { feature: "healthy" });
          yield* progress(healthy.session, "early-output");
          const failed = yield* spawn(session, { feature: "failed" });
          yield* fail(failed.session, failed.thread.id);
          const held = (yield* call(session, "first", { clientRequestId: "first" })) as HeldSpawn;
          expect(held).toMatchObject({
            held: true,
            alternatives: [{ model: "claude:fake-haiku", useFor: "small chores" }],
          });
          expect(held.note).toContain("network without output at");
          expect(held.note).toContain(
            new Date(
              (yield* (yield* ThreadStore).getThread(failed.thread.id)).lastError!.at,
            ).toISOString(),
          );
          expect(yield* call(session, "first", { clientRequestId: "first" })).toMatchObject({
            id: held.id,
          });
          yield* call(session, "second");
          expect(yield* threadsOn("first")).toHaveLength(0);
          expect(yield* threadsOn("second")).toHaveLength(0);
          expect((yield* outboxOf(workspaceId)).heldBriefs).toHaveLength(2);
          // Another model on the same agent cannot clear this model's breaker.
          const other = yield* spawn(session, { feature: "other", model: "claude:fake-haiku" });
          yield* other.session.completeTurn();
          yield* settle;
          expect(yield* threadsOn("first")).toHaveLength(0);
          // User input always reaches an existing thread even while orchestrator spawns wait.
          yield* (yield* ThreadRuntimes).send(failed.thread.id, { text: "Try the repaired login" });
          yield* waitSent(failed.thread.id, 2);
          yield* progress(healthy.session, "later-output");
          yield* waitReal(
            "both briefs released on first output",
            Effect.gen(function* () {
              return (
                (yield* threadsOn("first")).length === 1 &&
                (yield* threadsOn("second")).length === 1
              );
            }),
          );
          expect(yield* (yield* ThreadRuntimes).status(failed.thread.id)).toBe("running");
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "after the cooldown starts one probe, re-trips a failed probe, and releases the rest on recovery",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { session, workspaceId } = yield* openOrchestrator(world);
          const failed = yield* spawn(session, { feature: "failed" });
          yield* fail(failed.session, failed.thread.id, "auth");
          yield* call(session, "probe");
          yield* call(session, "waiting");
          const orchestration = yield* Orchestration;
          const store = yield* ThreadStore;
          const owner = (yield* store.getWorkspace(workspaceId)).workspace.orchestratorThreadId!;
          yield* (yield* ThreadRuntimes).close(owner);
          yield* settle;
          const workspace = yield* store.getWorkspace(workspaceId);
          yield* orchestration.setCharter(workspaceId, {
            ...workspace.charter,
            orchestratorModel: { agent: "claude", model: "fake-haiku" },
            workerModels: [{ ...failed.thread.model, default: true }],
          });
          const replacement = yield* orchestration.open({ workspaceId });
          const replacementSession = yield* waitSent(replacement.id, 1);
          yield* replacementSession.completeTurn();
          yield* settle;
          yield* TestClock.adjust(SPAWN_BREAKER_WINDOW_MS);
          yield* waitReal(
            "one canary",
            Effect.gen(function* () {
              return (yield* threadsOn("probe"))[0];
            }),
          );
          const probe = (yield* threadsOn("probe"))[0]!;
          const probeSession = yield* waitSent(probe.id, 1);
          expect(yield* threadsOn("waiting")).toHaveLength(0);
          yield* fail(probeSession, probe.id, "modelUnavailable");
          yield* TestClock.adjust(SPAWN_BREAKER_WINDOW_MS);
          yield* waitReal(
            "the next single canary",
            Effect.gen(function* () {
              return (yield* threadsOn("waiting"))[0];
            }),
          );
          const recovered = (yield* threadsOn("waiting"))[0]!;
          const recoveredSession = yield* waitSent(recovered.id, 1);
          const held = (yield* call(replacementSession, "last")) as HeldSpawn;
          expect(held.held).toBe(true);
          yield* progress(recoveredSession);
          yield* waitReal(
            "the final brief",
            Effect.gen(function* () {
              return (yield* threadsOn("last")).length === 1;
            }),
          );
          expect((yield* outboxOf(workspaceId)).heldBriefs ?? []).toHaveLength(0);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "a failure after output and a limit failure do not trip; held briefs can be retargeted or cancelled",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* atAutonomy(thread, "full", {
            ...DEFAULT_CHARTER,
            workerModels: [
              { ...MODEL, default: true },
              { agent: "claude", model: "fake-haiku" },
            ],
          });
          const productive = yield* spawn(session, { feature: "productive" });
          yield* progress(productive.session);
          yield* fail(productive.session, productive.thread.id);
          const limited = yield* spawn(session, { feature: "limited" });
          yield* fail(limited.session, limited.thread.id, "costGuard");
          const failed = yield* spawn(session, { feature: "failed" });
          yield* fail(failed.session, failed.thread.id);
          const held = (yield* call(session, "retarget")) as HeldSpawn;
          const orchestration = yield* Orchestration;
          yield* orchestration.manageHeldSpawn(thread.id, {
            id: held.id,
            action: "retarget",
            model: "claude:fake-haiku",
          });
          yield* waitReal(
            "retargeted brief",
            Effect.gen(function* () {
              return (yield* threadsOn("retarget"))[0]?.model.model === "fake-haiku";
            }),
          );
          const cancelled = (yield* call(session, "cancel")) as HeldSpawn;
          yield* orchestration.manageHeldSpawn(thread.id, { id: cancelled.id, action: "cancel" });
          expect((yield* outboxOf(workspaceId)).heldBriefs ?? []).toHaveLength(0);
          expect(yield* threadsOn("cancel")).toHaveLength(0);
          expect(yield* Clock.currentTimeMillis).toBeLessThan(SPAWN_BREAKER_WINDOW_MS);
        }),
      ),
    { timeout: 90_000 },
  );
  it.effect(
    "persists both a trip and its recovery across server restarts",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const { thread, session, workspaceId } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "failed" });
            yield* fail(worker.session, worker.thread.id);
            const held = (yield* call(session, "restart-held")) as HeldSpawn;
            expect(held.held).toBe(true);
            yield* waitReal(
              "the persisted trip",
              outboxOf(workspaceId).pipe(
                Effect.map((outbox) =>
                  outbox.spawnBreakers?.some((record) => record.cleared !== true),
                ),
              ),
            );
            return { ownerId: thread.id, workspaceId, workerId: worker.thread.id };
          }),
        );
        yield* withServer(
          world,
          Effect.gen(function* () {
            expect(yield* threadsOn("restart-held")).toHaveLength(0);
            const orchestration = yield* Orchestration;
            expect(
              yield* orchestration.spawnWorker(first.ownerId, {
                project: "shop",
                feature: "also-held",
                title: "also-held",
                brief: "Build this",
              }),
            ).toHaveProperty("held", true);
            yield* (yield* ThreadRuntimes).send(first.workerId, { text: "Login repaired" });
            const repaired = yield* waitSent(first.workerId, 1);
            yield* progress(repaired);
            yield* waitReal(
              "held briefs released after restart",
              Effect.gen(function* () {
                return (
                  (yield* threadsOn("restart-held")).length === 1 &&
                  (yield* threadsOn("also-held")).length === 1
                );
              }),
            );
            yield* waitReal(
              "persisted recovery",
              outboxOf(first.workspaceId).pipe(
                Effect.map((outbox) =>
                  outbox.spawnBreakers?.every((record) => record.cleared === true),
                ),
              ),
            );
          }),
        );
        yield* withServer(
          world,
          Effect.gen(function* () {
            const result = yield* (yield* Orchestration).spawnWorker(first.ownerId, {
              project: "shop",
              feature: "after-recovery",
              title: "after-recovery",
              brief: "Build this",
            });
            expect(result).toHaveProperty("threadId");
            expect(result).not.toHaveProperty("held");
          }),
        );
      }),
    { timeout: 90_000 },
  );
});
