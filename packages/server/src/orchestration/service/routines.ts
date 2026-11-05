// Routines (docs/AGENTS_AND_FEATURES.md#routines): each of a workspace's routines starts a fresh
// worker from its approved brief when its schedule comes round. The orchestrator hears of every run
// in its next digest and follows the worker like any other.
import {
  nextRoutineRun,
  routineScheduleText,
  ThreadId,
  type ModelRef,
  type ProjectId,
  type Thread,
  type UserInput,
  type WorkspaceId,
  type WorkspaceRoutine,
  type WorkspaceState,
} from "@gram/contracts";
import { randomUUID } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { withNotes, type OutboxState } from "../outbox.ts";
import type { OrchestrationKit } from "./kit.ts";
import type { Digests } from "./digests.ts";
import type { OrchestrationShape } from "./shape.ts";

/** A run found more than this late (Gram was closed, the machine asleep) still runs, and says so. */
export const ROUTINE_LATE_MS = 15 * 60 * 1000;

/** What routines take from the rest of the service. */
export interface RoutinesDeps {
  readonly wake: Digests["wake"];
  readonly startWorker: (
    workspaceId: WorkspaceId,
    input: {
      readonly id: ThreadId;
      readonly projectId: ProjectId;
      readonly input: UserInput;
      readonly model?: ModelRef;
      readonly name?: string;
    },
  ) => ReturnType<OrchestrationShape["startWorker"]>;
}

export const routineKey = (routine: Pick<WorkspaceRoutine, "name">): string =>
  routine.name.trim().toLowerCase();

/** The brief a routine's worker starts with: the user's approved text, under a line saying whose. */
export const routineBrief = (routine: WorkspaceRoutine): string =>
  [
    `Scheduled routine "${routine.name.trim()}" (${routineScheduleText(routine.schedule)}), set up and approved by the user. Its brief:`,
    "",
    routine.brief.trim(),
    "",
    "When you are done, `report` what you found. If there was nothing to do, report `done` and say so in a line; don't open a pull request for nothing.",
  ].join("\n");

type Run = NonNullable<OutboxState["routineRuns"]>[string];

/** What one routine does on a tick, decided from what is stored. Pure. */
export type RoutineStep =
  | { readonly _tag: "baseline" }
  | { readonly _tag: "wait" }
  | { readonly _tag: "skip"; readonly why: string }
  | { readonly _tag: "run"; readonly late: boolean };

export const routineStep = (input: {
  readonly routine: WorkspaceRoutine;
  readonly run: Run | undefined;
  readonly now: number;
  readonly paused: boolean;
  readonly hasOrchestrator: boolean;
  /** The worker the last run started is still at work. */
  readonly previousLive: boolean;
}): RoutineStep => {
  const { routine, run, now } = input;
  // A routine first seen, or turned on again, waits for its next time rather than running now.
  if (run === undefined) return { _tag: "baseline" };
  const due = nextRoutineRun(routine.schedule, run.lastAt);
  if (due > now) return { _tag: "wait" };
  if (input.paused) return { _tag: "skip", why: "the workspace is paused" };
  if (!input.hasOrchestrator)
    return { _tag: "skip", why: "the workspace has no orchestrator open" };
  if (input.previousLive)
    return { _tag: "skip", why: "the worker its last run started is still at it" };
  return { _tag: "run", late: now - due > ROUTINE_LATE_MS };
};

/** Whether `thread`, a routine's last worker, still works: open, not completed, not done. */
const stillAtIt = (thread: Thread | undefined, lastReport: string | undefined): boolean =>
  thread !== undefined &&
  !thread.parked &&
  thread.completedAt === undefined &&
  lastReport !== "done";

export const makeRoutines = (kit: OrchestrationKit, deps: RoutinesDeps) => {
  const { store, findThread, updateOutbox, readOutbox } = kit;

  const setRun = (workspaceId: WorkspaceId, key: string, run: Run) =>
    updateOutbox(workspaceId, (outbox) => [
      { ...outbox, routineRuns: { ...outbox.routineRuns, [key]: run } },
      undefined,
    ]);

  const tell = (workspaceId: WorkspaceId, note: string) =>
    Effect.gen(function* () {
      yield* updateOutbox(workspaceId, (outbox) => [withNotes(outbox, [note]), undefined]);
      yield* deps.wake(workspaceId, "a routine ran", true);
    });

  /** Forgets runs of routines the charter no longer has, so a name used again starts afresh. */
  const prune = (workspaceId: WorkspaceId, keys: ReadonlySet<string>) =>
    updateOutbox(workspaceId, (outbox) => {
      const runs = outbox.routineRuns;
      if (runs === undefined || Object.keys(runs).every((key) => keys.has(key))) {
        return [outbox, undefined];
      }
      const kept = Object.fromEntries(Object.entries(runs).filter(([key]) => keys.has(key)));
      return [{ ...outbox, routineRuns: kept }, undefined];
    });

  const tickWorkspace = (state: WorkspaceState) =>
    Effect.gen(function* () {
      const workspaceId = state.workspace.id;
      const routines = (state.charter.routines ?? []).filter((routine) => routine.off !== true);
      const outbox = yield* readOutbox(workspaceId);
      if (routines.length === 0 && outbox.routineRuns === undefined) return;
      yield* prune(workspaceId, new Set(routines.map(routineKey)));
      if (routines.length === 0) return;
      const holder = state.workspace.orchestratorThreadId;
      const hasOrchestrator = holder !== undefined && (yield* findThread(holder)) !== undefined;
      for (const routine of routines) {
        const key = routineKey(routine);
        const run = outbox.routineRuns?.[key];
        const now = yield* Clock.currentTimeMillis;
        const previous = run?.threadId === undefined ? undefined : yield* findThread(run.threadId);
        const lastReport =
          previous === undefined
            ? undefined
            : (yield* store.latestWorkerReports(workspaceId, [previous.id]))[0]?.report.state;
        const step = routineStep({
          routine,
          run,
          now,
          paused: state.paused !== undefined,
          hasOrchestrator,
          previousLive: stillAtIt(previous, lastReport),
        });
        const when = routineScheduleText(routine.schedule);
        switch (step._tag) {
          case "wait":
            break;
          case "baseline":
            yield* setRun(workspaceId, key, { lastAt: now });
            break;
          case "skip":
            yield* setRun(workspaceId, key, { ...run, lastAt: now });
            yield* tell(
              workspaceId,
              `Routine "${routine.name}" (${when}) skipped a run: ${step.why}.`,
            );
            break;
          case "run": {
            const id = Schema.decodeSync(ThreadId)(randomUUID());
            // Stored before the start, so a crash part-way never runs it twice.
            yield* setRun(workspaceId, key, { lastAt: now, threadId: id });
            const started = yield* deps
              .startWorker(workspaceId, {
                id,
                projectId: routine.project ?? state.workspace.homeProjectId,
                input: { text: routineBrief(routine), author: "server" },
                name: routine.name,
                ...(routine.model === undefined ? {} : { model: routine.model }),
              })
              .pipe(Effect.result);
            yield* tell(
              workspaceId,
              Result.isSuccess(started)
                ? `Routine "${routine.name}" (${when}) started worker "${started.success.title}" [thread ${started.success.id}]${step.late ? ", late, as Gram wasn't running at its time" : ""}. Follow it like your own; its brief is the user's.`
                : `Routine "${routine.name}" (${when}) couldn't start its worker: ${started.failure.message}`,
            );
            break;
          }
        }
      }
    });

  /** One look at every workspace's routines; a workspace that fails is logged and the rest go on. */
  const tickRoutines = Effect.gen(function* () {
    for (const state of yield* store.listWorkspaces) {
      yield* tickWorkspace(state).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("routine tick failed").pipe(
            Effect.annotateLogs({ workspaceId: state.workspace.id, cause: Cause.pretty(cause) }),
          ),
        ),
      );
    }
  });

  return { tickRoutines };
};
