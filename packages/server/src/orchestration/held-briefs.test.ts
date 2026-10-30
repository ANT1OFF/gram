import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  LIMIT_PAUSE_TOOL,
  type OrchestrationDigest,
  type OrchestratorCharter,
  type Thread,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadPlans } from "../plans/service.ts";
import { FakeAgentControl, type FakeSession } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { LIMIT_CLEARED_TEXT, LIMIT_RESUME_BATCH_GAP_MS } from "../runtime/limit-wait.ts";
import { HELD_RETRY_MS, refusalPasses } from "./limit-pause.ts";
import { Orchestration, type HeldSpawn } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  outboxOf,
  settle,
  spawn,
  waitReal,
  waitSent,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

// Holding low-priority briefs until a usage limit resets (One thread buildout, "Limit forecast"):
// through the orchestrator's own `spawn_worker` and the fake agent's real `rateLimit` path.

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

const HOUR = 3_600_000;

/** The orchestrator's agent reports its 5-hour window at `utilization`, resetting in an hour. */
const report = (session: FakeSession, utilization: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const resetsAt = now + HOUR;
    yield* session.emit({
      type: "rateLimit",
      status: utilization >= 0.8 ? "warning" : "allowed",
      window: "five_hour",
      utilization,
      resetsAt,
    });
    const readings = yield* UsageLimitReadings;
    yield* waitReal(
      `the ${utilization} reading`,
      readings.current.pipe(
        Effect.map((all) => all.some((each) => each.utilization === utilization)),
      ),
    );
    return resetsAt;
  });

const lowCall = (session: FakeSession, feature: string, extra: Record<string, unknown> = {}) =>
  session.callTool("spawn_worker", {
    project: "shop",
    feature,
    title: `Build ${feature}`,
    brief: `Do the ${feature} work.`,
    priority: "low",
    ...extra,
  }) as Effect.Effect<HeldSpawn | { readonly threadId: ThreadId }, unknown>;

/** The workspace's workers on `feature`. */
const workersOn = (workspaceId: WorkspaceId, feature: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listThreads).filter(
      (thread: Thread) =>
        thread.workspaceId === workspaceId && thread.spawnedBy?.feature === feature,
    );
  });

/**
 * Sets the workspace's charter and returns the orchestrator's session once it is idle on it: a
 * charter that changes its instructions reopens the session, and tools go through the new one.
 */
const rechartered = (threadId: ThreadId, workspaceId: WorkspaceId, charter: OrchestratorCharter) =>
  Effect.gen(function* () {
    const orchestration = yield* Orchestration;
    const fake = yield* FakeAgentControl;
    const runtimes = yield* ThreadRuntimes;
    yield* orchestration.setCharter(workspaceId, charter);
    yield* settle;
    const current = yield* waitReal(
      "the orchestrator's session on the new charter",
      Effect.sync(() => fake.sessions.filter((each) => each.options.threadId === threadId).at(-1)),
    );
    for (let i = 0; i < 10 && (yield* runtimes.status(threadId)) !== "idle"; i++) {
      if ((yield* runtimes.status(threadId)) === "running") yield* current.completeTurn();
      yield* settle;
    }
    return current;
  });

/** The workspace opted into holding at 80% (`pauseAtLimitPct`): a share alone holds nothing without it. */
const optedIn = (threadId: ThreadId, workspaceId: WorkspaceId) =>
  rechartered(threadId, workspaceId, { ...DEFAULT_CHARTER, pauseAtLimitPct: 80 });

/**
 * A normal brief spawned at the opted-in threshold: the pause card it raises is answered "keep
 * going", as the user would to let urgent work through.
 */
const spawnPast = (
  orchestratorId: ThreadId,
  session: FakeSession,
  input: { readonly feature: string } & Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const call = yield* spawn(session, input).pipe(Effect.forkScoped);
    for (let i = 0; i < 200; i++) {
      const card = (yield* store.listRequests(orchestratorId)).find(
        (request) => request.kind === "approval" && request.toolName === LIMIT_PAUSE_TOOL,
      );
      if (card !== undefined) {
        yield* runtimes.respond(orchestratorId, card.id, {
          kind: "approval",
          decision: "allow",
          scope: "once",
        });
        break;
      }
      if (call.pollUnsafe() !== undefined) break;
      yield* settle;
    }
    return yield* Fiber.join(call);
  });

describe.skipIf(!hasGit)("holding low-priority briefs near a limit", () => {
  it.effect(
    "spawns a low-priority brief at a full window when the workspace set no threshold",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { session, workspaceId } = yield* openOrchestrator(world);
          // 100% of the window, but no refusal: credits may carry the agent on past it.
          yield* report(session, 1);
          // Before: held at the default 80%.
          const spawned = yield* lowCall(session, "chores");
          expect("held" in spawned).toBe(false);
          expect(yield* workersOn(workspaceId, "chores")).toHaveLength(1);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "holds a low-priority brief on a real refusal and starts it when a turn on the agent goes through",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const fake = yield* FakeAgentControl;
          const readings = yield* UsageLimitReadings;
          const { thread, session, workspaceId } = yield* openOrchestrator(world);
          const now = yield* Clock.currentTimeMillis;
          yield* session.emit({
            type: "rateLimit",
            status: "rejected",
            window: "five_hour",
            resetsAt: now + HOUR,
          });
          yield* waitReal(
            "the refusal",
            readings.current.pipe(
              Effect.map((all) => all.some((each) => each.status === "rejected")),
            ),
          );
          const held = yield* lowCall(session, "later");
          expect("held" in held && held.held).toBe(true);

          // The user's own word on the orchestrator goes through, and its turn completes.
          yield* TestClock.adjust("1 minute");
          yield* runtimes.send(thread.id, { text: "carry on" });
          const current = yield* waitReal(
            "the orchestrator's turn",
            Effect.sync(() =>
              fake.sessions
                .filter((each) => each.options.threadId === thread.id)
                .find((each) => each.sent.some((input) => input.text === "carry on")),
            ),
          );
          yield* current.completeTurn();
          yield* settle;
          // Well before the reset an hour on, the brief starts.
          const [worker] = yield* waitReal(
            "the held brief's worker",
            workersOn(workspaceId, "later").pipe(Effect.map((found) => found.length > 0 && found)),
          );
          expect(worker!.title).toBe("Build later");
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "cancels held spawns through the orchestrator tool and never starts them at reset",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* optedIn(thread.id, workspaceId);
          const resetsAt = yield* report(session, 0.9);
          const held = (yield* lowCall(session, "cancel-me", {
            clientRequestId: "cancel-me",
          })) as HeldSpawn;
          const registry = yield* AppToolRegistry;
          const definition = registry.definitions.find(
            (tool) => tool.descriptor.name === "manage_held_spawn",
          )!;
          const input = { id: held.id, action: "cancel" };
          // Direct handler calls cannot bypass current owning-orchestrator authority.
          expect(
            (yield* definition.handle("not-owner" as ThreadId, input, {}).pipe(Effect.flip))
              .message,
          ).toContain("owning orchestrator");
          expect((yield* outboxOf(workspaceId)).heldBriefs).toHaveLength(1);
          expect(yield* session.callTool("manage_held_spawn", input)).toEqual({
            id: held.id,
            cancelled: true,
            held: false,
          });
          expect((yield* orchestration.ledger(workspaceId)).held).toBeUndefined();
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
          expect(
            (yield* session.callTool("manage_held_spawn", input).pipe(Effect.flip)).message,
          ).toContain("may have started already");
          yield* TestClock.adjust(resetsAt - (yield* Clock.currentTimeMillis));
          yield* settle;
          expect(yield* workersOn(workspaceId, "cancel-me")).toEqual([]);
          expect(
            registry
              .forThread(thread.id, "worker")
              .some((tool) => tool.descriptor.name === "manage_held_spawn"),
          ).toBe(false);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "lets a replacement orchestrator manage workspace-held briefs but refuses its stale predecessor",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const runtimes = yield* ThreadRuntimes;
          const registry = yield* AppToolRegistry;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* optedIn(thread.id, workspaceId);
          yield* report(session, 0.9);
          const held = (yield* lowCall(session, "replacement")) as HeldSpawn;
          yield* runtimes.close(thread.id);
          yield* settle;
          const replacement = yield* orchestration.open({ workspaceId });
          expect(replacement.id).not.toBe(thread.id);
          const replacementSession = yield* waitSent(replacement.id, 1);
          yield* replacementSession.completeTurn();
          const input = { id: held.id, action: "cancel" };
          const definition = registry.definitions.find(
            (tool) => tool.descriptor.name === "manage_held_spawn",
          )!;
          expect(
            (yield* definition.handle(thread.id, input, {}).pipe(Effect.flip)).message,
          ).toContain("owning orchestrator");
          expect(yield* replacementSession.callTool("manage_held_spawn", input)).toEqual({
            id: held.id,
            cancelled: true,
            held: false,
          });
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "retargets held spawns to a configured provider, preserving plan and retry identity",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const store = yield* ThreadStore;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          yield* store.updateSettings((settings) => ({
            ...settings,
            agents: {
              ...settings.agents,
              customModels: [{ agent: "codex", id: "gpt-5.5-direct" }],
            },
          }));
          const session = yield* rechartered(thread.id, workspaceId, {
            ...DEFAULT_CHARTER,
            pauseAtLimitPct: 80,
            workerModels: [
              { agent: "claude", model: "fake-opus", default: true },
              { agent: "codex", model: "gpt-5.5-direct" },
            ],
          });
          yield* report(session, 0.9);
          const held = (yield* lowCall(session, "retarget", {
            clientRequestId: "retarget-request",
            plan: ["Implement", "Verify"],
          })) as HeldSpawn;
          expect(held.held).toBe(true);
          expect(
            (yield* session
              .callTool("manage_held_spawn", {
                id: held.id,
                action: "retarget",
                model: "unconfigured",
              })
              .pipe(Effect.flip)).message,
          ).toContain("doesn't allow workers");
          expect((yield* outboxOf(workspaceId)).heldBriefs?.[0]?.input.model).toBeUndefined();
          // A feature pause remains effective even though the selected provider has no limit.
          yield* orchestration.setFeaturePaused(workspaceId, "retarget", true);
          expect(
            yield* session.callTool("manage_held_spawn", {
              id: held.id,
              action: "retarget",
              model: "codex:gpt-5.5-direct",
            }),
          ).toMatchObject({ id: held.id, retargeted: true, model: "codex:gpt-5.5-direct" });
          yield* settle;
          expect(yield* workersOn(workspaceId, "retarget")).toEqual([]);
          expect((yield* outboxOf(workspaceId)).heldBriefs?.[0]?.input).toMatchObject({
            clientRequestId: "retarget-request",
            plan: ["Implement", "Verify"],
            model: "codex:gpt-5.5-direct",
          });
          yield* orchestration.setFeaturePaused(workspaceId, "retarget", false);
          const [worker] = yield* waitReal(
            "the retargeted worker",
            workersOn(workspaceId, "retarget").pipe(
              Effect.map((workers) => workers.length === 1 && workers),
            ),
          );
          yield* waitSent(worker!.id, 1);
          expect(worker!.model).toMatchObject({ agent: "codex", model: "gpt-5.5-direct" });
          expect(
            (yield* (yield* ThreadPlans).get(worker!.id))?.steps.map((step) => step.text),
          ).toEqual(["Implement", "Verify"]);
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
          expect(
            yield* lowCall(session, "retarget", { clientRequestId: "retarget-request" }),
          ).toMatchObject({ threadId: worker!.id });
          expect(yield* workersOn(workspaceId, "retarget")).toHaveLength(1);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "retargeting rechecks destination limits and refuses missing model or workspace pause",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* rechartered(thread.id, workspaceId, {
            ...DEFAULT_CHARTER,
            pauseAtLimitPct: 80,
            workerModels: [
              { agent: "claude", model: "fake-opus", default: true },
              { agent: "claude", model: "fake-haiku" },
            ],
          });
          yield* report(session, 0.9);
          const held = (yield* lowCall(session, "still-limited")) as HeldSpawn;
          expect(
            (yield* session
              .callTool("manage_held_spawn", { id: held.id, action: "retarget" })
              .pipe(Effect.flip)).message,
          ).toContain("model is required");
          yield* session.callTool("manage_held_spawn", {
            id: held.id,
            action: "retarget",
            model: "fake-haiku",
          });
          expect((yield* outboxOf(workspaceId)).heldBriefs?.[0]).toMatchObject({
            id: held.id,
            until: held.until,
            input: { model: "claude:fake-haiku" },
          });
          yield* orchestration.setPaused(workspaceId, true);
          expect(
            (yield* orchestration
              .manageHeldSpawn(thread.id, { id: held.id, action: "cancel" })
              .pipe(Effect.flip)).message,
          ).toContain("paused");
          expect((yield* outboxOf(workspaceId)).heldBriefs).toHaveLength(1);
          expect(yield* workersOn(workspaceId, "still-limited")).toEqual([]);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "holds a low-priority brief at the opted-in 80%, spawns the rest, and releases it at the reset",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const runtimes = yield* ThreadRuntimes;
          const fake = yield* FakeAgentControl;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* optedIn(thread.id, workspaceId);

          // Below the share a low-priority brief spawns as any other.
          yield* report(session, 0.5);
          const early = yield* lowCall(session, "early");
          expect("held" in early).toBe(false);

          const resetsAt = yield* report(session, 0.85);
          const held = (yield* lowCall(session, "docs-refresh", {
            clientRequestId: "docs-1",
          })) as HeldSpawn;
          expect(held).toMatchObject({
            held: true,
            feature: "docs-refresh",
            title: "Build docs-refresh",
            project: "shop",
            until: resetsAt,
          });
          expect(held.note).toMatch(/^Held, not spawned: .*'s 5-hour limit is at 85%/);
          expect(yield* workersOn(workspaceId, "docs-refresh")).toEqual([]);

          // A retry finds the brief it held; nothing is held twice.
          const again = (yield* lowCall(session, "docs-refresh", {
            clientRequestId: "docs-1",
          })) as HeldSpawn;
          expect(again.id).toBe(held.id);
          expect((yield* outboxOf(workspaceId)).heldBriefs).toHaveLength(1);

          // A normal brief at the same share is spawned once the user lets it through.
          const urgent = yield* spawnPast(thread.id, session, { feature: "urgent" });
          expect(urgent.thread.spawnedBy?.feature).toBe("urgent");

          // The ledger and the feature card show it held, with its reset.
          const ledger = yield* orchestration.ledger(workspaceId);
          expect(ledger.held).toEqual([
            {
              id: held.id,
              feature: "docs-refresh",
              title: "Build docs-refresh",
              project: "shop",
              agent: thread.model.agent,
              window: "fiveHour",
              usedPct: 85,
              until: resetsAt,
              heldAt: expect.any(Number),
            },
          ]);
          const card = (yield* orchestration.featureCards(workspaceId)).cards.find(
            (each) => each.feature === "docs-refresh",
          );
          expect(card).toMatchObject({
            station: "briefed",
            workers: [],
            held: [{ id: held.id, usedPct: 85, until: resetsAt, window: "fiveHour" }],
          });

          // Take the digests the spawns woke, so the orchestrator is idle for the next.
          const sessionsOf = (id: ThreadId) =>
            fake.sessions.filter((each) => each.options.threadId === id);
          const takeTurns = Effect.gen(function* () {
            yield* settle;
            for (let i = 0; i < 10 && (yield* runtimes.status(thread.id)) === "running"; i++) {
              yield* sessionsOf(thread.id).at(-1)!.completeTurn();
              yield* settle;
            }
          });
          yield* TestClock.adjust("5 minutes");
          yield* takeTurns;

          // At the reset it spawns on its own, and the orchestrator is told.
          // Moved to the reset itself, not past it: the spawn's git runs on the same clock.
          yield* TestClock.adjust(resetsAt - (yield* Clock.currentTimeMillis));
          yield* settle;
          const [released] = yield* waitReal(
            "the held brief's worker",
            workersOn(workspaceId, "docs-refresh").pipe(
              Effect.map((found) => found.length > 0 && found),
            ),
          );
          yield* waitSent(released!.id, 1);
          expect(released!.title).toBe("Build docs-refresh");
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
          expect((yield* orchestration.ledger(workspaceId)).held).toBeUndefined();
          const spawnedNote = (input: (typeof session.sent)[number]) =>
            (input.notice as OrchestrationDigest | undefined)?.notes?.some((note) =>
              note.includes("The held brief “Build docs-refresh” (docs-refresh) was spawned as"),
            ) === true;
          for (
            let i = 0;
            i < 6 &&
            sessionsOf(thread.id)
              .flatMap((each) => each.sent)
              .find(spawnedNote) === undefined;
            i++
          ) {
            yield* takeTurns;
            yield* TestClock.adjust("5 minutes");
            yield* settle;
          }
          expect(
            sessionsOf(thread.id)
              .flatMap((each) => each.sent)
              .find(spawnedNote),
          ).toBeDefined();
          // The card lost its held line and carries the worker now.
          const after = (yield* orchestration.featureCards(workspaceId)).cards.find(
            (each) => each.feature === "docs-refresh",
          );
          expect(after?.held).toBeUndefined();
          expect(after?.workers.map((each) => each.threadId)).toEqual([released!.id]);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "lets the user release a held brief now, with its plan, and refuses a second release",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const plans = yield* ThreadPlans;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* optedIn(thread.id, workspaceId);
          yield* report(session, 0.9);
          const held = (yield* lowCall(session, "cleanup", {
            plan: ["remove dead code", "run the suite"],
          })) as HeldSpawn;
          expect(held.held).toBe(true);

          const worker = yield* orchestration.releaseHeldBrief(workspaceId, held.id);
          expect(worker.spawnedBy?.feature).toBe("cleanup");
          yield* waitSent(worker.id, 1);
          expect((yield* orchestration.ledger(workspaceId)).held).toBeUndefined();
          expect((yield* outboxOf(workspaceId)).notes).toContainEqual(
            expect.stringContaining("was spawned by the user, before the reset"),
          );
          const plan = yield* plans.get(worker.id);
          expect(plan?.steps.map((step) => step.text)).toEqual([
            "remove dead code",
            "run the suite",
          ]);

          const twice = yield* orchestration
            .releaseHeldBrief(workspaceId, held.id)
            .pipe(Effect.flip);
          expect(twice._tag).toBe("InvalidState");
          expect(yield* workersOn(workspaceId, "cleanup")).toHaveLength(1);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "keeps a held brief through a reset while orchestration is paused, until it resumes",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* optedIn(thread.id, workspaceId);
          const resetsAt = yield* report(session, 0.88);
          const held = (yield* lowCall(session, "nightly")) as HeldSpawn;
          expect(held.held).toBe(true);
          yield* orchestration.setPaused(workspaceId, true);
          yield* settle;
          yield* TestClock.adjust(resetsAt - (yield* Clock.currentTimeMillis));
          yield* settle;
          // Due, but paused: still held, and nothing spawned.
          expect((yield* outboxOf(workspaceId)).heldBriefs?.map((each) => each.id)).toEqual([
            held.id,
          ]);
          expect(yield* workersOn(workspaceId, "nightly")).toEqual([]);

          yield* orchestration.setPaused(workspaceId, false);
          const [worker] = yield* waitReal(
            "the held brief's worker after the resume",
            workersOn(workspaceId, "nightly").pipe(
              Effect.map((found) => found.length > 0 && found),
            ),
          );
          yield* waitSent(worker!.id, 1);
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "holds at the workspace's pause threshold when it sets one, before the pause asks",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const current = yield* rechartered(thread.id, workspaceId, {
            ...DEFAULT_CHARTER,
            autonomy: "publish",
            pauseAtLimitPct: 95,
          });
          // Past the default 80% but under the workspace's 95%, a low-priority brief spawns.
          yield* report(current, 0.9);
          const spawned = yield* lowCall(current, "under");
          expect("held" in spawned).toBe(false);
          // Past 95% it is held, and no pause card is raised for it.
          yield* report(current, 0.96);
          const held = yield* lowCall(current, "over");
          expect("held" in held && held.held).toBe(true);
          const cards = (yield* store.listRequests(thread.id)).filter(
            (request) => request.kind === "approval",
          );
          expect(cards).toEqual([]);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "keeps a due brief held while every worker slot is taken, refuses Release now, and starts it once one frees",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* rechartered(thread.id, workspaceId, {
            ...DEFAULT_CHARTER,
            pauseAtLimitPct: 80,
            maxConcurrentWorkers: 1,
          });
          const resetsAt = yield* report(session, 0.85);
          const held = (yield* lowCall(session, "later")) as HeldSpawn;
          expect(held.held).toBe(true);
          // A normal brief takes the one slot.
          const busy = yield* spawnPast(thread.id, session, { feature: "busy" });

          yield* TestClock.adjust(resetsAt - (yield* Clock.currentTimeMillis));
          const [waiting] = yield* waitReal(
            "the brief waiting for a slot",
            outboxOf(workspaceId).pipe(
              Effect.map(
                (outbox) => outbox.heldBriefs?.[0]?.waitsForSlot === true && outbox.heldBriefs,
              ),
            ),
          );
          expect(waiting).toMatchObject({ id: held.id, retryAt: resetsAt + HELD_RETRY_MS });
          expect(yield* workersOn(workspaceId, "later")).toEqual([]);
          expect((yield* orchestration.ledger(workspaceId)).held).toMatchObject([
            { id: held.id, waitsForSlot: true },
          ]);
          expect((yield* outboxOf(workspaceId)).notes).toContainEqual(
            expect.stringContaining(
              "1 workers are live and the charter allows 1, so the held brief “Build later” (later) waits",
            ),
          );

          // The user's Release now doesn't go past the cap either; it says why.
          const refused = yield* orchestration
            .releaseHeldBrief(workspaceId, held.id)
            .pipe(Effect.flip);
          expect(refused._tag).toBe("InvalidState");
          expect(refused.message).toContain(
            "1 workers are live and the workspace allows 1 at once",
          );
          expect((yield* outboxOf(workspaceId)).heldBriefs?.map((each) => each.id)).toEqual([
            held.id,
          ]);

          // Once the busy worker rests archived, the next retry starts it: a turn it still ran
          // would keep its slot.
          yield* completeTurn(busy.session);
          yield* session.callTool("archive_thread", { threadId: busy.thread.id });
          yield* settle;
          yield* TestClock.adjust(HELD_RETRY_MS);
          const [worker] = yield* waitReal(
            "the held brief's worker once a slot freed",
            workersOn(workspaceId, "later").pipe(Effect.map((found) => found.length > 0 && found)),
          );
          yield* waitSent(worker!.id, 1);
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "puts a brief back when its spawn at the reset is refused for now, and tries it again",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* optedIn(thread.id, workspaceId);
          const resetsAt = yield* report(session, 0.85);
          const held = (yield* lowCall(session, "nightly")) as HeldSpawn;
          expect(held.held).toBe(true);
          const limited = yield* spawnPast(thread.id, session, { feature: "billing" });

          // A worker is being rate limited when the reset comes: `spawn_worker` refuses with `rate`.
          // (Set a minute before, inside the runtime's retry deadline.)
          yield* TestClock.adjust(resetsAt - 60_000 - (yield* Clock.currentTimeMillis));
          yield* limited.session.emit({ type: "status", status: "retrying" });
          yield* settle;
          yield* TestClock.adjust("60 seconds");
          const [back] = yield* waitReal(
            "the brief put back for a retry",
            outboxOf(workspaceId).pipe(
              Effect.map((outbox) => outbox.heldBriefs?.[0]?.attempts === 1 && outbox.heldBriefs),
            ),
          );
          expect(back).toMatchObject({ id: held.id, retryAt: resetsAt + HELD_RETRY_MS });
          expect(back?.waitsForSlot).toBeUndefined();
          expect(yield* workersOn(workspaceId, "nightly")).toEqual([]);

          // The rate limit clears; the retry spawns it.
          yield* limited.session.emit({ type: "status", status: "running" });
          yield* settle;
          yield* TestClock.adjust(HELD_RETRY_MS);
          const [worker] = yield* waitReal(
            "the held brief's worker on the retry",
            workersOn(workspaceId, "nightly").pipe(
              Effect.map((found) => found.length > 0 && found),
            ),
          );
          yield* waitSent(worker!.id, 1);
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "puts a brief back, still due to start on its own, when the user's Release now is refused",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* optedIn(thread.id, workspaceId);
          const resetsAt = yield* report(session, 0.85);
          const held = (yield* lowCall(session, "cleanup")) as HeldSpawn;
          const limited = yield* spawnPast(thread.id, session, { feature: "billing" });
          yield* limited.session.emit({ type: "status", status: "retrying" });
          yield* settle;

          const refused = yield* orchestration
            .releaseHeldBrief(workspaceId, held.id)
            .pipe(Effect.flip);
          expect(refused._tag).toBe("InvalidState");
          expect(refused.message).toContain("is being rate limited");
          expect(refused.message).not.toMatch(/^rate: /);
          expect((yield* outboxOf(workspaceId)).heldBriefs).toMatchObject([
            { id: held.id, until: resetsAt },
          ]);
          expect((yield* orchestration.ledger(workspaceId)).held?.map((each) => each.id)).toEqual([
            held.id,
          ]);

          yield* limited.session.emit({ type: "status", status: "running" });
          yield* settle;
          yield* TestClock.adjust(resetsAt - (yield* Clock.currentTimeMillis));
          const [worker] = yield* waitReal(
            "the held brief's worker at the reset",
            workersOn(workspaceId, "cleanup").pipe(
              Effect.map((found) => found.length > 0 && found),
            ),
          );
          yield* waitSent(worker!.id, 1);
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "releases a brief that comes due while another release is running",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* optedIn(thread.id, workspaceId);
          // Two briefs a millisecond apart: the second's alarm fires while the first is spawning.
          const firstReset = yield* report(session, 0.85);
          const first = (yield* lowCall(session, "first")) as HeldSpawn;
          yield* TestClock.adjust(1);
          const secondReset = yield* report(session, 0.86);
          const second = (yield* lowCall(session, "second")) as HeldSpawn;
          expect([first.until, second.until]).toEqual([firstReset, secondReset]);
          expect(secondReset).toBe(firstReset + 1);
          // The window then reads low again, so neither is held once more at its reset.
          yield* report(session, 0.5);

          yield* TestClock.adjust(firstReset - (yield* Clock.currentTimeMillis));
          yield* TestClock.adjust(1);
          const found = yield* waitReal(
            "both held briefs' workers",
            Effect.all([workersOn(workspaceId, "first"), workersOn(workspaceId, "second")]).pipe(
              Effect.map((both) => both.every((each) => each.length === 1) && both),
            ),
          );
          for (const [worker] of found) yield* waitSent(worker!.id, 1);
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "a held brief takes its feature's new name, waits out the feature's pause past its reset, and spawns on the resume",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* optedIn(thread.id, workspaceId);
          const resetsAt = yield* report(session, 0.85);
          const held = (yield* lowCall(session, "docs-refresh")) as HeldSpawn;
          yield* report(session, 0.5);
          // A view has drawn its card.
          yield* orchestration.featureCards(workspaceId);

          // Renamed: the brief, and the card it alone makes, go under the new slug.
          expect(yield* orchestration.renameFeature(workspaceId, "docs-refresh", "docs")).toBe(
            "docs",
          );
          expect((yield* outboxOf(workspaceId)).heldBriefs?.map((b) => b.input.feature)).toEqual([
            "docs",
          ]);
          const cards = (yield* orchestration.featureCards(workspaceId)).cards;
          expect(cards.find((card) => card.feature === "docs")?.held?.[0]?.id).toBe(held.id);
          expect(cards.find((card) => card.feature === "docs-refresh")).toMatchObject({
            workers: [],
          });
          expect(cards.find((card) => card.feature === "docs-refresh")?.held).toBeUndefined();

          // Paused, it stays held past its reset.
          yield* orchestration.setFeaturePaused(workspaceId, "docs", true);
          yield* TestClock.adjust(resetsAt - (yield* Clock.currentTimeMillis));
          yield* TestClock.adjust("5 minutes");
          yield* settle;
          expect(yield* workersOn(workspaceId, "docs")).toEqual([]);
          expect((yield* outboxOf(workspaceId)).heldBriefs).toHaveLength(1);

          // Resumed, it spawns under the new name.
          yield* orchestration.setFeaturePaused(workspaceId, "docs", false);
          const [worker] = yield* waitReal(
            "the held brief's worker",
            workersOn(workspaceId, "docs").pipe(Effect.map((found) => found.length > 0 && found)),
          );
          yield* waitSent(worker!.id, 1);
          // No branch existed for it yet, so it is named after the feature as it is now.
          expect(worker!.checkout.branch).toBe("feat/docs");
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
          expect(yield* workersOn(workspaceId, "docs-refresh")).toEqual([]);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "a paused feature's brief is refused, not held, and Release now on one held tells the user to resume it",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* optedIn(thread.id, workspaceId);
          yield* report(session, 0.85);
          const held = (yield* lowCall(session, "docs-refresh")) as HeldSpawn;
          yield* spawnPast(thread.id, session, { feature: "board" });
          yield* orchestration.setFeaturePaused(workspaceId, "board", true);
          yield* orchestration.setFeaturePaused(workspaceId, "docs-refresh", true);
          // Past the hold share, a low-priority brief for the paused feature is refused outright.
          const refused = yield* lowCall(session, "board").pipe(Effect.flip);
          expect(refused).toMatchObject({
            message: expect.stringContaining("feature_paused: The user paused feature board"),
          });
          expect((yield* outboxOf(workspaceId)).heldBriefs).toHaveLength(1);
          // The user's Release now on the paused one says what to do, in their words.
          const release = yield* orchestration
            .releaseHeldBrief(workspaceId, held.id)
            .pipe(Effect.flip);
          expect(release.message).toBe(
            "You paused docs-refresh, so “Build docs-refresh” waits. Resume the feature to start it.",
          );
          expect((yield* outboxOf(workspaceId)).heldBriefs?.map((b) => b.id)).toEqual([held.id]);
        }),
      ),
    { timeout: 90_000 },
  );
});

describe("which refused releases are tried again", () => {
  it("retries the refusals that pass on their own and drops the rest", () => {
    expect(refusalPasses("rate: a worker is being rate limited")).toBe(true);
    expect(refusalPasses("paused: orchestration is paused")).toBe(true);
    expect(refusalPasses("no_authority: the orchestrator is being replaced")).toBe(true);
    expect(refusalPasses("git worktree add failed")).toBe(true);
    // A pause of the brief's feature, landing between its claim and its spawn, passes too.
    expect(refusalPasses("feature_paused: The user paused feature docs")).toBe(true);
    expect(refusalPasses("invalid_feature: no slug")).toBe(false);
    expect(refusalPasses("model_not_allowed: gone")).toBe(false);
  });
});

/** A worker's turn meets its login's limit, which resets in three hours. */
const meetLimit = (session: FakeSession) =>
  session.emit(
    {
      type: "turnEnd",
      reason: "error",
      error: "You've hit your session limit · try again in 3 hours",
      failure: { kind: "rateLimit", httpStatus: 429, code: "rate_limit", retryable: true },
    },
    { type: "status", status: "idle" },
  );

describe.skipIf(!hasGit)("after the CLI is signed in to another account", () => {
  it.effect(
    "keeps later release batches in place when fresh readings keep arriving",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* optedIn(thread.id, workspaceId);
          yield* report(session, 0.9);
          for (const feature of ["alpha", "beta", "gamma", "delta"]) {
            expect((yield* lowCall(session, feature)) as HeldSpawn).toMatchObject({ held: true });
          }
          // Keep all four briefs visible in the outbox while checking their release plan.
          yield* orchestration.setPaused(workspaceId, true);
          yield* TestClock.adjust("1 minute");
          const releasedAt = yield* Clock.currentTimeMillis;
          yield* report(session, 0.1);
          yield* waitReal(
            "headroom schedules the second batch",
            outboxOf(workspaceId).pipe(
              Effect.map((outbox) =>
                outbox.heldBriefs?.every(
                  (brief, i) =>
                    brief.until === releasedAt + (i < 3 ? 0 : LIMIT_RESUME_BATCH_GAP_MS),
                ),
              ),
            ),
          );
          yield* TestClock.adjust("1 second");
          yield* report(session, 0.11);
          yield* settle;
          expect((yield* outboxOf(workspaceId)).heldBriefs?.map((brief) => brief.until)).toEqual([
            releasedAt,
            releasedAt,
            releasedAt,
            releasedAt + LIMIT_RESUME_BATCH_GAP_MS,
          ]);
          // A completed turn on the same login must preserve the plan too.
          const runtimes = yield* ThreadRuntimes;
          const fake = yield* FakeAgentControl;
          const solo = yield* runtimes.create({
            projectRoot: world.repo,
            checkout: { kind: "main", path: world.repo },
            model: thread.model,
            input: { text: "a separate turn" },
          });
          yield* waitSent(solo.id, 1);
          yield* (yield* fake.latest(solo.id)).completeTurn();
          yield* settle;
          expect((yield* outboxOf(workspaceId)).heldBriefs?.at(-1)?.until).toBe(
            releasedAt + LIMIT_RESUME_BATCH_GAP_MS,
          );

          // If the limit returns before release, the next release checks it and holds again.
          const renewedReset = yield* report(session, 0.9);
          yield* orchestration.setPaused(workspaceId, false);
          yield* TestClock.adjust(LIMIT_RESUME_BATCH_GAP_MS);
          yield* waitReal(
            "all briefs wait for the renewed limit",
            outboxOf(workspaceId).pipe(
              Effect.map(
                (outbox) =>
                  outbox.heldBriefs?.length === 4 &&
                  outbox.heldBriefs.every(
                    (brief) => brief.until === renewedReset && brief.releasedEarly === undefined,
                  ),
              ),
            ),
          );
          expect(yield* workersOn(workspaceId, "delta")).toEqual([]);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "resumes parked workers, a held brief and paused new workers with no click, but not what the user paused",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const runtimes = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const readings = yield* UsageLimitReadings;
          const { thread, workspaceId } = yield* openOrchestrator(world);
          const session = yield* optedIn(thread.id, workspaceId);
          yield* report(session, 0.3);

          // Four workers meet the old login's limit and park on it; the user pauses the fourth's
          // feature.
          const workers: Array<{ readonly id: ThreadId; readonly session: FakeSession }> = [];
          for (const feature of ["alpha", "beta", "gamma", "mine"]) {
            const spawned = yield* spawn(session, { feature });
            workers.push({ id: spawned.thread.id, session: spawned.session });
          }
          for (const worker of workers) yield* meetLimit(worker.session);
          yield* settle;
          for (const worker of workers) {
            expect((yield* store.getThread(worker.id)).limitWait).toMatchObject({ kind: "limit" });
          }
          yield* orchestration.setFeaturePaused(workspaceId, "mine", true);
          const [paused] = workers.slice(-1);
          const parked = workers.slice(0, -1);

          // The old login's window reaches 90%: a low-priority brief is held, and the user pauses
          // new workers until the window resets.
          const oldReset = yield* report(session, 0.9);
          const held = (yield* lowCall(session, "later")) as HeldSpawn;
          expect(held.held).toBe(true);
          const denied = yield* spawn(session, { feature: "urgent" }).pipe(
            Effect.flip,
            Effect.forkScoped,
          );
          const card = yield* waitReal(
            "the pause card",
            store
              .listRequests(thread.id)
              .pipe(
                Effect.map((requests) =>
                  requests.find(
                    (request) =>
                      request.kind === "approval" && request.toolName === LIMIT_PAUSE_TOOL,
                  ),
                ),
              ),
          );
          yield* runtimes.respond(thread.id, card.id, {
            kind: "approval",
            decision: "deny",
            scope: "once",
          });
          expect(String((yield* Fiber.join(denied)) as unknown)).toContain("limit_paused");
          expect((yield* outboxOf(workspaceId)).limitHolds).toMatchObject([
            { decision: "paused", until: oldReset },
          ]);

          // The user signs Claude Code in to another login. Its windows are its own, barely used,
          // as the CLI's account query reads them.
          yield* TestClock.adjust("1 minute");
          const now = yield* Clock.currentTimeMillis;
          yield* readings.replaceSubscription(
            thread.model.agent,
            [
              { status: "allowed", window: "five_hour", utilization: 0, resetsAt: now + 5 * HOUR },
              {
                status: "allowed",
                window: "seven_day",
                utilization: 0,
                resetsAt: now + 168 * HOUR,
              },
            ],
            yield* readings.current,
          );
          yield* settle;

          // Nobody clicks anything. Before: each waited for the old login's reset, three hours
          // on, or for the user's Resume, Release now or a new answer.
          for (let i = 0; i < 8; i++) {
            yield* TestClock.adjust("30 seconds");
            yield* settle;
          }
          for (const worker of parked) {
            yield* waitReal(
              "a parked worker's resume",
              store.getThread(worker.id).pipe(Effect.map((each) => each.limitWait === undefined)),
            );
            expect(worker.session.sent.at(-1)?.text).toBe(LIMIT_CLEARED_TEXT);
          }
          const [released] = yield* waitReal(
            "the held brief's worker",
            workersOn(workspaceId, "later").pipe(Effect.map((found) => found.length > 0 && found)),
          );
          expect(released!.title).toBe("Build later");
          expect((yield* outboxOf(workspaceId)).heldBriefs).toBeUndefined();
          expect((yield* outboxOf(workspaceId)).limitHolds).toBeUndefined();
          // New workers spawn again, with no card.
          const urgent = yield* spawn(session, { feature: "urgent" });
          expect(urgent.thread.spawnedBy?.feature).toBe("urgent");

          // The worker of the feature the user paused stays where the user put it.
          expect((yield* store.getThread(paused!.id)).limitWait).toMatchObject({
            kind: "limit",
            cleared: expect.any(Number),
          });
          expect(paused!.session.sent).toHaveLength(1);
        }),
      ),
    { timeout: 90_000 },
  );
});
