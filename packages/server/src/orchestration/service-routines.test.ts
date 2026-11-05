// Routines: a workspace's routine starts a fresh worker from its brief when its time comes round,
// and the orchestrator hears of each run.
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, type WorkspaceId, type WorkspaceRoutine } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { Orchestration } from "./service.ts";
import { encodeOutbox } from "./outbox.ts";
import { routineStep } from "./service/routines.ts";
import { GIT_HEAVY, openOrchestrator, outboxOf, settle, waitReal } from "./test-harness.ts";
import { allSent, inServer } from "./service-kit.ts";

const triage: WorkspaceRoutine = {
  name: "CI triage",
  brief: "Look at main's failing checks and say which are flaky.",
  schedule: { every: "day", at: "06:00" },
};

const HOUR = 60 * 60 * 1000;

/** Moves the routine's last run `by` ms back, as if a day had passed since. */
const backdate = (workspaceId: WorkspaceId, by: number) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const outbox = yield* outboxOf(workspaceId);
    const run = outbox.routineRuns?.["ci triage"];
    if (run === undefined) throw new Error("no run to move back");
    yield* store.putOutbox(
      workspaceId,
      encodeOutbox({
        ...outbox,
        routineRuns: { "ci triage": { ...run, lastAt: run.lastAt - by } },
      }),
    );
  });

describe("routineStep", () => {
  const base = {
    routine: triage,
    paused: false,
    hasOrchestrator: true,
    previousLive: false,
  };
  // 05:00 local on a day, so the routine's 06:00 is an hour on.
  const at5 = new Date(2026, 10, 5, 5, 0).getTime();

  it("takes a baseline the first time, rather than running at once", () => {
    expect(routineStep({ ...base, run: undefined, now: at5 })).toEqual({ _tag: "baseline" });
  });

  it("waits for its time, then runs, and says when it runs late", () => {
    const run = { lastAt: at5 };
    expect(routineStep({ ...base, run, now: at5 + 30 * 60 * 1000 })).toEqual({ _tag: "wait" });
    expect(routineStep({ ...base, run, now: at5 + HOUR + 60_000 })).toEqual({
      _tag: "run",
      late: false,
    });
    expect(routineStep({ ...base, run, now: at5 + 5 * HOUR })).toEqual({ _tag: "run", late: true });
  });

  it("skips a due run while paused, without an orchestrator, or while its last worker works", () => {
    const run = { lastAt: at5 };
    const now = at5 + 2 * HOUR;
    expect(routineStep({ ...base, run, now, paused: true })).toMatchObject({ _tag: "skip" });
    expect(routineStep({ ...base, run, now, hasOrchestrator: false })).toMatchObject({
      _tag: "skip",
    });
    expect(routineStep({ ...base, run, now, previousLive: true })).toMatchObject({
      _tag: "skip",
      why: "the worker its last run started is still at it",
    });
  });
});

describe.skipIf(!hasGit)("routines in the orchestration service", () => {
  it.effect(
    "starts a fresh worker from the routine's brief when its time comes, and tells the orchestrator",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const orchestration = yield* Orchestration;
          const store = yield* ThreadStore;
          const { workspaceId } = yield* openOrchestrator(world);
          yield* orchestration.setCharter(workspaceId, { ...DEFAULT_CHARTER, routines: [triage] });
          // The change wakes the routine timer, whose first look only takes a baseline.
          const baseline = yield* waitReal(
            "the routine's baseline",
            outboxOf(workspaceId).pipe(Effect.map((outbox) => outbox.routineRuns?.["ci triage"])),
          );
          expect(baseline).toMatchObject({ lastAt: expect.any(Number) });
          expect(baseline?.threadId).toBeUndefined();

          // Its last look a day back, so its 06:00 has come round at least once. The run is moved
          // back rather than the clock forward, which would time out the worker's git under it.
          yield* backdate(workspaceId, 25 * HOUR);
          yield* orchestration.tickRoutines;
          const worker = yield* waitReal(
            "the routine's worker",
            store.listThreads.pipe(
              Effect.map((threads) =>
                threads.find(
                  (thread) =>
                    thread.workspaceId === workspaceId && thread.spawnedBy?.feature === "ci-triage",
                ),
              ),
            ),
          );
          const sent = yield* waitReal(
            "the routine's brief",
            allSent(worker.id).pipe(Effect.map((texts) => texts.length > 0 && texts)),
          );
          expect(sent[0]).toContain('Scheduled routine "CI triage" (every day at 06:00)');
          expect(sent[0]).toContain("Look at main's failing checks and say which are flaky.");
          const after = yield* outboxOf(workspaceId);
          expect(after.routineRuns?.["ci triage"]?.threadId).toBe(worker.id);
          expect(after.notes.join("\n")).toContain(
            `Routine "CI triage" (every day at 06:00) started worker`,
          );

          // Its worker is still at it a day later, so that run is skipped and said.
          yield* backdate(workspaceId, 25 * HOUR);
          yield* orchestration.tickRoutines;
          yield* settle;
          const spawned = (yield* store.listThreads).filter(
            (thread) => thread.spawnedBy?.feature.startsWith("ci-triage") === true,
          );
          expect(spawned).toHaveLength(1);
          expect((yield* outboxOf(workspaceId)).notes.join("\n")).toContain(
            "skipped a run: the worker its last run started is still at it",
          );

          // Removing the routine forgets its runs.
          yield* orchestration.setCharter(workspaceId, DEFAULT_CHARTER);
          expect((yield* outboxOf(workspaceId)).routineRuns).toBeUndefined();
        }),
      ),
    GIT_HEAVY,
  );
});
