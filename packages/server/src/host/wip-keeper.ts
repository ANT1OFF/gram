// Keeps a thread's work in progress off a joined machine while the thread works there, so a
// machine that is lost (its node gone, its process killed) costs minutes of work and not the
// turn's. A stop keeps the work too (`host.stop.prepare`), but a lost machine gets no stop.
//
// After each turn of a thread whose folder is on a joined machine, and every few minutes while a
// turn runs there, the thread's folders are kept under its hidden ref at the remote
// (`keepThreadWork`). A machine started again on another disk then gets them back from there, as
// after a stop (`resumeHost`). A hosted feature: off, nothing is pushed.

import {
  effectiveCheckout,
  type HostId,
  embeddingOn,
  hostOf,
  LOCAL_HOST_ID,
  savedWorkOf,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import type * as Scope from "effect/Scope";
import type { ThreadStore } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import { type KeptWork, keepThreadWork, type StopResumeDeps } from "./stop-resume.ts";

/** How often a running turn's work is kept. */
export const KEEP_EVERY = Duration.minutes(5);
/** How long after a turn ends its work is kept: a follow-up turn starting meanwhile waits. */
export const KEEP_AFTER_TURN = Duration.seconds(5);

export interface WipKeeperDeps {
  readonly hosts: StopResumeDeps["hosts"];
  readonly store: Pick<ThreadStore["Service"], "getThread" | "getSettings">;
  readonly runtimes: Pick<ThreadRuntimesShape, "observe" | "updateThread">;
}

/** The joined machine a thread works on, or undefined when it works on this one. */
const machineOf = (thread: Thread) => {
  const id = hostOf(effectiveCheckout(thread));
  return id === LOCAL_HOST_ID ? undefined : id;
};

/**
 * Watches turns and keeps work as above, for as long as `scope` lasts. A keep that fails is logged
 * and tried again at the next turn or interval: the remote's ref is only ever a few minutes behind.
 */
export const startWipKeeper = (deps: WipKeeperDeps): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    // One keeping fiber per thread: a later ask replaces an earlier one still waiting.
    const timers = yield* FiberMap.make<ThreadId>();

    const keepNow = (threadId: ThreadId) =>
      Effect.gen(function* () {
        if (!embeddingOn(yield* deps.store.getSettings)) return;
        const thread = yield* deps.store.getThread(threadId);
        const id = machineOf(thread);
        if (id === undefined || thread.parked) return;
        const kept = yield* keepThreadWork(deps, id, thread);
        // Nothing asked of the machine (it keeps nothing, or no folder was made from a clone): said,
        // since a lost machine then costs the whole turn.
        if (kept.length === 0) {
          const serves = (yield* deps.hosts.connection(id)).stop.keep !== undefined;
          yield* Effect.logInfo("a thread's work in progress has nothing to keep it").pipe(
            Effect.annotateLogs({
              threadId,
              hostId: id,
              reason: serves ? "no folder made from a clone" : "its host keeps nothing",
            }),
          );
        } else
          yield* Effect.logDebug("a thread's work in progress kept").pipe(
            Effect.annotateLogs({
              threadId,
              hostId: id,
              pushed: kept.filter((w) => w.pushed).length,
            }),
          );
        yield* noteSaved(thread, id, kept);
        const missed = kept.filter((work) => !work.pushed);
        if (missed.length > 0)
          yield* Effect.logWarning("a thread's work in progress wasn't kept").pipe(
            Effect.annotateLogs({ threadId, hostId: id, notes: missed.map((work) => work.note) }),
          );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("a thread's work in progress wasn't kept").pipe(
            Effect.annotateLogs({ threadId, cause: String(cause) }),
          ),
        ),
      );

    // The thread says when its work was last saved and what that held, its main folder's first.
    const noteSaved = (thread: Thread, id: HostId, kept: ReadonlyArray<KeptWork>) =>
      Effect.gen(function* () {
        const main = effectiveCheckout(thread).path;
        const record = kept
          .filter((work) => work.pushed)
          .toSorted((a, b) => Number(b.cwd === main) - Number(a.cwd === main))
          .map((work) => deps.hosts.stops.keptOf(id, thread.id, work.cwd))
          .find((each) => each?.saved !== undefined && each.at !== undefined);
        if (record?.saved === undefined || record.at === undefined) return;
        const savedWork = savedWorkOf(record.saved, record.at);
        yield* deps.runtimes.updateThread(thread.id, (current) => ({ ...current, savedWork }));
      });

    const every = (threadId: ThreadId) =>
      Effect.sleep(KEEP_EVERY).pipe(Effect.andThen(keepNow(threadId)), Effect.forever);

    const after = (threadId: ThreadId) =>
      Effect.sleep(KEEP_AFTER_TURN).pipe(Effect.andThen(keepNow(threadId)));

    yield* deps.runtimes.observe({
      onTurnStart: (thread) =>
        machineOf(thread) === undefined
          ? Effect.void
          : FiberMap.run(timers, thread.id, every(thread.id)).pipe(Effect.asVoid),
      onTurnEnd: (thread) =>
        machineOf(thread) === undefined
          ? FiberMap.remove(timers, thread.id)
          : FiberMap.run(timers, thread.id, after(thread.id)).pipe(Effect.asVoid),
    });
  });
