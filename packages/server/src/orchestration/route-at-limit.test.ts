import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  LIMIT_PAUSE_TOOL,
  type OrchestratorCharter,
  type Thread,
  type ThreadId,
  type UserInput,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type * as Scope from "effect/Scope";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, type FakeSession } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import type { RouteOffer } from "./limit-pause.ts";
import { Orchestration, type HeldSpawn } from "./service.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  outboxOf,
  settle,
  waitReal,
  waitSent,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";
import { BRIEF_FOOTER_LINE } from "./user-words.ts";

// The workspace's worker brief footer and the opt-in route offer at a limit, through the
// orchestrator's own `spawn_worker` and the fake agent's real `rateLimit` path.

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

const HOUR = 3_600_000;

/** The orchestrator's agent (Claude) reports its 5-hour window, resetting in an hour. */
const report = (
  session: FakeSession,
  utilization: number,
  status: "allowed" | "warning" | "rejected",
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const resetsAt = now + HOUR;
    yield* session.emit({ type: "rateLimit", status, window: "five_hour", utilization, resetsAt });
    const readings = yield* UsageLimitReadings;
    yield* waitReal(
      `the ${status} reading`,
      readings.current.pipe(
        Effect.map((all) =>
          all.some((each) => each.utilization === utilization && each.status === status),
        ),
      ),
    );
    return resetsAt;
  });

const call = (session: FakeSession, feature: string, extra: Record<string, unknown> = {}) =>
  session.callTool("spawn_worker", {
    project: "shop",
    feature,
    title: `Build ${feature}`,
    brief: `Do the ${feature} work.`,
    ...extra,
  }) as Effect.Effect<
    | HeldSpawn
    | RouteOffer
    | { readonly threadId: ThreadId; readonly model: string; readonly queued?: string },
    unknown
  >;

const workersOn = (workspaceId: WorkspaceId, feature: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listThreads).filter(
      (thread: Thread) =>
        thread.workspaceId === workspaceId && thread.spawnedBy?.feature === feature,
    );
  });

/** Sets the charter and returns the orchestrator's session on it, idle. */
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

/** A roster of the orchestrator's Claude and a Codex model the user keeps for reviews. */
const ROSTER: OrchestratorCharter["workerModels"] = [
  { agent: "claude", model: "fake-opus", default: true },
  { agent: "claude", model: "fake-haiku", useFor: "small chores" },
  { agent: "codex", model: "gpt-5.5-direct", useFor: "independent review; never UI" },
];

const withCodex = Effect.gen(function* () {
  const store = yield* ThreadStore;
  yield* store.updateSettings((settings) => ({
    ...settings,
    agents: { ...settings.agents, customModels: [{ agent: "codex", id: "gpt-5.5-direct" }] },
  }));
});

const textOf = (input: UserInput | undefined) => input?.text ?? "";

describe.skipIf(!hasGit)("offering another worker model at a limit", () => {
  it.effect(
    "with routing off (the default), a spawn at a reached limit is made as before and nothing is offered",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, workspaceId } = yield* openOrchestrator(world);
          yield* withCodex;
          const session = yield* rechartered(thread.id, workspaceId, {
            ...DEFAULT_CHARTER,
            workerModels: ROSTER,
          });
          yield* report(session, 1, "rejected");
          const made = yield* call(session, "as-before");
          expect(made).not.toHaveProperty("routeOffer");
          expect(made).toMatchObject({ model: "claude:fake-opus" });
          expect(yield* workersOn(workspaceId, "as-before")).toHaveLength(1);
          // A held brief carries no alternatives either.
          const held = (yield* call(session, "chore", { priority: "low" })) as HeldSpawn;
          expect(held.held).toBe(true);
          expect(held).not.toHaveProperty("alternatives");
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect(
    "with routing on, a reached limit spawns nothing and offers the models clear of it, and the pick says which model ran",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, workspaceId } = yield* openOrchestrator(world);
          yield* withCodex;
          const session = yield* rechartered(thread.id, workspaceId, {
            ...DEFAULT_CHARTER,
            workerModels: ROSTER,
            routeAtLimit: true,
          });
          // However high the meter, even a full window, nothing is offered: credits can carry on
          // past it. Only a window the CLI refused turns on is a reached limit.
          yield* report(session, 0.97, "warning");
          expect(yield* call(session, "high-meter")).toMatchObject({
            model: "claude:fake-opus",
          });
          yield* report(session, 1, "warning");
          expect(yield* call(session, "full-window")).toMatchObject({
            model: "claude:fake-opus",
          });

          yield* report(session, 1, "rejected");
          const offer = (yield* call(session, "review-auth")) as RouteOffer;
          expect(offer).toMatchObject({
            routeOffer: true,
            feature: "review-auth",
            model: "claude:fake-opus",
            wouldBe: "queued",
            // The other Claude model shares the account that is at its limit, so it isn't one.
            alternatives: [
              { model: "codex:gpt-5.5-direct", useFor: "independent review; never UI" },
            ],
          });
          expect(offer.note).toContain("Claude's 5-hour limit is reached");
          expect(offer.note).toContain("whose user note fits");
          expect(yield* workersOn(workspaceId, "review-auth")).toEqual([]);

          // The orchestrator picks; the spawn says which model the worker runs on.
          const routed = yield* call(session, "review-auth", { model: "codex:gpt-5.5-direct" });
          expect(routed).toMatchObject({ model: "codex:gpt-5.5-direct" });
          const [worker] = yield* workersOn(workspaceId, "review-auth");
          expect(worker?.model).toMatchObject({ agent: "codex", model: "gpt-5.5-direct" });

          // Staying is the orchestrator's choice too: the spawn goes ahead on the model named.
          const stayed = yield* call(session, "stays", { atLimit: "stay" });
          expect(stayed).toMatchObject({ model: "claude:fake-opus" });
          expect(yield* workersOn(workspaceId, "stays")).toHaveLength(1);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect("a held brief carries the alternatives, and retargeting starts it there", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, workspaceId } = yield* openOrchestrator(world);
        yield* withCodex;
        const session = yield* rechartered(thread.id, workspaceId, {
          ...DEFAULT_CHARTER,
          // The hold gate holds a low-priority brief below a refusal only at a threshold the user set.
          pauseAtLimitPct: 90,
          workerModels: ROSTER,
          routeAtLimit: true,
        });
        // The hold gate's own rule holds it; routing only adds the choice.
        yield* report(session, 0.92, "warning");
        const held = (yield* call(session, "follow-up", { priority: "low" })) as HeldSpawn;
        expect(held.held).toBe(true);
        expect(held.alternatives).toEqual([
          { model: "codex:gpt-5.5-direct", useFor: "independent review; never UI" },
        ]);
        expect(held.note).toContain(`id ${held.id}`);
        expect((yield* outboxOf(workspaceId)).heldBriefs).toHaveLength(1);
        yield* session.callTool("manage_held_spawn", {
          id: held.id,
          action: "retarget",
          model: "codex:gpt-5.5-direct",
        });
        const [worker] = yield* waitReal(
          "the retargeted worker",
          workersOn(workspaceId, "follow-up").pipe(
            Effect.map((workers) => workers.length === 1 && workers),
          ),
        );
        expect(worker?.model).toMatchObject({ agent: "codex" });
      }),
    ),
  );

  it.effect("the pause gate's refusal becomes an offer, and with nothing clear it stands", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const { thread, workspaceId } = yield* openOrchestrator(world);
        yield* withCodex;
        const session = yield* rechartered(thread.id, workspaceId, {
          ...DEFAULT_CHARTER,
          pauseAtLimitPct: 90,
          workerModels: ROSTER,
          routeAtLimit: true,
        });
        yield* report(session, 0.92, "warning");
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const asked = yield* call(session, "paused").pipe(Effect.forkScoped);
        const [card] = yield* waitReal(
          "the limit card",
          store
            .listRequests(thread.id)
            .pipe(
              Effect.map(
                (requests) =>
                  requests.filter((r) => r.kind === "approval" && r.toolName === LIMIT_PAUSE_TOOL)
                    .length > 0 &&
                  requests.filter((r) => r.kind === "approval" && r.toolName === LIMIT_PAUSE_TOOL),
              ),
            ),
        );
        yield* runtimes.respond(thread.id, card!.id, {
          kind: "approval",
          decision: "deny",
          scope: "once",
        });
        const offer = (yield* Fiber.join(asked)) as RouteOffer;
        expect(offer).toMatchObject({
          routeOffer: true,
          wouldBe: "paused",
          alternatives: [{ model: "codex:gpt-5.5-direct" }],
        });
        expect(offer.note).toMatch(/^Not spawned: .*paused new Claude workers/);
        expect(yield* workersOn(workspaceId, "paused")).toEqual([]);

        // A roster with nothing clear of the limit: the pause gate's refusal stands as it was.
        const only = yield* rechartered(thread.id, workspaceId, {
          ...DEFAULT_CHARTER,
          pauseAtLimitPct: 90,
          workerModels: ROSTER.filter((model) => model.agent === "claude"),
          routeAtLimit: true,
        });
        const refused = yield* call(only, "still-paused").pipe(Effect.flip);
        expect(String((refused as Error).message)).toMatch(/^limit_paused: /);
      }),
    ),
  );
});

describe.skipIf(!hasGit)("the worker brief footer", () => {
  it.effect(
    "is appended to every brief, marked as the user's standing instructions, and absent by default",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const { thread, workspaceId, session: first } = yield* openOrchestrator(world);
          // The default charter appends nothing: the brief is exactly what was written.
          const plain = (yield* call(first, "plain")) as { readonly threadId: ThreadId };
          expect(textOf((yield* waitSent(plain.threadId, 1)).sent[0])).toBe("Do the plain work.");

          const footer = "Run the full check before merging.\nNever touch the vendored folder.";
          const orchestration = yield* Orchestration;
          const session = first;
          yield* completeTurn(session);
          const before = session.sent.length;
          yield* orchestration.setCharter(workspaceId, {
            ...DEFAULT_CHARTER,
            autonomy: "publish",
            workerBriefFooter: `  ${footer}\n`,
          });
          // An open session hears of the footer in its next digest, so it needn't repeat it.
          yield* TestClock.adjust("60 seconds");
          const woken = yield* waitSent(thread.id, before + 1);
          const told = textOf(woken.sent[before]);
          expect(told).toContain("don't repeat them in a brief");
          expect(told).toContain("  > Never touch the vendored folder.");
          yield* completeTurn(woken);

          const spawned = (yield* call(session, "footed")) as { readonly threadId: ThreadId };
          expect(textOf((yield* waitSent(spawned.threadId, 1)).sent[0])).toBe(
            ["Do the footed work.", "", "---", BRIEF_FOOTER_LINE, "", footer].join("\n"),
          );
        }),
      ),
    { timeout: 90_000 },
  );
});
