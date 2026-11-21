import {
  effectiveCheckout,
  type HostId,
  embeddingOn,
  hostOf,
  LOCAL_HOST_ID,
  type SavedWork,
  savedWorkOf,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import { type KeptWork, keepThreadWork, type StopResumeDeps } from "./stop-resume.ts";

/** The oldest a running turn's work gets past the last keep before it is kept again. */
export const KEEP_EVERY = Duration.minutes(5);
/** How long after a turn ends its work is kept: a follow-up turn starting meanwhile waits. */
export const KEEP_AFTER_TURN = Duration.seconds(5);
/** The most threads whose work is kept at once: each keep pushes over the machine's link. */
export const KEEPS_AT_ONCE = 4;

const FAILURE_MAX = 1024;

export interface WipKeeperDeps {
  readonly hosts: StopResumeDeps["hosts"];
  readonly store: Pick<ThreadStore["Service"], "getThread" | "getSettings">;
  readonly runtimes: Pick<ThreadRuntimesShape, "observe" | "updateThread">;
}

const machineOf = (thread: Thread) => {
  const id = hostOf(effectiveCheckout(thread));
  return id === LOCAL_HOST_ID ? undefined : id;
};

interface Watch {
  open: boolean;
  asked: number | undefined;
  since: number;
  keeping: boolean;
  working: boolean;
  wake: Deferred.Deferred<void>;
}

const dueOf = (watch: Watch, every: number): number | undefined => {
  const age = watch.open ? watch.since + every : undefined;
  if (watch.asked === undefined) return age;
  return age === undefined ? watch.asked : Math.min(age, watch.asked);
};

type Outcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | {
      readonly kind: "kept";
      readonly hostId: HostId;
      readonly kept: ReadonlyArray<KeptWork>;
    }
  | { readonly kind: "failed"; readonly hostId?: HostId; readonly reason: string };

const skipped = (reason: string): Outcome => ({ kind: "skipped", reason });

const logOutcome = (threadId: ThreadId, outcome: Outcome) => {
  if (outcome.kind === "skipped")
    return Effect.logInfo("keeping a thread's work in progress was skipped").pipe(
      Effect.annotateLogs({ threadId, outcome: "skipped", reason: outcome.reason }),
    );
  if (outcome.kind === "failed")
    return Effect.logWarning("a thread's work in progress wasn't kept").pipe(
      Effect.annotateLogs({ threadId, outcome: "failed", reason: outcome.reason }),
    );
  const missed = outcome.kept.filter((work) => !work.pushed);
  const caughtUp = outcome.kept.filter((work) => work.pushed && work.caughtUp === true);
  const pushed = outcome.kept.filter((work) => work.pushed && work.caughtUp !== true);
  const annotations = {
    threadId,
    hostId: outcome.hostId,
    pushed: pushed.length,
    caughtUp: caughtUp.length,
  };
  return missed.length > 0
    ? Effect.logWarning("a thread's work in progress wasn't kept").pipe(
        Effect.annotateLogs({
          ...annotations,
          outcome: "failed",
          notes: missed.map((work) => work.note),
        }),
      )
    : Effect.logInfo("a thread's work in progress was kept").pipe(
        Effect.annotateLogs({
          ...annotations,
          outcome: pushed.length > 0 ? "pushed" : "caughtUp",
        }),
      );
};

/**
 * Watches turns and keeps work as above, for as long as `scope` lasts. A keep that fails is logged,
 * marked on the thread's saved record (`SavedWork.lastFailure`), and tried again at the next turn's
 * end or once the work is `KEEP_EVERY` old: the remote's ref is only ever a few minutes behind.
 */
export const startWipKeeper = (deps: WipKeeperDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const watches = new Map<ThreadId, Watch>();
    const workers = yield* FiberSet.make();
    const slots = yield* Semaphore.make(KEEPS_AT_ONCE);
    const every = Duration.toMillis(KEEP_EVERY);
    const after = Duration.toMillis(KEEP_AFTER_TURN);

    const keepOnce = (threadId: ThreadId): Effect.Effect<Outcome> =>
      Effect.gen(function* () {
        if (!embeddingOn(yield* deps.store.getSettings))
          return skipped("the hosted features are off");
        const thread = yield* deps.store.getThread(threadId);
        const id = machineOf(thread);
        if (id === undefined) return skipped("it works on this machine");
        if (thread.parked) return skipped("it is parked");
        if (deps.hosts.stops.holding(id))
          return skipped("its machine is readied to stop, which keeps it");
        const connection = yield* deps.hosts.connection(id);
        if (connection.stop.keep === undefined)
          return skipped("its machine's host can't keep work (wip-keep)");
        const kept = yield* keepThreadWork(deps, id, thread);
        if (kept.length === 0) return skipped("no folder of it there was made from a clone");
        yield* noteKept(thread, id, kept);
        return { kind: "kept", hostId: id, kept } satisfies Outcome as Outcome;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const error = Cause.squash(cause);
            const message =
              error instanceof Error ? error.message : "Its work in progress couldn't be kept.";
            yield* noteFailed(threadId, message);
            return { kind: "failed", reason: message } satisfies Outcome as Outcome;
          }),
        ),
      );

    const noteKept = (thread: Thread, id: HostId, kept: ReadonlyArray<KeptWork>) =>
      Effect.gen(function* () {
        const main = effectiveCheckout(thread).path;
        const mainFirst = kept.toSorted((a, b) => Number(b.cwd === main) - Number(a.cwd === main));
        const record = mainFirst
          .filter((work) => work.pushed)
          .map((work) => deps.hosts.stops.keptOf(id, thread.id, work.cwd))
          .find((each) => each?.saved !== undefined && each.at !== undefined);
        const missed = mainFirst.find((work) => !work.pushed);
        const failure =
          missed === undefined ? undefined : (missed.note ?? "Its work in progress wasn't kept.");
        if (record?.saved !== undefined && record.at !== undefined) {
          const fresh = savedWorkOf(record.saved, record.at);
          const savedWork: SavedWork =
            failure === undefined ? fresh : failedAt(fresh, record.at, failure);
          yield* deps.runtimes.updateThread(thread.id, (current) => ({ ...current, savedWork }));
        } else if (failure !== undefined) yield* noteFailed(thread.id, failure);
      });

    const noteFailed = (threadId: ThreadId, failure: string) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        yield* deps.runtimes.updateThread(threadId, (current) =>
          current.savedWork === undefined
            ? current
            : { ...current, savedWork: failedAt(current.savedWork, at, failure) },
        );
      }).pipe(Effect.ignore);

    const wakeOf = (watch: Watch) => {
      Deferred.doneUnsafe(watch.wake, Effect.void);
      watch.wake = Deferred.makeUnsafe<void>();
    };

    const next = (threadId: ThreadId, now: number) => {
      const watch = watches.get(threadId);
      if (watch === undefined) return { kind: "done" } as const;
      const due = dueOf(watch, every);
      if (due === undefined) {
        watch.working = false;
        watches.delete(threadId);
        return { kind: "done" } as const;
      }
      if (due > now) return { kind: "wait", ms: due - now, wake: watch.wake } as const;
      watch.keeping = true;
      watch.asked = undefined;
      return { kind: "keep", watch } as const;
    };

    const worker = (threadId: ThreadId) =>
      Effect.gen(function* () {
        while (true) {
          const now = yield* Clock.currentTimeMillis;
          const step = next(threadId, now);
          if (step.kind === "done") return;
          if (step.kind === "wait") {
            yield* Effect.raceFirst(Effect.sleep(step.ms), Deferred.await(step.wake));
            continue;
          }
          const outcome = yield* slots.withPermits(1)(keepOnce(threadId));
          yield* logOutcome(threadId, outcome);
          step.watch.keeping = false;
          step.watch.since = now;
        }
      });

    const touch = (threadId: ThreadId, change: (watch: Watch, now: number) => void) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        let watch = watches.get(threadId);
        if (watch === undefined) {
          watch = {
            open: false,
            asked: undefined,
            since: now,
            keeping: false,
            working: false,
            wake: Deferred.makeUnsafe<void>(),
          };
          watches.set(threadId, watch);
        }
        change(watch, now);
        wakeOf(watch);
        if (watch.working) return;
        watch.working = true;
        yield* FiberSet.run(workers, worker(threadId));
      });

    yield* deps.runtimes.observe({
      onTurnStart: (thread) =>
        machineOf(thread) === undefined
          ? Effect.void
          : touch(thread.id, (watch, now) => {
              if (!watch.open && watch.asked === undefined && !watch.keeping) watch.since = now;
              watch.open = true;
            }),
      onTurnEnd: (thread) =>
        machineOf(thread) === undefined
          ? watches.has(thread.id)
            ? touch(thread.id, (watch) => {
                watch.open = false;
                watch.asked = undefined;
              })
            : Effect.void
          : touch(thread.id, (watch, now) => {
              watch.open = false;
              watch.asked = Math.min(watch.asked ?? Number.POSITIVE_INFINITY, now + after);
            }),
    });
  });

const failedAt = (saved: SavedWork, at: number, failure: string): SavedWork => ({
  ...saved,
  lastAttemptAt: at,
  lastFailure: failure.slice(0, FAILURE_MAX),
});
