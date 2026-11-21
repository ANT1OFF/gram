import { HostFailed, type HostId, type HostUnavailable, type ThreadId } from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import { makeKeyedLock } from "../git/keyed-lock.ts";
import { JOB_KEPT_MS, JOB_WAIT_MAX_MS } from "./budgets.ts";

export type MachineJobKind = "resume" | "prepare";
export type MachineJobState = "queued" | "running" | "done" | "failed";
export type JobFolderState = "queued" | "running" | "restored" | "there" | "missing" | "refused";

export interface JobFolder {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly state: JobFolderState;
  readonly note?: string;
  /** When the step began on it, and when it was done with it. */
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface MachineJob {
  readonly id: string;
  readonly kind: MachineJobKind;
  readonly machine: HostId;
  readonly key?: string;
  readonly state: MachineJobState;
  /** Counts its changes: a poll waits until it is past the one it saw. */
  readonly version: number;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** When it last made progress: its start, a folder started, or a folder done. */
  readonly progressAt: number;
  /** The longest it goes without progress once running; past that it fails by itself. */
  readonly budgetMs: number;
  readonly progress: { readonly done: number; readonly total: number };
  readonly folders?: ReadonlyArray<JobFolder>;
  /** What the synchronous route answers, once done. */
  readonly result?: unknown;
  /** What the synchronous route fails with, once failed. */
  readonly error?: { readonly status: number; readonly message: string };
}

/** What a step says of itself as it goes. */
export interface JobReport {
  /** Every folder the step will go through, each queued. */
  readonly folders: (
    all: ReadonlyArray<{ readonly threadId: ThreadId; readonly cwd: string }>,
  ) => Effect.Effect<void>;
  /**
   * One folder started, or done with: each counts as progress, so the job's budget is a folder's
   * at a time however many folders it has, and one large clone under way never reads as stalled.
   */
  readonly folder: (
    threadId: ThreadId,
    cwd: string,
    state: Exclude<JobFolderState, "queued">,
    note?: string,
  ) => Effect.Effect<void>;
  /** Progress that isn't a folder. */
  readonly progressed: Effect.Effect<void>;
}

export interface JobSpec<A> {
  readonly kind: MachineJobKind;
  readonly machine: HostId;
  readonly key?: string | undefined;
  readonly budgetMs: number;
  readonly run: (report: JobReport) => Effect.Effect<A, HostFailed | HostUnavailable>;
}

export interface MachineJobs {
  /** Starts the step as a job, or gives back the one it joins. */
  readonly start: <A>(
    spec: JobSpec<A>,
  ) => Effect.Effect<{ readonly job: MachineJob; readonly joined: boolean }>;
  readonly get: (id: string) => MachineJob | undefined;
  /**
   * The job once its `version` is past `seen` (at once without `seen`), or once `waitMs` passes
   * (at most `JOB_WAIT_MAX_MS`). Undefined for a job not known here.
   */
  readonly watch: (
    id: string,
    options?: { readonly seen?: number | undefined; readonly waitMs?: number | undefined },
  ) => Effect.Effect<MachineJob | undefined>;
  /** The job once it has ended. */
  readonly ended: (id: string) => Effect.Effect<MachineJob | undefined>;
  /** Cuts the job off: it fails, and its step ends as a cut-off one does. */
  readonly interrupt: (id: string) => Effect.Effect<void>;
}

const JOBS_MAX = 512;

const active = (job: MachineJob) => job.state === "queued" || job.state === "running";

interface Entry {
  job: MachineJob;
  changed: Deferred.Deferred<void>;
  fiber?: Fiber.Fiber<void>;
  ended: Deferred.Deferred<void>;
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} minutes`;

export const makeMachineJobs = (): Effect.Effect<MachineJobs, never, Scope.Scope> =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntime<never>();
    const entries = new Map<string, Entry>();
    const turns = makeKeyedLock<HostId>();
    let counter = 0;

    const update = (entry: Entry, change: (job: MachineJob) => MachineJob) => {
      entry.job = { ...change(entry.job), version: entry.job.version + 1 };
      const was = entry.changed;
      entry.changed = Deferred.makeUnsafe<void>();
      Deferred.doneUnsafe(was, Exit.void);
      if (!active(entry.job)) Deferred.doneUnsafe(entry.ended, Exit.void);
    };

    const prune = (at: number) => {
      for (const [id, entry] of entries)
        if (!active(entry.job) && at - (entry.job.endedAt ?? at) > JOB_KEPT_MS) entries.delete(id);
      for (const [id, entry] of entries) {
        if (entries.size <= JOBS_MAX) break;
        if (!active(entry.job)) entries.delete(id);
      }
    };

    const reportOf = (entry: Entry): JobReport => ({
      folders: (all) =>
        Effect.sync(() =>
          update(entry, (job) => ({
            ...job,
            folders: all.map(({ threadId, cwd }) => ({ threadId, cwd, state: "queued" as const })),
            progress: { done: 0, total: all.length },
          })),
        ),
      folder: (threadId, cwd, state, note) =>
        Effect.flatMap(Clock.currentTimeMillis, (at) =>
          Effect.sync(() =>
            update(entry, (job) => {
              const finished = state !== "running";
              const folders = (job.folders ?? []).map((folder) =>
                folder.threadId === threadId && folder.cwd === cwd
                  ? {
                      threadId,
                      cwd,
                      state,
                      ...(note === undefined ? {} : { note }),
                      startedAt: folder.startedAt ?? at,
                      ...(finished ? { endedAt: at } : {}),
                    }
                  : folder,
              );
              return {
                ...job,
                folders,
                progress: {
                  done: folders.filter(
                    (folder) => folder.state !== "queued" && folder.state !== "running",
                  ).length,
                  total: folders.length,
                },
                progressAt: at,
              };
            }),
          ),
        ),
      progressed: Effect.flatMap(Clock.currentTimeMillis, (at) =>
        Effect.sync(() => update(entry, (job) => ({ ...job, progressAt: at }))),
      ),
    });

    const watchdog = (entry: Entry, budgetMs: number): Effect.Effect<never, HostFailed> =>
      Effect.gen(function* () {
        while (true) {
          const at = yield* Clock.currentTimeMillis;
          const due = entry.job.progressAt + budgetMs;
          if (at >= due)
            return yield* new HostFailed({
              message: `It made no progress for ${minutes(budgetMs)}, so it was cut off.`,
            });
          yield* Effect.sleep(due - at);
        }
      });

    const start = <A>(spec: JobSpec<A>) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        prune(at);
        const same = [...entries.values()].filter(
          ({ job }) => job.kind === spec.kind && job.machine === spec.machine,
        );
        const joined =
          (spec.key === undefined ? undefined : same.find(({ job }) => job.key === spec.key)) ??
          same.find(({ job }) => active(job));
        if (joined !== undefined) return { job: joined.job, joined: true };
        counter += 1;
        const id = `job_${at.toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const entry: Entry = {
          job: {
            id,
            kind: spec.kind,
            machine: spec.machine,
            ...(spec.key === undefined ? {} : { key: spec.key }),
            state: "queued",
            version: 0,
            createdAt: at,
            progressAt: at,
            budgetMs: spec.budgetMs,
            progress: { done: 0, total: 0 },
          },
          changed: Deferred.makeUnsafe<void>(),
          ended: Deferred.makeUnsafe<void>(),
        };
        entries.set(id, entry);
        const step = Effect.gen(function* () {
          const begun = yield* Clock.currentTimeMillis;
          update(entry, (job) => ({
            ...job,
            state: "running",
            startedAt: begun,
            progressAt: begun,
          }));
          return yield* Effect.raceFirst(spec.run(reportOf(entry)), watchdog(entry, spec.budgetMs));
        });
        entry.fiber = run(
          turns.withLock(spec.machine, step).pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Effect.flatMap(Clock.currentTimeMillis, (ended) =>
                Effect.sync(() =>
                  update(entry, (job) =>
                    Exit.isSuccess(exit)
                      ? { ...job, state: "done", endedAt: ended, result: exit.value }
                      : {
                          ...job,
                          state: "failed",
                          endedAt: ended,
                          error: errorOf(exit),
                        },
                  ),
                ),
              ),
            ),
            Effect.onInterrupt(() =>
              Effect.flatMap(Clock.currentTimeMillis, (ended) =>
                Effect.sync(() => {
                  if (active(entry.job))
                    update(entry, (job) => ({
                      ...job,
                      state: "failed",
                      endedAt: ended,
                      error: { status: 502, message: "It was cut off." },
                    }));
                }),
              ),
            ),
          ),
        );
        return { job: entry.job, joined: false };
      });

    const watch: MachineJobs["watch"] = (id, options = {}) =>
      Effect.gen(function* () {
        const entry = entries.get(id);
        if (entry === undefined) return undefined;
        const waitMs = Math.max(0, Math.min(options.waitMs ?? 0, JOB_WAIT_MAX_MS));
        const seen = options.seen;
        if (waitMs === 0 || seen === undefined || entry.job.version > seen || !active(entry.job))
          return entry.job;
        yield* Effect.gen(function* () {
          while (entry.job.version <= seen && active(entry.job))
            yield* Deferred.await(entry.changed);
        }).pipe(Effect.timeoutOption(waitMs));
        return entry.job;
      });

    return {
      start,
      get: (id) => entries.get(id)?.job,
      watch,
      ended: (id) =>
        Effect.suspend(() => {
          const entry = entries.get(id);
          return entry === undefined
            ? Effect.succeed(undefined)
            : Effect.map(Deferred.await(entry.ended), () => entry.job);
        }),
      interrupt: (id) =>
        Effect.suspend(() => {
          const fiber = entries.get(id)?.fiber;
          return fiber === undefined ? Effect.void : Effect.asVoid(Fiber.interrupt(fiber));
        }),
    };
  });

const errorOf = (exit: Exit.Exit<unknown, HostFailed | HostUnavailable>) => {
  if (Exit.isSuccess(exit)) return { status: 500, message: "It failed." };
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (error === undefined) return { status: 502, message: "It was cut off." };
  return { status: error._tag === "HostUnavailable" ? 409 : 502, message: error.message };
};
