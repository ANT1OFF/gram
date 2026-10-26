import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  LIMIT_PAUSE_TOOL,
  serializeDigest,
  type OrchestrationDigest,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, type FakeSession } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { Orchestration } from "./service.ts";
import {
  makeWorld,
  openOrchestrator,
  outboxOf,
  settle,
  spawn,
  waitReal,
  withServer,
  type Server,
  type World,
} from "./test-harness.ts";

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

const HOUR = 3_600_000;

/** An orchestrator at `publish` whose workspace pauses new workers at 90% of a limit. */
const pausingAt90 = (world: World) =>
  Effect.gen(function* () {
    const opened = yield* openOrchestrator(world);
    const orchestration = yield* Orchestration;
    yield* orchestration.setCharter(opened.workspaceId, {
      ...DEFAULT_CHARTER,
      autonomy: "publish",
      pauseAtLimitPct: 90,
    });
    yield* settle;
    // The charter is in the orchestrator's prompt, so its session reopens on the new one; the
    // digest the new session opens with is taken, and tools are called through it from then on.
    const fake = yield* FakeAgentControl;
    const runtimes = yield* ThreadRuntimes;
    const session = yield* waitReal(
      "the orchestrator's session on the new charter",
      Effect.sync(() =>
        fake.sessions.filter((each) => each.options.threadId === opened.thread.id).at(-1),
      ),
    );
    for (let i = 0; i < 10 && (yield* runtimes.status(opened.thread.id)) !== "idle"; i++) {
      if ((yield* runtimes.status(opened.thread.id)) === "running") yield* session.completeTurn();
      yield* settle;
    }
    return { ...opened, session };
  });

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

/** The limit cards open on the orchestrator's thread. */
const pauseCards = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listRequests(threadId)).filter(
      (request) => request.kind === "approval" && request.toolName === LIMIT_PAUSE_TOOL,
    );
  });

const spawnCall = (session: FakeSession, feature: string) =>
  session.callTool("spawn_worker", {
    project: "shop",
    feature,
    title: `Build ${feature}`,
    brief: `Do the ${feature} work.`,
  });

describe.skipIf(!hasGit)("pausing new workers near a limit", () => {
  it.effect(
    "asks once at the threshold, refuses spawns while paused, leaves running workers alone, and resumes at the reset",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const orchestration = yield* Orchestration;
          const { thread, session, workspaceId } = yield* pausingAt90(world);
          // A worker already running before the limit is near.
          const running = yield* spawn(session, { feature: "running" });
          const runningSent = running.session.sent.length;

          // Under the threshold nothing asks.
          yield* report(session, 0.5);
          const below = yield* spawn(session, { feature: "below" });
          expect(below.thread.spawnedBy?.feature).toBe("below");
          expect(yield* pauseCards(thread.id)).toEqual([]);

          const resetsAt = yield* report(session, 0.92);
          // Two spawns at once: one card between them.
          const first = yield* spawnCall(session, "first").pipe(Effect.flip, Effect.forkScoped);
          const second = yield* spawnCall(session, "second").pipe(Effect.flip, Effect.forkScoped);
          const [card] = yield* waitReal(
            "the limit card",
            pauseCards(thread.id).pipe(Effect.map((cards) => cards.length > 0 && cards)),
          );
          yield* settle;
          expect(yield* pauseCards(thread.id)).toHaveLength(1);
          expect(card).toMatchObject({
            kind: "approval",
            toolName: LIMIT_PAUSE_TOOL,
            input: {
              agent: thread.model.agent,
              window: "five_hour",
              usedPct: 92,
              pauseAtPct: 90,
              resetsAt,
            },
            scopes: ["once"],
          });

          yield* runtimes.respond(thread.id, card!.id, {
            kind: "approval",
            decision: "deny",
            scope: "once",
          });
          for (const call of [first, second]) {
            expect((yield* Fiber.join(call)).message).toMatch(/^limit_paused: /);
          }
          const outbox = yield* outboxOf(workspaceId);
          expect(outbox.limitHolds).toEqual([
            expect.objectContaining({ decision: "paused", until: resetsAt, usedPct: 92 }),
          ]);

          // Asked once: a later spawn is refused straight away.
          const third = yield* spawnCall(session, "third").pipe(Effect.flip);
          expect(third.message).toMatch(/^limit_paused: .*paused new .* workers until it resets/);
          expect(yield* pauseCards(thread.id)).toEqual([]);

          // Running workers are untouched: nothing sent to them, nothing stopped.
          expect(running.session.sent).toHaveLength(runningSent);
          expect(yield* runtimes.status(running.thread.id)).not.toBe("cold");
          expect(yield* runtimes.status(below.thread.id)).not.toBe("cold");

          // The orchestrator reads the pause in its ledger and digest, and no dollars.
          const ledger = yield* orchestration.ledger(workspaceId);
          expect(ledger.budget.pauseAtPct).toBe(90);
          expect(ledger.budget.limits).toEqual([
            {
              agent: thread.model.agent,
              window: "fiveHour",
              usedPct: 92,
              resetsAt,
              hold: "paused",
            },
          ]);

          // At the reset the pause lifts by itself, with a digest saying so. The digests the
          // spawns woke are taken first, so the orchestrator is idle for the next.
          const fake = yield* FakeAgentControl;
          const sessionsOf = (id: ThreadId) =>
            fake.sessions.filter((each) => each.options.threadId === id);
          const takeTurns = Effect.gen(function* () {
            yield* settle;
            // Each ended turn may start the next digest's at once, so no wait for idle between.
            for (let i = 0; i < 10 && (yield* runtimes.status(thread.id)) === "running"; i++) {
              yield* sessionsOf(thread.id).at(-1)!.completeTurn();
              yield* settle;
            }
          });
          yield* TestClock.adjust("5 minutes");
          yield* takeTurns;
          yield* TestClock.adjust(HOUR);
          yield* settle;
          yield* TestClock.adjust("5 minutes");
          yield* settle;
          expect((yield* outboxOf(workspaceId)).limitHolds).toBeUndefined();
          const resumed = (input: (typeof session.sent)[number]) =>
            (input.notice as OrchestrationDigest | undefined)?.notes?.some((note) =>
              note.includes("has reset, so new"),
            ) === true;
          // A digest another wake sent meanwhile is taken first; the note rides the next one.
          for (
            let i = 0;
            i < 6 &&
            sessionsOf(thread.id)
              .flatMap((each) => each.sent)
              .find(resumed) === undefined;
            i++
          ) {
            yield* takeTurns;
            yield* TestClock.adjust("5 minutes");
            yield* settle;
          }
          const digest = sessionsOf(thread.id)
            .flatMap((each) => each.sent)
            .find(resumed);
          if (digest === undefined) {
            const notes = (yield* outboxOf(workspaceId)).notes;
            const status = yield* runtimes.status(thread.id);
            return yield* Effect.die(
              new Error(`no digest after the reset; status ${status}, notes ${notes.join(" | ")}`),
            );
          }
          expect(digest.text).toContain("has reset, so new");
          expect(digest.text).not.toContain("$");
          yield* takeTurns;
          const after = yield* spawn(session, { feature: "after" });
          expect(after.thread.spawnedBy?.feature).toBe("after");
          expect(yield* pauseCards(thread.id)).toEqual([]);
        }),
      ),
    { timeout: 90_000 },
  );

  it.effect("keeps going when the user says so, without asking again in that window", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const { thread, session, workspaceId } = yield* pausingAt90(world);
        yield* report(session, 0.95);
        const asked = yield* spawnCall(session, "asked").pipe(Effect.forkScoped);
        const [card] = yield* waitReal(
          "the limit card",
          pauseCards(thread.id).pipe(Effect.map((cards) => cards.length > 0 && cards)),
        );
        yield* runtimes.respond(thread.id, card!.id, {
          kind: "approval",
          decision: "allow",
          scope: "once",
        });
        yield* Fiber.join(asked);
        expect((yield* outboxOf(workspaceId)).limitHolds).toEqual([
          expect.objectContaining({ decision: "keepGoing" }),
        ]);
        const again = yield* spawn(session, { feature: "again" });
        expect(again.thread.spawnedBy?.feature).toBe("again");
        expect(yield* pauseCards(thread.id)).toEqual([]);
      }),
    ),
  );

  it.effect("never asks without a threshold, and the digest names the limit, not dollars", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const orchestration = yield* Orchestration;
        const { thread, session, workspaceId } = yield* openOrchestrator(world);
        yield* report(session, 0.97);
        const spawned = yield* spawn(session, { feature: "free" });
        expect(spawned.thread.spawnedBy?.feature).toBe("free");
        expect(yield* pauseCards(thread.id)).toEqual([]);
        const ledger = yield* orchestration.ledger(workspaceId as WorkspaceId);
        expect(ledger.budget.pauseAtPct).toBeUndefined();
        const text = serializeDigest({
          kind: "orchestration",
          variant: "digest",
          generation: 1,
          workspaceId,
          workspaceName: "shop",
          reasons: [],
          changes: [],
          reports: [],
          features: ledger.features,
          budget: ledger.budget,
          notes: [],
        });
        expect(text).toMatch(/limits used: \w+ 5-hour 97%/);
        expect(text).not.toContain("$");
      }),
    ),
  );
});
