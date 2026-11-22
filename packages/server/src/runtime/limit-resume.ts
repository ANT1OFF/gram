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
import { limitDetail } from "@gram/contracts";
import type { ResumeHold, QueueHold, TurnHold } from "./turn-holds.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { NotifyObservers } from "./runtime-observer.ts";
import type { UsageLimitReadingsShape } from "../usage/limit-readings.ts";
import type { ThreadRuntimesShape } from "./thread-runtimes-shape.ts";

const LIMIT_RESUME_KEY = "limit-resume";
const admissionKey = (account: string, model: string) => JSON.stringify([account, model]);

/**
 * What limit waits read and change: the store, each account's limit history this run, the timers
 * that resume waiting threads, and the holds other services registered.
 */
export interface LimitResumeDeps {
  readonly quotaFor: (thread: Thread) => Effect.Effect<string>;
  readonly accountChanged: (thread: Thread, previous: string) => Effect.Effect<boolean>;
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
  readonly reopenWhenIdle: (rt: Runtime) => Effect.Effect<void>;
}

/** Limit waits and the holds on resuming them, over every thread's runtime. */
export const makeLimitResume = ({
  quotaFor,
  accountChanged,
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
  reopenWhenIdle,
}: LimitResumeDeps) => {
  const admissions = new Map<string, number>();
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

  const releasable = (account: string, now: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (Option.isNone(limitReadings)) return false;
      const readings = yield* limitReadings.value.all ?? limitReadings.value.current;
      const last = earlyReleases.get(account);
      if (now < earlyReleaseDue(last) && !limitTurnedOver(readings, account, last, now)) {
        return false;
      }
      return limitClearedBy(readings, account, hitAt(account), now);
    });

  const goesAhead = (account: string, now: number, model?: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const admittedAt =
        model === undefined
          ? -Infinity
          : (admissions.get(admissionKey(account, model)) ?? -Infinity);
      if (admittedAt > hitAt(account)) {
        const newerRejection =
          Option.isSome(limitReadings) &&
          (yield* limitReadings.value.all ?? limitReadings.value.current).some(
            (reading) =>
              accountOf(reading) === account &&
              reading.status === "rejected" &&
              reading.at > admittedAt,
          );
        if (!newerRejection) return true;
      }
      if (Option.isNone(limitReadings)) return false;
      const held = [...runtimes.values()].some(
        (each) =>
          each.limitWait?.account === account &&
          each.limitWait.kind === "limit" &&
          each.limitWait.cancelled !== true &&
          each.limitWait.cleared === undefined,
      );
      if (held) return yield* releasable(account, now);
      return limitClearedBy(
        yield* limitReadings.value.all ?? limitReadings.value.current,
        account,
        hitAt(account),
        now,
      );
    });

  const rejectedUntil = (account: string, now: number): Effect.Effect<number | undefined> =>
    Effect.gen(function* () {
      if (Option.isNone(limitReadings)) return undefined;
      let until: number | undefined;
      for (const record of yield* limitReadings.value.all ?? limitReadings.value.current) {
        const at = record.resetsAt;
        if (record.status !== "rejected" || accountOf(record) !== account || at === undefined)
          continue;
        if (at > now && (until === undefined || at > until)) until = at;
      }
      return until;
    });

  const waitsUntil = (account: string, now: number): number | undefined => {
    let until: number | undefined;
    for (const each of runtimes.values()) {
      const wait = each.limitWait;
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

  const limitedUntil = (
    account: string,
    now: number,
    model?: string,
  ): Effect.Effect<number | undefined> =>
    Effect.gen(function* () {
      if (yield* goesAhead(account, now, model)) return undefined;
      return (yield* rejectedUntil(account, now)) ?? waitsUntil(account, now);
    });

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

  const limitWaitOf = (
    rt: Runtime,
    failure: AgentFailure,
    detail: string,
    turnId: TurnId | undefined,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const account =
        rt.quota ?? (yield* quotaFor(yield* store.getThread(rt.threadId).pipe(Effect.orDie)));
      const before = rt.resumedFrom;
      const found = classifyLimit(
        failure,
        detail,
        now,
        yield* rejectedUntil(account, now),
        undefined,
        before?.resetsAt,
        waitsUntil(account, now),
      );
      if (found === undefined) return undefined;
      const since = before?.since ?? now;
      const interrupted = before?.turnId ?? turnId;
      const words = limitDetail(detail);
      const said = words === undefined ? {} : { detail: words };
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
          ...(before?.resetsAt === undefined ? {} : { resetsAt: before.resetsAt }),
          resumeAt: now + backoffDelay(rt.threadId, attempt),
          since,
          attempt,
          ...(interrupted === undefined ? {} : { turnId: interrupted }),
          ...said,
        } satisfies LimitWait;
      }
      const resetsAt = found.resetsAt ?? now + LIMIT_UNKNOWN_RESET_MS;
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
        ...said,
      } satisfies LimitWait;
    });

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
      const account = yield* quotaFor(thread);
      if (
        rt.quota !== undefined &&
        rt.quota !== account &&
        thread.sessionSwitch === undefined &&
        (yield* accountChanged(thread, rt.quota))
      ) {
        rt.reopenOnIdle = rt.session !== undefined;
      }
      const now = yield* Clock.currentTimeMillis;
      const until = yield* limitedUntil(account, now, thread.model.model);
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

  const releaseEarly = (account: string, byTurn: string | undefined): Effect.Effect<void> =>
    releaseLock
      .withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (byTurn !== undefined) admissions.set(admissionKey(account, byTurn), now);
          let waiting = (yield* store.listThreads).filter(
            (thread) =>
              thread.limitWait?.account === account &&
              thread.limitWait.kind === "limit" &&
              thread.limitWait.cancelled !== true &&
              (byTurn === undefined || thread.model.model === byTurn),
          );
          if (!waiting.some((thread) => thread.limitWait!.cleared === undefined)) return;
          const changed = new Set<ThreadId>();
          if (byTurn === undefined) {
            for (const thread of waiting) {
              if (thread.sessionSwitch === undefined && (yield* accountChanged(thread, account)))
                changed.add(thread.id);
            }
            if (!(yield* releasable(account, now)))
              waiting = waiting.filter((thread) => changed.has(thread.id));
          }
          if (waiting.length === 0) return;
          if (byTurn === undefined && changed.size === 0 && Option.isSome(limitReadings)) {
            const readings = yield* limitReadings.value.all ?? limitReadings.value.current;
            const last = earlyReleases.get(account);
            const count = limitTurnedOver(readings, account, last, now) ? 0 : (last?.count ?? 0);
            earlyReleases.set(account, {
              at: now,
              count: count + 1,
              windows: windowsOf(readings, account),
            });
          }
          yield* Effect.logInfo("limit no longer applies; waits end early").pipe(
            Effect.annotateLogs({
              provider: account.split("/")[0],
              threads: waiting.length,
              byTurn: byTurn ?? "",
            }),
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
                if (
                  changed.has(each.id) &&
                  (yield* store.getThread(each.id).pipe(Effect.orDie)).sessionSwitch === undefined
                )
                  rt.reopenOnIdle = rt.session !== undefined;
                return { thread: yield* storeWait(rt, next), wait: next };
              }),
            );
            if (released === undefined) continue;
            yield* armResume(each.id, at, now);
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
            Effect.annotateLogs({ provider: account.split("/")[0], cause: Cause.pretty(cause) }),
          ),
        ),
      );

  const startRelease = (account: string, byTurn?: string) =>
    FiberMap.run(releasing, account, releaseEarly(account, byTurn), {
      onlyIfMissing: byTurn === undefined,
    }).pipe(Effect.asVoid);

  const armResume = (threadId: ThreadId, at: number, now: number) =>
    FiberMap.run(
      limitTimers,
      threadId,
      Effect.sleep(Duration.millis(Math.max(0, at - now))).pipe(
        Effect.andThen(resumeWhenFree(threadId)),
      ),
    );

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

  const queueHeld = (rt: Runtime) =>
    Effect.gen(function* () {
      if (queueHolds.size === 0 || (rt.queue.length === 0 && rt.deliveries.size === 0)) {
        return false;
      }
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

  const heldBack = (thread: Thread) =>
    Effect.gen(function* () {
      if (thread.parked) return true;
      for (const hold of resumeHolds) {
        if (yield* hold(thread).pipe(Effect.orElseSucceed(() => true))) return true;
      }
      return false;
    });

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
          if (early) {
            const { resetsAt: _, ...rest } = wait;
            rt.resumedFrom = rest;
          } else rt.resumedFrom = wait;
          rt.admitted = true;
          if (byUser && rt.session !== undefined) rt.reopenOnIdle = true;
          yield* Effect.logInfo("thread resumes after a limit").pipe(
            Effect.annotateLogs({ threadId, kind: wait.kind, attempt: wait.attempt }),
          );
          if (wait.turnId !== undefined && rt.deliveries.size === 0) {
            const id = makeQueueItemId();
            rt.queue.unshift({
              id,
              input: { text: early ? LIMIT_CLEARED_TEXT : LIMIT_RESUME_TEXT },
            });
            rt.noticeKeys.set(id, LIMIT_RESUME_KEY);
            rt.actors.set(id, "server");
            yield* syncQueue(rt);
          }
          if (!isShuttingDown()) {
            if (rt.reopenOnIdle) yield* reopenWhenIdle(rt);
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

  const endWaitForUser = (rt: Runtime) =>
    Effect.gen(function* () {
      const wait = rt.limitWait;
      if (wait === undefined) {
        const thread = yield* store.getThread(rt.threadId).pipe(Effect.orDie);
        if (thread.limitCleared === undefined) return;
        const updated = yield* store
          .updateThread(rt.threadId, (current) => {
            const { limitCleared: _, ...rest } = current;
            return rest;
          })
          .pipe(Effect.orDie);
        yield* publishUpsert(updated);
        return;
      }
      yield* FiberMap.remove(limitTimers, rt.threadId);
      const thread = yield* storeWait(rt, undefined);
      rt.resumedFrom = wait;
      rt.admitted = true;
      if (rt.session !== undefined) yield* reopenWhenIdle(rt);
      yield* notifyObservers(rt.threadId, "onLimitWait", (observer) =>
        observer.onLimitWait?.(thread, wait, "resumed"),
      );
    });

  const cancelLimitWait = (threadId: ThreadId): Effect.Effect<void, ThreadNotFound> =>
    Effect.gen(function* () {
      const rt = yield* getRuntime(threadId);
      yield* FiberMap.remove(limitTimers, threadId);
      const ended = yield* locked(
        rt,
        Effect.gen(function* () {
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

  const dropWaitForSwitch = (rt: Runtime, account: string) =>
    Effect.gen(function* () {
      const wait =
        rt.limitWait ?? (yield* store.getThread(rt.threadId).pipe(Effect.orDie)).limitWait;
      if (
        wait === undefined ||
        (wait.account !== account && !wait.account.startsWith(`${account}/"`))
      )
        return;
      yield* FiberMap.remove(limitTimers, rt.threadId);
      const thread = yield* storeWait(rt, undefined);
      yield* notifyObservers(rt.threadId, "onLimitWait", (observer) =>
        observer.onLimitWait?.(thread, wait, "cancelled"),
      );
    });

  return {
    hitAt,
    limitedUntil,
    dropWaitForSwitch,
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
