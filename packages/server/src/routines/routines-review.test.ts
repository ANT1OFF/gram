// Routines, the independent review's six findings on #198, each reproduced through the real service:
// admission races another spawn past the worker cap; a run cut short by a restart is never started
// twice; a released held brief still counts as the routine's live worker; a run never raises a card;
// a timer-driven run still notifies and notes its failure; and a blank name is refused.
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  LIMIT_PAUSE_TOOL,
  OrchestratorCharter,
  type AgentFailureKind,
  type MessageId,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { hasGit } from "../git/test-repo.ts";
import { workerThreadId } from "../orchestration/outbox.ts";
import { Orchestration } from "../orchestration/service.ts";
import {
  atAutonomy,
  collectEvents,
  completeTurn,
  makeWorld,
  openOrchestrator,
  openOrchestratorAcross,
  outboxOf,
  settle,
  spawn,
  waitReal,
  withServer,
  type World,
} from "../orchestration/test-harness.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, type FakeSession } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import {
  addRoutine,
  editRoutine,
  ranAfter,
  routineNow,
  runNow,
  stageState,
  stateOf,
  workerRoutine,
} from "./test-kit.ts";

const HOUR = 3_600_000;
const SLOW = { timeout: 90_000 } as const;

const workersOf = (id: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listThreads).filter((thread) => thread.spawnedBy?.routine?.id === id);
  });

/** The limit cards open on the orchestrator's thread. */
const pauseCards = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listRequests(threadId)).filter(
      (request) => request.kind === "approval" && request.toolName === LIMIT_PAUSE_TOOL,
    );
  });

/** A worker's turn fails before any output, which trips the spawn breaker on its model. */
const failBeforeOutput = (session: FakeSession, id: ThreadId, kind: AgentFailureKind = "network") =>
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

describe.skipIf(!hasGit)("routines: review findings", () => {
  it.effect(
    "[1] admits a routine's worker under the spawn's own lock, so a spawn racing it can't take the cap past its limit",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { thread, project, workspaceId } = yield* openOrchestrator(world);
            const session = yield* atAutonomy(thread, "full", { maxConcurrentWorkers: 1 });
            const routine = yield* workerRoutine(workspaceId, project.id);
            // The orchestrator's spawn is inside its worktree work when the routine runs.
            const racing = yield* session
              .callTool("spawn_worker", {
                project: "shop",
                feature: "racing",
                title: "Racing spawn",
                brief: "Do the racing work.",
              })
              .pipe(Effect.forkScoped);
            for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
            const ran = yield* runNow(routine.id);
            yield* Fiber.join(racing);
            yield* settle;
            const store = yield* ThreadStore;
            const live = (yield* store.listThreads).filter(
              (each) => each.workspaceId === workspaceId && each.spawnedBy !== undefined,
            );
            expect(live).toHaveLength(1);
            expect(yield* workersOf(routine.id)).toHaveLength(0);
            expect(ran.lastRun).toMatchObject({ outcome: "failed" });
            expect(ran.lastRun?.detail).toContain("approval");
          }),
        );
      }),
    SLOW,
  );

  it.effect(
    "[2] keeps one worker per scheduled run when a restart cuts the run short after its spawn",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const { project, workspaceId } = yield* openOrchestrator(world);
            const routine = yield* workerRoutine(workspaceId, project.id);
            const before = yield* routineNow(routine.id);
            yield* TestClock.adjust("1 hour");
            const ran = yield* ranAfter(routine.id, 0);
            expect(ran.lastRun?.outcome).toBe("started");
            yield* settle;
            // The crash: the claim and the worker exist, but the record of the run never landed.
            const claim = {
              requestId: `routine:${routine.id}:${before.nextRunAt}`,
              slot: before.nextRunAt!,
            };
            yield* stageState(routine.id, { ...stateOf(before), claim });
            // The run's spawn was keyed by the routine and its slot, so any retry of it is that worker.
            expect(ran.lastRun!.threadId).toBe(
              workerThreadId(workspaceId, `routine:${routine.id}:${before.nextRunAt}`),
            );
            // Kept while its worker is live: the occurrence hasn't settled.
            expect(ran.claim?.threadId).toBe(ran.lastRun!.threadId);
            return { id: routine.id, workerId: ran.lastRun!.threadId! };
          }),
        );
        yield* withServer(
          world,
          Effect.gen(function* () {
            yield* settle;
            const start = yield* Clock.currentTimeMillis;
            expect((yield* routineNow(first.id)).lastRun).toBeUndefined();
            yield* TestClock.adjust("1 minute");
            const caught = yield* ranAfter(first.id, start);
            yield* settle;
            expect((yield* workersOf(first.id)).map((each) => each.id)).toEqual([first.workerId]);
            expect(caught.lastWorker).toBe(first.workerId);
          }),
        );
      }),
    SLOW,
  );

  it.effect(
    "[3] counts the worker a held run's brief became once it is released, so the next run is skipped",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const orchestration = yield* Orchestration;
            const { thread, project, workspaceId } = yield* openOrchestrator(world);
            const session = yield* atAutonomy(thread, "full", {
              maxConcurrentWorkers: 8,
              workerModels: [{ agent: "claude", model: "fake-opus", default: true }],
            });
            // A worker on the routine's model fails before any output: spawns on it are held.
            const failed = yield* spawn(session, { feature: "failed" });
            yield* failBeforeOutput(failed.session, failed.thread.id);

            const routine = yield* workerRoutine(workspaceId, project.id);
            const held = yield* runNow(routine.id);
            expect(held.lastRun?.outcome).toBe("held");
            const heldId = held.lastRun!.heldId!;

            const released = yield* orchestration.releaseHeldBrief(workspaceId, heldId);
            expect(released.spawnedBy?.routine).toEqual({ id: routine.id, name: "CI triage" });
            yield* settle;

            const again = yield* runNow(routine.id).pipe(Effect.flip);
            expect(again.message).toContain("is still live");
            expect(yield* workersOf(routine.id)).toHaveLength(1);
            expect((yield* outboxOf(workspaceId)).heldBriefs ?? []).toHaveLength(0);
            expect((yield* routineNow(routine.id)).lastWorker).toBe(released.id);
          }),
        );
      }),
    SLOW,
  );

  it.effect(
    "[4] never raises the limit card from a routine's run, and records why it didn't start",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { thread, project, workspaceId } = yield* openOrchestrator(world);
            const session = yield* atAutonomy(thread, "full", { pauseAtLimitPct: 90 });
            const now = yield* Clock.currentTimeMillis;
            yield* session.emit({
              type: "rateLimit",
              status: "warning",
              window: "five_hour",
              utilization: 0.92,
              resetsAt: now + HOUR,
            });
            const readings = yield* UsageLimitReadings;
            yield* waitReal(
              "the 92% reading",
              readings.current.pipe(
                Effect.map((all) => all.some((each) => each.utilization === 0.92)),
              ),
            );
            const routine = yield* workerRoutine(workspaceId, project.id);
            const running = yield* runNow(routine.id).pipe(Effect.forkScoped);
            const ran = yield* waitReal(
              "the run to end without asking",
              Effect.sync(() => running.pollUnsafe()),
            );
            expect(yield* pauseCards(thread.id)).toEqual([]);
            const done = yield* Fiber.join(running);
            expect(ran._tag).toBe("Success");
            expect(done.lastRun).toMatchObject({ outcome: "failed" });
            expect(done.lastRun?.detail).toContain("92%");
            expect(yield* workersOf(routine.id)).toHaveLength(0);
            // The routines' lock was let go: another run goes through it, and ends the same way.
            const again = yield* runNow(routine.id);
            expect(again.lastRun).toMatchObject({ outcome: "failed" });
            yield* editRoutine(routine.id, (each) => ({ ...each, off: true }));
            expect((yield* routineNow(routine.id)).enabled).toBe(false);
            expect(DEFAULT_CHARTER.pauseAtLimitPct).toBeUndefined();
          }),
        );
      }),
    SLOW,
  );

  it.effect(
    "[5] tells the windows and the orchestrator about a run its own timer made, and keeps the next one armed",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const orchestration = yield* Orchestration;
            const { project, other, workspaceId } = yield* openOrchestratorAcross(world);
            const routine = yield* workerRoutine(workspaceId, other.id);
            const state = yield* store.getWorkspace(workspaceId);
            yield* orchestration.saveWorkspace({
              id: workspaceId,
              name: state.workspace.name,
              projectIds: [project.id],
              homeProjectId: project.id,
            });
            const events = yield* collectEvents(["routines.changed"]);
            const seen = events.length;
            yield* TestClock.adjust("1 hour");
            const ran = yield* ranAfter(routine.id, 0);
            expect(ran.lastRun?.outcome).toBe("failed");
            yield* settle;
            expect(events.length).toBeGreaterThan(seen);
            expect((yield* outboxOf(workspaceId)).notes).toContainEqual(
              expect.stringContaining('Routine "CI triage" (every hour) couldn\'t run'),
            );
            // The next run is still armed, an hour on.
            const at = ran.lastRun!.at;
            yield* TestClock.adjust("1 hour");
            const next = yield* ranAfter(routine.id, at + 1);
            expect(next.lastRun?.outcome).toBe("failed");
          }),
        );
      }),
    SLOW,
  );

  it.effect("[6] refuses a name or brief that is only whitespace, and trims a name", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { project, workspaceId, session } = yield* openOrchestrator(world);
          // The user's save is the charter RPC, whose payload decodes before anything is stored.
          const routine = {
            name: "   ",
            brief: "Triage.",
            project: project.id,
            schedule: { every: "day" as const, at: "09:00" },
          };
          const decode = Schema.decodeUnknownSync(OrchestratorCharter);
          expect(() => decode({ ...DEFAULT_CHARTER, routines: [routine] })).toThrow();
          expect(() =>
            decode({
              ...DEFAULT_CHARTER,
              routines: [{ ...routine, name: "Triage", brief: " \n " }],
            }),
          ).toThrow();
          // The orchestrator's tool refuses one before it reaches the charter.
          const blank = yield* session
            .callTool("routine_create", {
              name: "   ",
              brief: "Triage.",
              schedule: "daily 09:00",
              target: "worker",
            })
            .pipe(Effect.flip);
          expect(blank.message).toContain("Invalid input");

          const made = yield* addRoutine(workspaceId, { ...routine, name: "  CI triage  " });
          expect(made.name).toBe("CI triage");
          const renamed = yield* session
            .callTool("routine_update", { routine: "CI triage", name: "\t " })
            .pipe(Effect.flip);
          expect(renamed.message).toContain("Invalid input");
          expect((yield* routineNow(made.id)).name).toBe("CI triage");
        }),
      );
    }),
  );
});

/** A healthy worker's first output: the spawn breaker clears, and its held briefs are released. */
const output = (session: FakeSession, messageId: string) =>
  session.emit(
    { type: "chunk", messageId: messageId as MessageId, chunk: { type: "start" } },
    { type: "chunk", messageId: messageId as MessageId, chunk: { type: "text-start", id: "t" } },
    {
      type: "chunk",
      messageId: messageId as MessageId,
      chunk: { type: "text-delta", id: "t", delta: "Model reached" },
    },
  );

/** The workspace's workers that count against its cap. */
const liveWorkers = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const ledger = yield* (yield* Orchestration).ledger(workspaceId);
    return ledger.budget.liveWorkers;
  });

/**
 * An orchestrator at full autonomy whose default worker model just failed before any output, so
 * the spawn breaker holds new spawns on it; `fake-haiku` stays clear. A healthy worker on the
 * default model is there to clear it on its first output.
 */
const brokenModel = (world: World, cap: number) =>
  Effect.gen(function* () {
    const opened = yield* openOrchestrator(world);
    const session = yield* atAutonomy(opened.thread, "full", {
      maxConcurrentWorkers: cap,
      workerModels: [
        { agent: "claude", model: "fake-opus", default: true },
        { agent: "claude", model: "fake-haiku", useFor: "small chores" },
      ],
    });
    const healthy = yield* spawn(session, { feature: "healthy" });
    yield* output(healthy.session, "early");
    const failed = yield* spawn(session, { feature: "failed" });
    yield* failBeforeOutput(failed.session, failed.thread.id);
    return { ...opened, session, healthy };
  });

describe.skipIf(!hasGit)("routines: second review, the run lifecycle", () => {
  it.effect(
    "[7] keeps a routine's held brief unattended, so its automatic release is admitted under the spawn lock",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { project, workspaceId, session, healthy } = yield* brokenModel(world, 3);
            const routine = yield* workerRoutine(workspaceId, project.id);
            const held = yield* runNow(routine.id);
            expect(held.lastRun?.outcome).toBe("held");
            const stored = (yield* outboxOf(workspaceId)).heldBriefs?.find(
              (brief) => brief.id === held.lastRun?.heldId,
            );
            expect(stored?.input.unattended).toBe(true);
            expect(yield* liveWorkers(workspaceId)).toBe(2);
            // The orchestrator's own spawn takes the third slot while the release looks for one.
            const racing = yield* session
              .callTool("spawn_worker", {
                project: "shop",
                feature: "racing",
                title: "Racing spawn",
                brief: "Do the racing work.",
                model: "claude:fake-haiku",
              })
              .pipe(Effect.forkScoped);
            for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
            yield* output(healthy.session, "later");
            yield* Fiber.join(racing);
            yield* settle;
            yield* waitReal(
              "the release to be decided",
              outboxOf(workspaceId).pipe(
                Effect.map(
                  (outbox) =>
                    (outbox.heldBriefs ?? []).some((brief) => brief.waitsForSlot === true) ||
                    (outbox.heldBriefs ?? []).length === 0,
                ),
              ),
            );
            yield* settle;
            expect(yield* liveWorkers(workspaceId)).toBeLessThanOrEqual(3);
            expect(yield* workersOf(routine.id)).toHaveLength(0);
            expect((yield* outboxOf(workspaceId)).heldBriefs).toEqual([
              expect.objectContaining({ id: held.lastRun?.heldId, waitsForSlot: true }),
            ]);
          }),
        );
      }),
    SLOW,
  );

  it.effect(
    "[8] counts a held run as live while its release is under way, and never starts a second",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const orchestration = yield* Orchestration;
            const { project, workspaceId } = yield* brokenModel(world, 8);
            const routine = yield* workerRoutine(workspaceId, project.id);
            const held = yield* runNow(routine.id);
            expect(held.lastRun?.outcome).toBe("held");
            // The user starts the held brief; its worktree is still being made when Run now comes.
            const release = yield* orchestration
              .releaseHeldBrief(workspaceId, held.lastRun!.heldId!)
              .pipe(Effect.forkScoped);
            for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
            const second = yield* runNow(routine.id).pipe(Effect.flip);
            const released = yield* Fiber.join(release);
            yield* settle;
            expect(second.message).toContain("is still live");
            expect((yield* workersOf(routine.id)).map((each) => each.id)).toEqual([released.id]);
            expect((yield* outboxOf(workspaceId)).heldBriefs ?? []).toHaveLength(0);
            expect((yield* routineNow(routine.id)).claim?.threadId).toBe(released.id);
          }),
        );
      }),
    SLOW,
  );

  it.effect(
    "[9] finishes a worker a restart left without its brief, instead of skipping behind it",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const made = yield* withServer(
          world,
          Effect.gen(function* () {
            const { project, workspaceId, thread: orchestrator } = yield* openOrchestrator(world);
            const routine = yield* workerRoutine(workspaceId, project.id);
            const slot = routine.nextRunAt!;
            const requestId = `routine:${routine.id}:${slot}`;
            const threadId = workerThreadId(workspaceId, requestId);
            // The crash: the run claimed its slot and its worker's row was made, then the app quit
            // before the brief was sent or the spawn recorded.
            yield* stageState(routine.id, { ...stateOf(routine), claim: { requestId, slot } });
            const runtimes = yield* ThreadRuntimes;
            yield* runtimes.create({
              id: threadId,
              projectRoot: world.repo,
              checkout: { kind: "main", path: world.repo },
              title: routine.name,
              workspaceId,
              spawnedBy: {
                threadId: orchestrator.id,
                feature: "routine-ci-triage",
                routine: { id: routine.id, name: routine.name },
              },
              deferOpen: true,
            });
            return { id: routine.id, threadId, slot };
          }),
        );
        yield* withServer(
          world,
          Effect.gen(function* () {
            yield* settle;
            // The look a minute after the start finds it, before its slot comes round again.
            yield* TestClock.adjust("1 minute");
            const ran = yield* ranAfter(made.id, 0);
            expect(ran.lastRun).toMatchObject({ outcome: "started", threadId: made.threadId });
            expect(ran.lastRun?.detail).toContain("restart had cut short");
            const fake = yield* FakeAgentControl;
            const brief = yield* waitReal(
              "the stranded worker's brief",
              Effect.sync(
                () =>
                  fake.sessions.find((each) => each.options.threadId === made.threadId)?.sent[0],
              ),
            );
            expect(brief.text).toContain('started by the scheduled routine "CI triage"');
            expect((yield* workersOf(made.id)).map((each) => each.id)).toEqual([made.threadId]);
          }),
        );
      }),
    SLOW,
  );

  it.effect(
    "[10] drops a claim the new schedule no longer has, so an old parked worker can't take the new slot",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const { project, workspaceId } = yield* openOrchestrator(world);
            const routine = yield* workerRoutine(workspaceId, project.id);
            yield* TestClock.adjust("1 hour");
            const ran = yield* ranAfter(routine.id, 0);
            const old = ran.lastRun!.threadId!;
            yield* settle;
            const runtimes = yield* ThreadRuntimes;
            yield* runtimes.updateThread(old, (t) => ({ ...t, parked: true }));
            // A crash left that run's claim on the routine, as a run cut short does.
            const claim = {
              requestId: `routine:${routine.id}:${routine.nextRunAt}`,
              slot: routine.nextRunAt!,
            };
            yield* stageState(routine.id, { ...stateOf(ran), claim });
            return { id: routine.id, old, slot: claim.slot };
          }),
        );
        yield* withServer(
          world,
          Effect.gen(function* () {
            yield* settle;
            // The user moves the schedule; the next run is reckoned on the new one.
            yield* editRoutine(first.id, (each) => ({
              ...each,
              schedule: { every: "hours", hours: 3 },
            }));
            const rescheduled = yield* waitReal(
              "the new schedule reckoned",
              routineNow(first.id).pipe(
                Effect.map((each) =>
                  each.scheduleKey === JSON.stringify({ every: "hours", hours: 3 }) &&
                  each.nextRunAt !== first.slot
                    ? each
                    : undefined,
                ),
              ),
            );
            expect(rescheduled.nextRunAt).not.toBe(first.slot);
            const at = yield* Clock.currentTimeMillis;
            yield* TestClock.adjust("3 hours");
            const next = yield* ranAfter(first.id, at + 1);
            expect(next.lastRun?.outcome).toBe("started");
            expect(next.lastRun?.threadId).not.toBe(first.old);
            expect(next.claim?.slot).toBe(rescheduled.nextRunAt);
            expect(yield* workersOf(first.id)).toHaveLength(2);
          }),
        );
      }),
    SLOW,
  );

  it.effect(
    "[11] puts an orchestrator routine's note in the digest once, though a restart repeats the run",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const first = yield* withServer(
          world,
          Effect.gen(function* () {
            const { workspaceId, thread } = yield* openOrchestrator(world);
            const routine = yield* addRoutine(workspaceId, {
              name: "Weekly dependency check",
              brief: "Check for outdated dependencies.",
              target: "orchestrator",
              schedule: { every: "hours", hours: 1 },
            });
            const before = yield* routineNow(routine.id);
            yield* TestClock.adjust("1 hour");
            yield* ranAfter(routine.id, 0);
            // The crash: the note is in the outbox, the run's record of it never landed.
            const claim = {
              requestId: `routine:${routine.id}:${before.nextRunAt}`,
              slot: before.nextRunAt!,
            };
            yield* stageState(routine.id, { ...stateOf(before), claim });
            return { id: routine.id, workspaceId, orchestrator: thread.id };
          }),
        );
        yield* withServer(
          world,
          Effect.gen(function* () {
            yield* settle;
            const start = yield* Clock.currentTimeMillis;
            yield* TestClock.adjust("1 minute");
            yield* ranAfter(first.id, start);
            yield* TestClock.adjust("2 minutes");
            yield* settle;
            const fake = yield* FakeAgentControl;
            const digests = () =>
              fake.sessions
                .filter((each) => each.options.threadId === first.orchestrator)
                .flatMap((each) => each.sent.map((input) => input.text))
                .filter((text) => text.includes('Routine "Weekly dependency check"'));
            const key = (yield* outboxOf(first.workspaceId)).noteKeys ?? [];
            expect(key.filter((each) => each.startsWith(`routine:${first.id}:`))).toHaveLength(1);
            const pending = (yield* outboxOf(first.workspaceId)).notes.filter((text) =>
              text.includes('Routine "Weekly dependency check"'),
            );
            // Once: in one digest, or still waiting for one, never both twice.
            expect(digests().length + (digests().length === 0 ? pending.length : 0)).toBe(1);
            expect(pending.length).toBeLessThanOrEqual(1);
            // Once that digest is taken, nothing brings the note back.
            if (digests().length === 1) {
              yield* completeTurn(yield* fake.latest(first.orchestrator));
            }
            yield* TestClock.adjust("5 minutes");
            yield* settle;
            expect(digests()).toHaveLength(1);
          }),
        );
      }),
    SLOW,
  );
});
