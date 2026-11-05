// Routines: a saved brief on a schedule starts a worker (or wakes the orchestrator) when it comes
// due, through the orchestrator's own spawn. A run missed while Gram was closed runs once on the
// next start; a live worker from the last run makes the next one a skip; a paused workspace holds
// them; and a worker's routine tool always asks the user.
import { describe, expect, it } from "@effect/vitest";
import { type RoutineSchedule, type ThreadId, type WorkspaceId } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { AppToolRegistry, approvalFor } from "../app-tools/registry.ts";
import { hasGit } from "../git/test-repo.ts";
import { Orchestration } from "../orchestration/service.ts";
import {
  completeTurn,
  makeWorld,
  openOrchestrator,
  openOrchestratorAcross,
  outboxOf,
  settle,
  spawn,
  waitReal,
  waitSent,
  withServer,
} from "../orchestration/test-harness.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { HOUR_MS, nextRunAfter } from "./schedule.ts";
import { addRoutine, ranAfter, routineNow, runNow, workerRoutine } from "./test-kit.ts";
import { localZone } from "../zone-time.ts";

/** The routine's workers: the threads whose `spawnedBy` names it. */
const workersOf = (id: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return (yield* store.listThreads).filter((thread) => thread.spawnedBy?.routine?.id === id);
  });

/** A worker routine in the orchestrator's workspace, as the user makes one in Settings. */
const userRoutine = (
  workspaceId: WorkspaceId,
  projectId: string,
  schedule: RoutineSchedule,
  name = "CI triage",
) => workerRoutine(workspaceId, projectId, schedule, name);

describe.skipIf(!hasGit)("routines", () => {
  it.effect(
    "starts a worker when it comes due, marked as the routine's, and reckons the next run",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const { project, workspaceId, thread: orchestrator } = yield* openOrchestrator(world);
            const routine = yield* userRoutine(workspaceId, project.id, {
              every: "hours",
              hours: 6,
            });
            const created = yield* Clock.currentTimeMillis;
            expect(routine.nextRunAt).toBe(created + 6 * HOUR_MS);
            expect(yield* workersOf(routine.id)).toHaveLength(0);

            yield* TestClock.adjust("6 hours");
            const ran = yield* ranAfter(routine.id, created);
            expect(ran.lastRun).toMatchObject({ outcome: "started" });
            expect(ran.nextRunAt).toBe(ran.lastRun!.at + 6 * HOUR_MS);
            const [worker] = yield* workersOf(routine.id);
            expect(worker?.spawnedBy).toMatchObject({
              threadId: orchestrator.id,
              feature: "routine-ci-triage",
              routine: { id: routine.id, name: "CI triage" },
            });
            expect(ran.lastWorker).toBe(worker?.id);
            expect(worker?.checkout.branch).toMatch(/^routine\/ci-triage-\d{8}-\d{4}$/);
            const fake = yield* FakeAgentControl;
            const brief = fake.sessions.find((s) => s.options.threadId === worker?.id)?.sent[0]
              ?.text;
            expect(brief).toContain('started by the scheduled routine "CI triage" (every 6 hours)');
            expect(brief).toContain("It is not a message the user just sent.");
            expect(brief).toContain("Look at main's failing jobs");
          }),
        );
      }),
  );

  it.effect("runs a daily routine at its local time, the next day after", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { project, workspaceId } = yield* openOrchestrator(world);
          const routine = yield* userRoutine(workspaceId, project.id, {
            every: "day",
            at: "09:00",
          });
          const now = yield* Clock.currentTimeMillis;
          expect(routine.nextRunAt).toBe(nextRunAfter(routine.schedule, now, localZone()));
          yield* TestClock.adjust(routine.nextRunAt! - now);
          const ran = yield* ranAfter(routine.id, routine.nextRunAt!);
          expect(ran.lastRun?.outcome).toBe("started");
          expect(ran.nextRunAt).toBe(nextRunAfter(routine.schedule, ran.lastRun!.at, localZone()));
          expect(ran.nextRunAt! - ran.lastRun!.at).toBeGreaterThanOrEqual(23 * HOUR_MS);
        }),
      );
    }),
  );

  it.effect(
    "runs a run missed while Gram was closed once on the next start, never in a burst",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const made = yield* withServer(
          world,
          Effect.gen(function* () {
            const { project, workspaceId } = yield* openOrchestrator(world);
            const routine = yield* userRoutine(workspaceId, project.id, {
              every: "hours",
              hours: 1,
            });
            return { routine, workspaceId };
          }),
        );
        // Closed for three days: seventy-two runs missed.
        yield* TestClock.adjust("72 hours");
        yield* withServer(
          world,
          Effect.gen(function* () {
            yield* settle;
            const start = yield* Clock.currentTimeMillis;
            // Nothing at once: the catch-up waits a minute after the start.
            expect((yield* routineNow(made.routine.id)).lastRun).toBeUndefined();
            yield* TestClock.adjust("1 minute");
            const ran = yield* ranAfter(made.routine.id, start);
            expect(ran.lastRun?.outcome).toBe("started");
            yield* settle;
            expect(yield* workersOf(made.routine.id)).toHaveLength(1);
            // The next is an hour after the catch-up, not one of the missed ones.
            expect(ran.nextRunAt).toBe(ran.lastRun!.at + HOUR_MS);
          }),
        );
      }),
  );

  it.effect("skips a run while the last run's worker is live, and keeps waiting for it", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { project, workspaceId } = yield* openOrchestrator(world);
          const routine = yield* userRoutine(workspaceId, project.id, { every: "hours", hours: 1 });
          yield* TestClock.adjust("1 hour");
          const first = yield* ranAfter(routine.id, 0);
          expect(first.lastRun?.outcome).toBe("started");
          const workerId = first.lastWorker;

          const at = yield* Clock.currentTimeMillis;
          yield* TestClock.adjust("1 hour");
          const second = yield* ranAfter(routine.id, at + 1);
          expect(second.lastRun).toMatchObject({ outcome: "skipped" });
          expect(second.lastRun?.detail).toContain("is still live");
          expect(second.lastWorker).toBe(workerId);
          expect(yield* workersOf(routine.id)).toHaveLength(1);

          // Run now refuses rather than starting a second.
          const refused = yield* runNow(routine.id).pipe(Effect.flip);
          expect(refused.message).toContain("is still live");
          expect(yield* workersOf(routine.id)).toHaveLength(1);
        }),
      );
    }),
  );

  it.effect("holds a due run while the workspace is paused, and runs it once on the resume", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const { project, workspaceId } = yield* openOrchestrator(world);
          const routine = yield* userRoutine(workspaceId, project.id, { every: "hours", hours: 1 });
          yield* orchestration.setPaused(workspaceId, true);
          yield* TestClock.adjust("3 hours");
          yield* waitReal(
            "the routine to wait on the pause",
            routineNow(routine.id).pipe(Effect.map((r) => r.waiting === "paused")),
          );
          const held = yield* routineNow(routine.id);
          expect(held.lastRun).toBeUndefined();
          expect(yield* workersOf(routine.id)).toHaveLength(0);
          const refused = yield* runNow(routine.id).pipe(Effect.flip);
          expect(refused.message).toContain("paused");

          const resumedAt = yield* Clock.currentTimeMillis;
          yield* orchestration.setPaused(workspaceId, false);
          const ran = yield* ranAfter(routine.id, resumedAt);
          expect(ran.lastRun?.outcome).toBe("started");
          expect(ran.waiting).toBeUndefined();
          yield* settle;
          expect(yield* workersOf(routine.id)).toHaveLength(1);
        }),
      );
    }),
  );

  it.effect("puts an orchestrator routine's brief in the next digest", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { workspaceId, thread, session } = yield* openOrchestrator(world);
          yield* settle;
          const routine = yield* addRoutine(workspaceId, {
            name: "Weekly dependency check",
            brief: "Check for outdated dependencies and brief a worker for each bump worth doing.",
            target: "orchestrator",
            schedule: { every: "week", day: 1, at: "08:00" },
          });
          const before = session.sent.length;
          const ran = yield* runNow(routine.id);
          expect(ran.lastRun).toMatchObject({ outcome: "messaged", manual: true });
          // Run now leaves the schedule where it was.
          expect(ran.nextRunAt).toBe(routine.nextRunAt);
          // It goes as the next digest does, after the wake's debounce, as the server's note.
          yield* TestClock.adjust("60 seconds");
          const woken = yield* waitSent(thread.id, before + 1);
          const digest = woken.sent.at(-1)?.text ?? "";
          expect(digest).toContain('Routine "Weekly dependency check" (Mondays at 08:00) is due.');
          expect(digest).toContain("Check for outdated dependencies");
        }),
      );
    }),
  );

  it.effect("records a run that can't start as failed and tells the orchestrator", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { project, other, workspaceId } = yield* openOrchestratorAcross(world);
          const routine = yield* userRoutine(workspaceId, other.id, { every: "hours", hours: 1 });
          const store = yield* ThreadStore;
          // Its project leaves the workspace after the routine was saved.
          const orchestration = yield* Orchestration;
          const state = yield* store.getWorkspace(workspaceId);
          yield* orchestration.saveWorkspace({
            id: workspaceId,
            name: state.workspace.name,
            projectIds: [project.id],
            homeProjectId: project.id,
          });
          const ran = yield* runNow(routine.id);
          expect(ran.lastRun).toMatchObject({ outcome: "failed" });
          expect(ran.lastRun?.detail).toContain("no longer one of the workspace's");
          const outbox = yield* outboxOf(workspaceId);
          expect(
            outbox.notes.some((note) =>
              note.includes('Routine "CI triage" (every hour) couldn\'t run'),
            ),
          ).toBe(true);
        }),
      );
    }),
  );

  it.effect("lets the orchestrator keep routines unasked, and asks the user for a worker's", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const registry = yield* AppToolRegistry;
          const { session, thread } = yield* openOrchestrator(world);
          const worker = yield* spawn(session, { feature: "flakes" });
          yield* completeTurn(worker.session);
          const input = {
            name: "Nightly flake sweep",
            brief: "Rerun the flaky suites and report what still fails.",
            schedule: "daily 2:00",
            target: "worker",
            project: "shop",
          };
          const asks = (threadId: ThreadId, audience: "orchestrator" | "worker", name: string) =>
            Effect.gen(function* () {
              const tool = registry
                .forThread(threadId, audience)
                .find((each) => each.descriptor.name === name);
              expect(tool).toBeDefined();
              return yield* tool!.needsApproval!(
                name === "routine_create" ? input : { routine: "x" },
              );
            });
          expect(yield* asks(thread.id, "orchestrator", "routine_create")).toBe(false);
          expect(yield* asks(thread.id, "orchestrator", "routine_update")).toBe(false);
          expect(yield* asks(worker.thread.id, "worker", "routine_create")).toBe(true);
          // A worker is bound create alone: listing, changing and removing are the orchestrator's.
          const workerTools = registry
            .forThread(worker.thread.id, "worker")
            .map((each) => each.descriptor.name)
            .filter((name) => name.startsWith("routine_"));
          expect(workerTools).toEqual(["routine_create"]);
          // A forced card: neither bypassPermissions nor an earlier allow lifts it.
          expect(approvalFor("self", true)).toBe("forced");

          // The orchestrator's create goes straight through; once approved, a worker's does too.
          const made = (yield* session.callTool("routine_create", input)) as {
            name: string;
            schedule: string;
            nextRunAt?: string;
          };
          expect(made).toMatchObject({
            name: "Nightly flake sweep",
            schedule: "every day at 02:00",
            target: "worker",
          });
          expect(made.nextRunAt).toBeDefined();
          yield* worker.session.callTool("routine_create", {
            ...input,
            name: "Weekly audit",
            schedule: "weekly fri 16:00",
          });
          const charter = () =>
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              return (yield* store.getWorkspace(thread.workspaceId as WorkspaceId)).charter;
            });
          const saved = (yield* charter()).routines ?? [];
          expect(saved.map((routine) => [routine.name, routine.schedule])).toEqual([
            ["Nightly flake sweep", { every: "day", at: "02:00" }],
            ["Weekly audit", { every: "week", day: 5, at: "16:00" }],
          ]);
          expect(saved.every((routine) => routine.id !== undefined)).toBe(true);
          const refused = yield* session
            .callTool("routine_create", { ...input, schedule: "every 0 hours" })
            .pipe(Effect.flip);
          expect(refused.message).toContain("1 to 168 whole hours");
          const garbled = yield* session
            .callTool("routine_create", { ...input, schedule: "at 9pm" })
            .pipe(Effect.flip);
          expect(garbled.message).toContain('"daily HH:MM"');
          const dup = yield* session.callTool("routine_create", input).pipe(Effect.flip);
          expect(dup.message).toContain("already has a routine named");
          const outside = yield* session
            .callTool("routine_create", { ...input, name: "Elsewhere", project: "nowhere" })
            .pipe(Effect.flip);
          expect(outside.message).toContain("isn't one of this workspace's projects");
          // Turned off it keeps its place; removed it goes, its id with it.
          yield* session.callTool("routine_update", { routine: "weekly audit", off: true });
          expect((yield* charter()).routines?.find((r) => r.name === "Weekly audit")?.off).toBe(
            true,
          );
          const renamed = (yield* session.callTool("routine_update", {
            routine: "Nightly flake sweep",
            name: "Flake sweep",
          })) as { name: string };
          expect(renamed.name).toBe("Flake sweep");
          expect((yield* charter()).routines?.find((r) => r.name === "Flake sweep")?.id).toBe(
            saved[0]!.id,
          );
          yield* session.callTool("routine_update", { routine: "Weekly audit", remove: true });
          expect(((yield* charter()).routines ?? []).map((r) => r.name)).toEqual(["Flake sweep"]);
        }),
      );
    }),
  );
});
