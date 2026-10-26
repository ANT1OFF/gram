// A thread waiting out a provider limit (`Thread.limitWait`): when it waits, when its account lifts,
// and the resume, which the holds other services register can keep back.

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as FiberMap from "effect/FiberMap";
import * as Duration from "effect/Duration";
import type * as Semaphore from "effect/Semaphore";
import {
  earlyReleaseDue,
  limitClearedBy,
  limitTurnedOver,
  windowsOf,
  accountOf,
  classifyLimit,
  BACKOFF_MAX_ATTEMPTS,
  backoffDelay,
  LIMIT_UNKNOWN_RESET_MS,
  LIMIT_RESUME_DELAY_MS,
  resumePlan,
  LIMIT_HELD_RECHECK_MS,
  releaseSlot,
  LIMIT_CLEARED_TEXT,
  LIMIT_RESUME_TEXT,
  type EarlyReleases,
  type ReleaseWave,
} from "./limit-wait.ts";
import { type Runtime, locked, makeQueueItemId, type GetRuntime } from "./runtime-state.ts";
import type {
  LimitWait,
  LimitCleared,
  AgentFailure,
  TurnId,
  ThreadId,
  Thread,
  ThreadNotFound,
  ThreadStatus,
  ThreadError,
} from "@gram/contracts";
import type { ResumeHold, QueueHold, TurnHold } from "./turn-holds.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { NotifyObservers } from "./runtime-observer.ts";
import type { UsageLimitReadingsShape } from "../usage/limit-readings.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";

/** The `noticeKeys` key of the queued "continue" a limit's resume sends. */
const LIMIT_RESUME_KEY = "limit-resume";

/**
 * What limit waits read and change: the store, each account's limit history this run, the timers
 * that resume waiting threads, and the holds other services registered.
 */
export interface LimitResumeDeps {
  readonly store: ThreadStoreShape;
  readonly runtimes: ReadonlyMap<ThreadId, Runtime>;
  readonly getRuntime: GetRuntime;
  readonly notifyObservers: NotifyObservers;
  readonly publishUpsert: (thread: Thread) => Effect.Effect<void>;
  readonly limitReadings: Option.Option<UsageLimitReadingsShape>;
  readonly limitTimers: FiberMap.FiberMap<ThreadId>;
  readonly limitHits: Map<string, number>;
  readonly hitResets: Map<string, number>;
  readonly earlyReleases: Map<string, EarlyReleases>;
  readonly releasing: FiberMap.FiberMap<string>;
  readonly releaseLock: Semaphore.Semaphore;
  readonly releaseWaves: Map<string, ReleaseWave>;
  readonly resumeHolds: ReadonlySet<ResumeHold>;
  readonly queueHolds: ReadonlySet<QueueHold>;
  readonly turnHolds: ReadonlySet<TurnHold>;
  readonly setStatus: (
    rt: Runtime,
    status: ThreadStatus,
    detail?: string,
    force?: boolean,
  ) => Effect.Effect<void>;
  readonly recordFailure: (
    rt: Runtime,
    failure: AgentFailure,
    detail: string,
    turnId: TurnId | undefined,
  ) => Effect.Effect<ThreadError>;
  readonly isShuttingDown: () => boolean;
  readonly syncQueue: (rt: Runtime) => Effect.Effect<void>;
  readonly drainQueue: (rt: Runtime) => Effect.Effect<void>;
  readonly pumpDeliveries: (rt: Runtime) => Effect.Effect<void>;
}

/** Limit waits and the holds on resuming them, over every thread's runtime. */
export const makeLimitResume = ({
  store,
  runtimes,
  getRuntime,
  notifyObservers,
  publishUpsert,
  limitReadings,
  limitTimers,
  limitHits,
  hitResets,
  earlyReleases,
  releasing,
  releaseLock,
  releaseWaves,
  resumeHolds,
  queueHolds,
  turnHolds,
  setStatus,
  recordFailure,
  isShuttingDown,
  syncQueue,
  drainQueue,
  pumpDeliveries,
}: LimitResumeDeps) => {
  /**
   * When a turn on `account` last met its limit: this run's latest, or, with none this run (a
   * restart), the latest a thread waiting on it began waiting. A thread that waits with the account
   * (`waitWithAccount`) met no limit, so it never makes a turn opened before it say nothing.
   */
  const hitAt = (account: string): number => {
    const hit = limitHits.get(account);
    if (hit !== undefined) return hit;
    let at = -Infinity;
    for (const each of runtimes.values()) {
      const wait = each.limitWait;
      if (wait !== undefined && wait.account === account && wait.since > at) at = wait.since;
    }
    return at;
  };

  /**
   * Whether `account`'s waits may end early now: readings since its latest limit show every window
   * below it (`limitClearedBy`), and no early release of it is too recent (`earlyReleaseDue`), unless
   * the readings are of other windows than that release went on (`limitTurnedOver`: another login,
   * or a window reset early).
   */
  const releasable = (account: string, now: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (Option.isNone(limitReadings)) return false;
      const readings = yield* limitReadings.value.current;
      const last = earlyReleases.get(account);
      if (now < earlyReleaseDue(last) && !limitTurnedOver(readings, account, last, now)) {
        return false;
      }
      return limitClearedBy(readings, account, hitAt(account), now);
    });

  /**
   * Whether a new turn on `account` goes despite the waits recorded on it: its waits ended early
   * already (or may now), and nothing met the limit since the readings that say so.
   */
  const goesAhead = (account: string, now: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (Option.isNone(limitReadings)) return false;
      const held = [...runtimes.values()].some(
        (each) =>
          each.limitWait?.account === account &&
          each.limitWait.kind === "limit" &&
          each.limitWait.cancelled !== true &&
          each.limitWait.cleared === undefined,
      );
      if (held) return yield* releasable(account, now);
      return limitClearedBy(yield* limitReadings.value.current, account, hitAt(account), now);
    });

  /** The latest reset of `account`'s `rejected` readings still to come, the CLI's own word. */
  const rejectedUntil = (account: string, now: number): Effect.Effect<number | undefined> =>
    Effect.gen(function* () {
      if (Option.isNone(limitReadings)) return undefined;
      let until: number | undefined;
      for (const record of yield* limitReadings.value.current) {
        const at = record.resetsAt;
        if (record.status !== "rejected" || accountOf(record) !== account || at === undefined)
          continue;
        if (at > now && (until === undefined || at > until)) until = at;
      }
      return until;
    });

  /** The latest reset a thread still waiting on `account` was told, still to come. */
  const waitsUntil = (account: string, now: number): number | undefined => {
    let until: number | undefined;
    for (const each of runtimes.values()) {
      const wait = each.limitWait;
      // A wait released early no longer says the account is limited.
      if (
        wait?.kind === "limit" &&
        wait.cancelled !== true &&
        wait.cleared === undefined &&
        wait.account === account &&
        wait.resetsAt !== undefined &&
        wait.resetsAt > now &&
        (until === undefined || wait.resetsAt > until)
      ) {
        until = wait.resetsAt;
      }
    }
    return until;
  };

  /**
   * Epoch ms `account`'s limit lifts while one is known to hold it: the reset of its `rejected`
   * reading in `UsageLimitReadings`, or, with none, the latest reset a thread waiting on it was
   * told, which may be another window's or one long lifted, so never ahead of the CLI's own word.
   * `undefined` once that is past, and when fresh data says the limit no longer applies
   * (`goesAhead`): a wait recorded before it doesn't hold a new turn back.
   */
  const limitedUntil = (account: string, now: number): Effect.Effect<number | undefined> =>
    Effect.gen(function* () {
      if (yield* goesAhead(account, now)) return undefined;
      return (yield* rejectedUntil(account, now)) ?? waitsUntil(account, now);
    });

  /**
   * Writes `Thread.limitWait`, or with none clears it, and keeps the runtime's copy beside it. A new
   * wait drops the note of one that ended early (`Thread.limitCleared`); `cleared` writes it.
   */
  const storeWait = (rt: Runtime, wait: LimitWait | undefined, cleared?: LimitCleared) =>
    Effect.gen(function* () {
      rt.limitWait = wait;
      const next = yield* store
        .updateThread(rt.threadId, (current) => {
          const { limitWait: _, limitCleared: note, ...rest } = current;
          if (wait !== undefined) return { ...rest, limitWait: wait };
          const kept = cleared ?? note;
          return kept === undefined ? rest : { ...rest, limitCleared: kept };
        })
        .pipe(Effect.orDie);
      yield* publishUpsert(next);
      return next;
    });

  /**
   * The wait a failed turn turns into, or `undefined` for a failure that stays an error: a limit
   * with its reset, or a bare 429's next backoff, until `BACKOFF_MAX_ATTEMPTS` have failed.
   */
  const limitWaitOf = (
    rt: Runtime,
    failure: AgentFailure,
    detail: string,
    turnId: TurnId | undefined,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const account =
        rt.quota ?? accountOf((yield* store.getThread(rt.threadId).pipe(Effect.orDie)).model);
      const before = rt.resumedFrom;
      const found = classifyLimit(
        failure,
        detail,
        now,
        // The limit is met again: what the readings said before it no longer counts.
        yield* rejectedUntil(account, now),
        undefined,
        before?.resetsAt,
        waitsUntil(account, now),
      );
      if (found === undefined) return undefined;
      const since = before?.since ?? now;
      const interrupted = before?.turnId ?? turnId;
      if (found.kind === "backoff") {
        const attempt = (before?.attempt ?? 0) + 1;
        if (attempt > BACKOFF_MAX_ATTEMPTS) {
          yield* Effect.logWarning("thread gave up backing off a rate limit").pipe(
            Effect.annotateLogs({ threadId: rt.threadId, attempts: attempt - 1 }),
          );
          return undefined;
        }
        return {
          kind: "backoff",
          account,
          // The reset already waited out, kept so a backoff never takes it for a new one.
          ...(before?.resetsAt === undefined ? {} : { resetsAt: before.resetsAt }),
          resumeAt: now + backoffDelay(rt.threadId, attempt),
          since,
          attempt,
          ...(interrupted === undefined ? {} : { turnId: interrupted }),
        } satisfies LimitWait;
      }
      const resetsAt = found.resetsAt ?? now + LIMIT_UNKNOWN_RESET_MS;
      // The agent's own reset is what every wait on the account shares; a guess is not.
      if (found.resetsAt !== undefined) hitResets.set(account, found.resetsAt);
      else hitResets.delete(account);
      return {
        kind: "limit",
        account,
        resetsAt,
        resumeAt: resetsAt + LIMIT_RESUME_DELAY_MS,
        since,
        attempt: 0,
        ...(interrupted === undefined ? {} : { turnId: interrupted }),
      } satisfies LimitWait;
    });

  /**
   * Called with the runtime lock held. The thread starts waiting; `scheduleAccount` times it.
   * `hit` when its own turn met the limit, which readings must then postdate to release it.
   */
  const enterWait = (rt: Runtime, wait: LimitWait, hit = false) =>
    Effect.gen(function* () {
      if (hit) limitHits.set(wait.account, yield* Clock.currentTimeMillis);
      const thread = yield* storeWait(rt, wait);
      rt.resumedFrom = undefined;
      yield* Effect.logInfo("thread waits out a limit").pipe(
        Effect.annotateLogs({
          threadId: rt.threadId,
          kind: wait.kind,
          attempt: wait.attempt,
          resetsAt: wait.resetsAt ?? "",
        }),
      );
      yield* notifyObservers(rt.threadId, "onLimitWait", (observer) =>
        observer.onLimitWait?.(thread, wait),
      );
    });

  /**
   * Called with the runtime lock held, before something not the user's starts a turn on a thread at
   * rest: while its account is known to be limited, the thread waits with it rather than meet the
   * limit, and whatever was to start waits in the queue or the deliveries. `true` when it waits.
   */
  const waitWithAccount = (rt: Runtime): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (rt.limitWait !== undefined) return true;
      if (rt.admitted) return false;
      if (
        rt.turn !== undefined ||
        !(rt.status === "idle" || rt.status === "error" || rt.status === "cold")
      )
        return false;
      const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
      const account = accountOf(thread.model);
      const now = yield* Clock.currentTimeMillis;
      const until = yield* limitedUntil(account, now);
      if (until === undefined) return false;
      yield* enterWait(rt, {
        kind: "limit",
        account,
        resetsAt: until,
        resumeAt: until + LIMIT_RESUME_DELAY_MS,
        since: now,
        attempt: 0,
      });
      yield* scheduleAccount(account);
      return true;
    });

  /**
   * Ends `account`'s limit waits early, as fresh data says the limit no longer applies: readings
   * below it (`releasable`, which also spaces the releases out), or, with `byTurn`, a turn on the
   * account that went through on that model, whose own waits it releases. They go on `resumePlan` from now, the orchestrator first, each
   * marked `cleared` so its thread says so and a limit met again waits for its reset. A wait the
   * user cancelled stays as it is. Run apart from any thread's lock, one at a time.
   */
  const releaseEarly = (account: string, byTurn: string | undefined): Effect.Effect<void> =>
    releaseLock
      .withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          // A turn proves only its own model: another may have met a limit of its own.
          const waiting = (yield* store.listThreads).filter(
            (thread) =>
              thread.limitWait?.account === account &&
              thread.limitWait.kind === "limit" &&
              thread.limitWait.cancelled !== true &&
              (byTurn === undefined || thread.model.model === byTurn),
          );
          if (!waiting.some((thread) => thread.limitWait!.cleared === undefined)) return;
          if (byTurn === undefined && !(yield* releasable(account, now))) return;
          if (byTurn === undefined && Option.isSome(limitReadings)) {
            const readings = yield* limitReadings.value.current;
            const last = earlyReleases.get(account);
            // Other windows than the last release went on start the spacing over.
            const count = limitTurnedOver(readings, account, last, now) ? 0 : (last?.count ?? 0);
            earlyReleases.set(account, {
              at: now,
              count: count + 1,
              windows: windowsOf(readings, account),
            });
          }
          yield* Effect.logInfo("limit no longer applies; waits end early").pipe(
            Effect.annotateLogs({ account, threads: waiting.length, byTurn: byTurn ?? "" }),
          );
          const plan = resumePlan(
            waiting.map((thread) => ({
              threadId: thread.id,
              wait: thread.limitWait!,
              orchestrator: thread.role === "orchestrator",
            })),
            now - LIMIT_RESUME_DELAY_MS,
          );
          for (const each of waiting) {
            const at = plan.get(each.id)!;
            const rt = yield* getRuntime(each.id);
            const released = yield* locked(
              rt,
              Effect.gen(function* () {
                const wait = rt.limitWait;
                if (wait === undefined || wait.kind !== "limit" || wait.cancelled === true) {
                  return undefined;
                }
                const next = { ...wait, cleared: wait.cleared ?? now, resumeAt: at };
                return { thread: yield* storeWait(rt, next), wait: next };
              }),
            );
            if (released === undefined) continue;
            yield* armResume(each.id, at, now);
            // A worker's ledger row says when it now goes; an orchestrator's own wait isn't new.
            if (each.role !== "orchestrator") {
              yield* notifyObservers(each.id, "onLimitWait", (observer) =>
                observer.onLimitWait?.(released.thread, released.wait),
              );
            }
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("limit early release failed").pipe(
            Effect.annotateLogs({ account, cause: Cause.pretty(cause) }),
          ),
        ),
      );

  /** `releaseEarly` in a fiber of its own, at most one per account at a time. */
  const startRelease = (account: string, byTurn?: string) =>
    FiberMap.run(releasing, account, releaseEarly(account, byTurn), {
      onlyIfMissing: byTurn === undefined,
    }).pipe(Effect.asVoid);

  /** Starts, or restarts, the timer that resumes `threadId` at `at`. */
  const armResume = (threadId: ThreadId, at: number, now: number) =>
    FiberMap.run(
      limitTimers,
      threadId,
      Effect.sleep(Duration.millis(Math.max(0, at - now))).pipe(
        Effect.andThen(resumeWhenFree(threadId)),
      ),
    );

  /**
   * Times every resume of `account`'s limit waits, which share the account's latest reset and are
   * staggered by `resumePlan`, the orchestrator first. A reset already past (a restart after it) is
   * taken as now, so the batches keep their spacing rather than all falling due at once. With
   * `only`, a backoff, just that thread's own time: the plan stays as it is, so the batches
   * already under way keep their places. Never called from a resume timer for its own thread,
   * whose wait is gone by then.
   */
  const scheduleAccount = (account: string, only?: ThreadId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (only !== undefined) {
        const wait = runtimes.get(only)?.limitWait;
        if (wait !== undefined && wait.cancelled !== true)
          yield* armResume(only, wait.resumeAt, now);
        return;
      }
      const limits = (yield* store.listThreads).filter(
        (thread) =>
          thread.limitWait?.account === account &&
          thread.limitWait.kind === "limit" &&
          thread.limitWait.cancelled !== true,
      );
      if (limits.length === 0) return;
      // Released early (`releaseEarly`) with no limit met since: each keeps its time, and those a
      // restart left past due go again in batches from now rather than all at once.
      const hit = limitHits.get(account) ?? -Infinity;
      const released = limits.filter(
        (thread) => thread.limitWait!.cleared !== undefined && thread.limitWait!.cleared >= hit,
      );
      const overdue = resumePlan(
        released
          .filter((thread) => thread.limitWait!.resumeAt <= now)
          .map((thread) => ({
            threadId: thread.id,
            wait: thread.limitWait!,
            orchestrator: thread.role === "orchestrator",
          })),
        now - LIMIT_RESUME_DELAY_MS,
      );
      for (const thread of released) {
        const rt = yield* getRuntime(thread.id);
        const at = overdue.get(thread.id) ?? thread.limitWait!.resumeAt;
        if (rt.limitWait !== undefined && at !== rt.limitWait.resumeAt) {
          yield* storeWait(rt, { ...rt.limitWait, resumeAt: at });
        }
        yield* armResume(thread.id, at, now);
      }
      const holding = limits.filter((thread) => !released.includes(thread));
      if (holding.length === 0) return;
      // The reset the account's latest limit named is the agent's latest word on when it lifts:
      // a wait from before it (another window's, one lifted early, a thread a hold keeps back)
      // takes it too, rather than keep the whole account waiting for a reset that no longer
      // applies. Without one still to come this run (a restart), the latest any of them was told.
      const named = hitResets.get(account);
      const latest = named !== undefined && named > now ? named : undefined;
      const reset =
        latest ??
        Math.max(
          ...holding.map(
            (thread) =>
              thread.limitWait!.resetsAt ?? thread.limitWait!.resumeAt - LIMIT_RESUME_DELAY_MS,
          ),
        );
      const plan = resumePlan(
        holding.map((thread) => ({
          threadId: thread.id,
          wait: thread.limitWait!,
          orchestrator: thread.role === "orchestrator",
        })),
        Math.max(reset, now - LIMIT_RESUME_DELAY_MS),
      );
      for (const thread of holding) {
        const at = plan.get(thread.id)!;
        const rt = yield* getRuntime(thread.id);
        // Not under the thread's lock: this runs under the lock of whichever thread's limit
        // called for the plan, which may be this one. A wait released early before the latest
        // hit goes back to the reset with the rest: the limit was met again, so it applies.
        const wait = rt.limitWait;
        const resetsAt = latest ?? wait?.resetsAt;
        if (
          wait !== undefined &&
          (at !== wait.resumeAt || wait.cleared !== undefined || resetsAt !== wait.resetsAt)
        ) {
          const { cleared: _, resetsAt: __, ...kept } = wait;
          yield* storeWait(rt, {
            ...kept,
            ...(resetsAt === undefined ? {} : { resetsAt }),
            resumeAt: at,
          });
        }
        yield* armResume(thread.id, at, now);
      }
    }).pipe(Effect.orDie);

  /**
   * Whether a queue hold keeps `rt`'s queued input and deliveries waiting. Asked only when there is
   * something to send, so an idle thread with nothing queued reads no thread row; never when the
   * user's own typed input is next.
   */
  const queueHeld = (rt: Runtime) =>
    Effect.gen(function* () {
      if (queueHolds.size === 0 || (rt.queue.length === 0 && rt.deliveries.size === 0)) {
        return false;
      }
      // The user's own word, first in line, goes through, as it ends a limit wait.
      const head = rt.queue[0];
      if (
        head !== undefined &&
        head.input.origin === undefined &&
        head.input.notice === undefined &&
        !rt.noticeKeys.has(head.id)
      ) {
        return false;
      }
      return yield* queueHoldsFor(rt.threadId);
    });

  /**
   * Whether a queue hold holds what isn't the user's own word for `threadId`, whatever is queued:
   * the holds asked, as `queueHeld` asks them; one that fails holds too.
   */
  const queueHoldsFor = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (queueHolds.size === 0) return false;
      const thread = yield* store.getThread(threadId).pipe(Effect.option);
      if (Option.isNone(thread)) return false;
      for (const hold of queueHolds) {
        if (yield* hold(thread.value).pipe(Effect.orElseSucceed(() => true))) return true;
      }
      return false;
    });

  /** Whether a hold keeps the timed resume of `thread` back; one that fails holds it too. */
  const heldBack = (thread: Thread) =>
    Effect.gen(function* () {
      if (thread.parked) return true;
      for (const hold of resumeHolds) {
        if (yield* hold(thread).pipe(Effect.orElseSucceed(() => true))) return true;
      }
      return false;
    });

  /**
   * A wait's timer: resumes the thread unless a hold keeps it back, asking again a minute on. A
   * worker a hold kept back takes a slot in its account's release batches (`releaseSlot`) once
   * let go, so a workspace resumed by the user doesn't send every worker at once; its
   * orchestrator goes at once, ahead of them.
   */
  const resumeWhenFree = (threadId: ThreadId): Effect.Effect<void> =>
    Effect.gen(function* () {
      let held = false;
      let slotted = false;
      for (;;) {
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        const wait = Option.isNone(thread) ? undefined : thread.value.limitWait;
        if (Option.isNone(thread) || wait === undefined || wait.cancelled === true) return;
        if (yield* heldBack(thread.value)) {
          held = true;
          slotted = false;
          yield* Effect.sleep(Duration.millis(LIMIT_HELD_RECHECK_MS));
          continue;
        }
        if (held && !slotted && thread.value.role !== "orchestrator") {
          slotted = true;
          const now = yield* Clock.currentTimeMillis;
          const slot = releaseSlot(releaseWaves.get(wait.account), now);
          releaseWaves.set(wait.account, slot.wave);
          if (slot.at > now) {
            yield* Effect.sleep(Duration.millis(slot.at - now));
            continue;
          }
        }
        return yield* resumeWait(threadId);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("limit wait resume failed").pipe(
          Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
        ),
      ),
    );

  /**
   * Ends the wait and goes on from the last persisted state, as the user's "continue" would: an
   * interrupted turn gets `LIMIT_RESUME_TEXT`, ahead of whatever queued meanwhile, unless a system
   * delivery waits, which then carries the resume itself (an orchestrator's held digest, which says
   * what changed meanwhile). Nothing sent before is sent again.
   */
  const resumeWait = (threadId: ThreadId, byUser = false): Effect.Effect<void, ThreadNotFound> =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      const ended = yield* locked(
        rt,
        Effect.gen(function* () {
          const wait = rt.limitWait;
          if (wait === undefined || rt.closing || (wait.cancelled === true && !byUser))
            return undefined;
          const now = yield* Clock.currentTimeMillis;
          const early = wait.cleared !== undefined && !byUser;
          const thread = yield* storeWait(
            rt,
            undefined,
            early
              ? { at: now, ...(wait.resetsAt === undefined ? {} : { resetsAt: wait.resetsAt }) }
              : undefined,
          );
          // A wait released early never waited its reset out: met again, the same reset is a
          // limit to wait for, not one outlasted.
          if (early) {
            const { resetsAt: _, ...rest } = wait;
            rt.resumedFrom = rest;
          } else rt.resumedFrom = wait;
          // The user's "now" outranks what Gram knows of the account: a sibling still waiting, or
          // a rejected reading, must not put the thread straight back.
          rt.admitted = byUser;
          yield* Effect.logInfo("thread resumes after a limit").pipe(
            Effect.annotateLogs({ threadId, kind: wait.kind, attempt: wait.attempt }),
          );
          if (wait.turnId !== undefined && rt.deliveries.size === 0) {
            const id = makeQueueItemId();
            rt.queue.unshift({
              id,
              input: { text: early ? LIMIT_CLEARED_TEXT : LIMIT_RESUME_TEXT },
            });
            // Gram's, not the user's word: a hold holds it, across a restart too.
            rt.noticeKeys.set(id, LIMIT_RESUME_KEY);
            yield* syncQueue(rt);
          }
          if (!isShuttingDown()) {
            yield* rt.queue.length > 0 ? drainQueue(rt) : pumpDeliveries(rt);
          }
          return { thread, wait };
        }),
      );
      if (ended === undefined) return;
      yield* notifyObservers(threadId, "onLimitWait", (observer) =>
        observer.onLimitWait?.(ended.thread, ended.wait, "resumed"),
      );
    });

  /**
   * Called with the runtime lock held: the user's own input ends the wait, and goes now, and drops
   * the note of a wait that ended early, which their word answers.
   */
  const endWaitForUser = (rt: Runtime) =>
    Effect.gen(function* () {
      const wait = rt.limitWait;
      if (wait === undefined) {
        const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
        if (thread.limitCleared === undefined) return;
        const { limitCleared: _, ...rest } = thread;
        yield* publishUpsert(yield* store.updateThread(rt.threadId, () => rest).pipe(Effect.orDie));
        return;
      }
      yield* FiberMap.remove(limitTimers, rt.threadId);
      const thread = yield* storeWait(rt, undefined);
      rt.resumedFrom = wait;
      yield* notifyObservers(rt.threadId, "onLimitWait", (observer) =>
        observer.onLimitWait?.(thread, wait, "resumed"),
      );
    });

  /**
   * The user stops waiting: no resume comes, and the thread stands as the limit left it, failed
   * with its error, holding its queue and deliveries until the user sends again or resumes it.
   */
  const cancelLimitWait = (threadId: ThreadId): Effect.Effect<void, ThreadNotFound> =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      yield* FiberMap.remove(limitTimers, threadId);
      const ended = yield* locked(
        rt,
        Effect.gen(function* () {
          // A reset can have cleared the wait while its continuation is still held in the
          // queue. Resume and drain use this same lock: either Stop removes the durable
          // notice here, or the existing interrupt stops the turn that already took it.
          const kept = rt.queue.filter((item) => {
            if (rt.noticeKeys.get(item.id) !== LIMIT_RESUME_KEY) return true;
            rt.noticeKeys.delete(item.id);
            return false;
          });
          if (kept.length !== rt.queue.length) {
            rt.queue = kept;
            yield* syncQueue(rt);
          }
          const wait = rt.limitWait;
          if (wait === undefined || wait.cancelled === true) return undefined;
          // Kept, marked cancelled, so what waits behind it stays held across a restart and a
          // later delivery can't start a turn or a new wait; only the user's own input ends it.
          yield* storeWait(rt, { ...wait, cancelled: true });
          const error = yield* recordFailure(
            rt,
            { kind: "rateLimit", retryable: wait.kind === "backoff" },
            "",
            wait.turnId,
          );
          if (rt.turn === undefined && rt.status === "idle") {
            yield* setStatus(rt, "error", error.text);
          }
          const thread = yield* store.getThread(threadId).pipe(Effect.orDie);
          return { thread, wait };
        }),
      );
      if (ended === undefined) return;
      yield* notifyObservers(threadId, "onLimitWait", (observer) =>
        observer.onLimitWait?.(ended.thread, ended.wait, "cancelled"),
      );
    });

  /** Whether a turn hold stops a turn the agent opened by itself; one that fails holds too. */
  const turnHeld = (threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (turnHolds.size === 0) return false;
      const thread = yield* store.getThread(threadId).pipe(Effect.option);
      if (Option.isNone(thread)) return false;
      for (const hold of turnHolds) {
        if (yield* hold(thread.value).pipe(Effect.orElseSucceed(() => true))) return true;
      }
      return false;
    });

  return {
    hitAt,
    limitWaitOf,
    enterWait,
    waitWithAccount,
    startRelease,
    scheduleAccount,
    queueHeld,
    queueHoldsFor,
    resumeWait,
    endWaitForUser,
    cancelLimitWait,
    turnHeld,
  };
};

/** What `makeLimitResume` gives the rest of `ThreadRuntimes`. */
export type LimitResume = ReturnType<typeof makeLimitResume>;

/** What the limit and hold `ThreadRuntimes` methods read beside the waits themselves. */
export interface LimitMethodsDeps {
  readonly store: ThreadStoreShape;
  readonly runtimes: ReadonlyMap<ThreadId, Runtime>;
  readonly getRuntime: GetRuntime;
  readonly limitTimers: FiberMap.FiberMap<ThreadId>;
  readonly resumeHolds: Set<ResumeHold>;
  readonly queueHolds: Set<QueueHold>;
  readonly turnHolds: Set<TurnHold>;
  readonly resumeWait: LimitResume["resumeWait"];
  readonly drainQueue: (rt: Runtime) => Effect.Effect<void>;
}

/** The `ThreadRuntimes` methods that resume a limit wait, register a hold or let a held queue go. */
export const makeLimitMethods = ({
  store,
  runtimes,
  getRuntime,
  limitTimers,
  resumeHolds,
  queueHolds,
  turnHolds,
  resumeWait,
  drainQueue,
}: LimitMethodsDeps): Pick<
  ThreadRuntimesShape,
  "resumeLimitWait" | "holdResumes" | "holdQueues" | "holdAgentTurns" | "releaseQueue"
> => ({
  resumeLimitWait: (threadId) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(limitTimers, threadId);
      yield* resumeWait(threadId, true);
    }),
  holdResumes: (hold) =>
    Effect.acquireRelease(
      Effect.sync(() => void resumeHolds.add(hold)),
      () => Effect.sync(() => void resumeHolds.delete(hold)),
    ),
  holdQueues: (hold) =>
    Effect.acquireRelease(
      Effect.sync(() => void queueHolds.add(hold)),
      () => Effect.sync(() => void queueHolds.delete(hold)),
    ),
  holdAgentTurns: (hold) =>
    Effect.acquireRelease(
      Effect.sync(() => void turnHolds.add(hold)),
      () => Effect.sync(() => void turnHolds.delete(hold)),
    ),
  releaseQueue: (threadId) =>
    Effect.gen(function* () {
      const rt =
        runtimes.get(threadId) ??
        ((yield* store.listQueue(threadId)).length > 0 ? yield* getRuntime(threadId) : undefined);
      if (rt === undefined) return;
      yield* locked(rt, drainQueue(rt));
    }).pipe(Effect.ignore),
});
