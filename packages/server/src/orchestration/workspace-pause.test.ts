import { describe, expect, it } from "@effect/vitest";
import type { AgentEvent, MessageId, ThreadId, WorkspaceId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, type FakeSession } from "../runtime/fake-agent.ts";
import { LIMIT_RESUME_BATCH_GAP_MS, LIMIT_RESUME_JITTER_MS } from "../runtime/limit-wait.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Orchestration } from "./service.ts";
import {
  completeTurn,
  GIT_HEAVY,
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

// The user's pause of a workspace stops the whole effort: the orchestrator's turn and every
// worker's at their next tool boundary, a worker the user holds excepted; what would wake or reach
// them waits, merges wait (pr-tools.test.ts), and the resume lets them go in batches.

const inServer = <A, E>(body: (world: World) => Effect.Effect<A, E, Server | Scope.Scope>) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    return yield* withServer(world, body(world));
  });

/** Everything the fake agent was sent on `threadId`'s sessions. */
const sentTo = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return fake.sessions
      .filter((session) => session.options.threadId === threadId)
      .flatMap((session) => session.sent.map((input) => input.text));
  });

const interruptsOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return fake.sessions
      .filter((session) => session.options.threadId === threadId)
      .reduce((sum, session) => sum + session.interrupts, 0);
  });

/** How often each of `threadId`'s sessions closed its tool gate: the pause's stop. */
const gateClosesOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return fake.sessions
      .filter((session) => session.options.threadId === threadId)
      .reduce((sum, session) => sum + session.gateCloses, 0);
  });

/**
 * The pause closed `threadId`'s gate, and its agent ends the turn as it would on the refusal:
 * nothing interrupts it.
 */
const endsItsTurn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    const runtimes = yield* ThreadRuntimes;
    yield* waitReal("the gate closed", gateClosesOf(threadId).pipe(Effect.map((n) => n >= 1)));
    yield* (yield* fake.latest(threadId)).completeTurn("Stopping here, as the user paused.");
    yield* waitReal(
      "the turn's end",
      runtimes.status(threadId).pipe(Effect.map((status) => status === "idle")),
    );
  });

/** The worker's turn starts a command and waits until the runtime shows it running. */
const startCommand = (session: FakeSession, command: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const messageId = `m-${session.options.threadId}` as MessageId;
    yield* session.emit(
      { type: "chunk", messageId, chunk: { type: "start", messageId } } as AgentEvent,
      {
        type: "chunk",
        messageId,
        chunk: {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "Bash",
          input: { command },
        },
      } as AgentEvent,
    );
    yield* waitReal(
      `the command ${command}`,
      runtimes
        .activity(session.options.threadId)
        .pipe(Effect.map((line) => line?.includes(command.split(" ")[0]!) === true)),
    );
    return () =>
      session.emit({
        type: "chunk",
        messageId,
        chunk: { type: "tool-output-available", toolCallId: "c1", output: "" },
      } as AgentEvent);
  });

const stoppedOf = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    return (yield* (yield* ThreadStore).getWorkspace(workspaceId)).paused?.stopped ?? [];
  });

/** Ends whatever turn `threadId` has running, as many times as its queue starts another. */
const drain = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    const runtimes = yield* ThreadRuntimes;
    for (let i = 0; i < 10; i++) {
      yield* settle;
      if ((yield* runtimes.status(threadId)) !== "running") return;
      yield* (yield* fake.latest(threadId)).completeTurn();
    }
  });

describe.skipIf(!hasGit)("the user's pause of a workspace", () => {
  it.effect(
    "stops every turn at its tool boundary but a held worker's, and refuses spawns",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const runtimes = yield* ThreadRuntimes;
          const { session, thread: orchestrator, workspaceId } = yield* openOrchestrator(world);
          const releasing = yield* spawn(session, { feature: "release" });
          const mailing = yield* spawn(session, { feature: "mail-trigger" });
          const held = yield* spawn(session, { feature: "voice" });
          // The user writes to one worker mid-turn: it is theirs.
          yield* runtimes.send(held.thread.id, { text: "Wait, look at the logs first." });
          yield* waitReal(
            "the user's hold",
            outboxOf(workspaceId).pipe(
              Effect.map((outbox) => outbox.workers[held.thread.id]?.userIntervened === true),
            ),
          );
          // And to the orchestrator, which is in a turn as the pause lands.
          yield* runtimes.send(orchestrator.id, { text: "How is the release going?" });
          yield* waitSent(orchestrator.id, 2);
          const finishRelease = yield* startCommand(releasing.session, "gh release create v1.2.0");

          yield* orchestration.setPaused(workspaceId, true);
          yield* settle;
          // Each one's gate closes, the held worker's aside, and nothing is interrupted: the
          // release runs on to its end.
          expect(yield* gateClosesOf(orchestrator.id)).toBe(1);
          expect(yield* gateClosesOf(mailing.thread.id)).toBe(1);
          expect(yield* gateClosesOf(releasing.thread.id)).toBe(1);
          expect(yield* gateClosesOf(held.thread.id)).toBe(0);
          expect(yield* runtimes.status(held.thread.id)).toBe("running");
          expect(yield* runtimes.status(releasing.thread.id)).toBe("running");

          yield* finishRelease();
          for (const id of [orchestrator.id, mailing.thread.id, releasing.thread.id]) {
            yield* endsItsTurn(id);
          }
          for (const id of [
            orchestrator.id,
            mailing.thread.id,
            releasing.thread.id,
            held.thread.id,
          ]) {
            expect(yield* interruptsOf(id)).toBe(0);
          }
          expect([...(yield* stoppedOf(workspaceId))].toSorted()).toEqual(
            [orchestrator.id, releasing.thread.id, mailing.thread.id].toSorted(),
          );

          // The held worker carries on with the user, but what isn't theirs waits.
          yield* drain(held.thread.id);
          const before = (yield* sentTo(held.thread.id)).length;
          yield* runtimes.sendNotice(held.thread.id, "review:acme/app#9", {
            text: "Review round on acme/app#9.",
          });
          yield* settle;
          expect(yield* sentTo(held.thread.id)).toHaveLength(before);
          yield* runtimes.send(held.thread.id, { text: "Now go on." });
          yield* waitReal(
            "the user's own word",
            sentTo(held.thread.id).pipe(Effect.map((all) => all.at(-1) === "Now go on.")),
          );

          // Nothing new starts.
          const refused = yield* session
            .callTool("spawn_worker", {
              project: "shop",
              feature: "late",
              title: "Late",
              brief: "Too late.",
            })
            .pipe(Effect.flip);
          expect(String(refused.message)).toContain("paused");

          // And no agent can pause or resume a workspace: only the user's client can.
          const registry = yield* AppToolRegistry;
          for (const [id, transport] of [
            [orchestrator.id, "orchestrator"],
            [mailing.thread.id, "worker"],
          ] as const) {
            const names = registry.forTransport(id, transport).map((t) => t.descriptor.name);
            expect(names.filter((name) => /paus|resum/.test(name))).toEqual([]);
          }
        }),
      ),
    GIT_HEAVY,
  );

  it.effect(
    "holds wakes, notices and digests until the resume, then lets workers go once, in batches",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const runtimes = yield* ThreadRuntimes;
          const { session, thread: orchestrator, workspaceId } = yield* openOrchestrator(world);
          const workers: Array<{
            readonly thread: { readonly id: ThreadId };
            readonly session: FakeSession;
          }> = [];
          for (const feature of ["alpha", "beta", "gamma", "delta"]) {
            workers.push(yield* spawn(session, { feature }));
          }
          const [first, second] = workers;
          yield* first!.session.callTool("schedule_wake", { inMinutes: 2, note: "check CI" });
          const digestsBefore = (yield* sentTo(orchestrator.id)).length;

          yield* orchestration.setPaused(workspaceId, true);
          for (const worker of workers) yield* endsItsTurn(worker.thread.id);
          yield* settle;
          // A review monitor's notices while paused: the newer replaces the older, both held.
          for (const round of [1, 2]) {
            yield* runtimes.sendNotice(second!.thread.id, "review:acme/app#7", {
              text: `Review round ${round} on acme/app#7.`,
            });
          }
          yield* TestClock.adjust("10 minutes");
          yield* settle;
          for (const worker of workers) expect(yield* sentTo(worker.thread.id)).toHaveLength(1);
          expect(yield* sentTo(orchestrator.id)).toHaveLength(digestsBefore);

          yield* orchestration.setPaused(workspaceId, false);
          yield* settle;
          // None at once: the orchestrator's digest goes first.
          for (const worker of workers) expect(yield* sentTo(worker.thread.id)).toHaveLength(1);
          yield* TestClock.adjust("60 seconds");
          const orchestratorSession = yield* waitSent(orchestrator.id, digestsBefore + 1);
          const digest = orchestratorSession.sent.at(-1)!.text;
          expect(digest).toContain("The user paused orchestration at");
          expect(digest).toContain("The pause stopped 4 workers mid-turn");
          expect(yield* outboxOf(workspaceId)).toMatchObject({ resuming: expect.any(Array) });

          // The first batch of three by its gap and jitter, the fourth a gap later.
          const resumed = () =>
            Effect.gen(function* () {
              let count = 0;
              for (const worker of workers) {
                if ((yield* sentTo(worker.thread.id)).length > 1) count++;
              }
              return count;
            });
          yield* TestClock.adjust(LIMIT_RESUME_BATCH_GAP_MS + LIMIT_RESUME_JITTER_MS - 60_000);
          yield* settle;
          expect(yield* resumed()).toBe(3);
          yield* TestClock.adjust(LIMIT_RESUME_BATCH_GAP_MS);
          yield* settle;
          expect(yield* resumed()).toBe(4);
          expect((yield* outboxOf(workspaceId)).resuming).toBeUndefined();

          // Each is told once to continue, and what waited reaches it once: the newest notice.
          for (const worker of workers) yield* drain(worker.thread.id);
          for (const worker of workers) {
            const texts = (yield* sentTo(worker.thread.id)).join("\n");
            expect(texts.match(/Continue where you left off/g)).toHaveLength(1);
          }
          const reviews = (yield* sentTo(second!.thread.id)).join("\n");
          expect(reviews.match(/Review round \d on/g)).toEqual(["Review round 2 on"]);
          const wakes = (yield* sentTo(first!.thread.id)).join("\n");
          expect(wakes.match(/check CI/g)).toHaveLength(1);
          // And no second digest for the same pause.
          yield* TestClock.adjust("10 minutes");
          yield* settle;
          const digests = (yield* sentTo(orchestrator.id)).filter((text) =>
            text.includes("The user paused orchestration at"),
          );
          expect(digests).toHaveLength(1);
        }),
      ),
    GIT_HEAVY,
  );

  it.effect(
    "keeps a held monitor notice held across a restart, a newer one in its place, until the resume",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const ids = yield* withServer(
          world,
          Effect.gen(function* () {
            const orchestration = yield* Orchestration;
            const runtimes = yield* ThreadRuntimes;
            const { session, workspaceId } = yield* openOrchestrator(world);
            const worker = yield* spawn(session, { feature: "review" });
            yield* completeTurn(worker.session);
            yield* orchestration.setPaused(workspaceId, true);
            yield* runtimes.sendNotice(worker.thread.id, "review:acme/app#7", {
              text: "HELD REVIEW 1",
            });
            yield* settle;
            expect(yield* sentTo(worker.thread.id)).toHaveLength(1);
            return { workspaceId, workerId: worker.thread.id };
          }),
        );
        // A restart over the same rows, still paused.
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const orchestration = yield* Orchestration;
            const runtimes = yield* ThreadRuntimes;
            yield* settle;
            expect((yield* store.getWorkspace(ids.workspaceId)).paused?.reason).toBe("user");
            expect(yield* sentTo(ids.workerId)).toEqual([]);
            // Its key came back with it: the newer one under it takes its place.
            yield* runtimes.sendNotice(ids.workerId, "review:acme/app#7", {
              text: "HELD REVIEW 2",
            });
            yield* settle;
            expect(yield* sentTo(ids.workerId)).toEqual([]);
            expect((yield* store.listQueue(ids.workerId)).map((item) => item.input.text)).toEqual([
              "HELD REVIEW 2",
            ]);

            yield* orchestration.setPaused(ids.workspaceId, false);
            yield* TestClock.adjust(LIMIT_RESUME_BATCH_GAP_MS + LIMIT_RESUME_JITTER_MS + 1_000);
            const texts = yield* waitReal(
              "the held notice",
              sentTo(ids.workerId).pipe(Effect.map((all) => all.length > 0 && all)),
            );
            expect(texts.join("\n")).toContain("HELD REVIEW 2");
            expect(texts.join("\n")).not.toContain("HELD REVIEW 1");
          }),
        );
      }),
    GIT_HEAVY,
  );

  it.effect(
    "a report the agent starts by itself while paused is stopped, and told to continue on resume",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "reports" });
          yield* completeTurn(worker.session);
          yield* orchestration.setPaused(workspaceId, true);
          yield* settle;
          // At rest when the pause landed: nothing to stop then.
          expect(yield* stoppedOf(workspaceId)).toEqual([]);
          // Claude reports on a background task, in a turn it opens by itself.
          const messageId = "m-report" as MessageId;
          yield* worker.session.emit({
            type: "chunk",
            messageId,
            chunk: {
              type: "start",
              messageId,
              messageMetadata: { agent: "claude", initiator: "agent" },
            },
          } as AgentEvent);
          yield* endsItsTurn(worker.thread.id);
          yield* waitReal(
            "the stop kept on the pause",
            stoppedOf(workspaceId).pipe(Effect.map((ids) => ids.includes(worker.thread.id))),
          );

          yield* orchestration.setPaused(workspaceId, false);
          yield* TestClock.adjust(LIMIT_RESUME_BATCH_GAP_MS + LIMIT_RESUME_JITTER_MS + 1_000);
          yield* waitReal(
            "the continue",
            sentTo(worker.thread.id).pipe(
              Effect.map((all) => all.some((text) => text.includes("Continue where you left off"))),
            ),
          );
        }),
      ),
    GIT_HEAVY,
  );

  it.effect(
    "a worker the user takes over during the resume's stagger isn't told to continue",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const runtimes = yield* ThreadRuntimes;
          const { session, workspaceId } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "takeover" });
          yield* orchestration.setPaused(workspaceId, true);
          yield* endsItsTurn(worker.thread.id);
          expect(yield* stoppedOf(workspaceId)).toEqual([worker.thread.id]);
          yield* orchestration.setPaused(workspaceId, false);
          yield* settle;
          // Before its batch, the user writes to it: it is theirs.
          yield* runtimes.send(worker.thread.id, { text: "Wait for me; do not continue." });
          yield* waitReal(
            "the user's message",
            sentTo(worker.thread.id).pipe(
              Effect.map((all) => all.at(-1) === "Wait for me; do not continue."),
            ),
          );
          yield* TestClock.adjust("2 minutes");
          yield* settle;
          yield* drain(worker.thread.id);
          const texts = (yield* sentTo(worker.thread.id)).join("\n");
          expect(texts).not.toContain("Continue where you left off");
          const fake = yield* FakeAgentControl;
          const steered = fake.sessions
            .filter((each) => each.options.threadId === worker.thread.id)
            .flatMap((each) => each.steered.map((input) => input.text));
          expect(steered.join("\n")).not.toContain("Continue where you left off");
        }),
      ),
    GIT_HEAVY,
  );
});
