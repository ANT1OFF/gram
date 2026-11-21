import { randomUUID } from "node:crypto";
import {
  AppToolError,
  DEFAULT_PR_WAKE_EVENTS,
  InvalidState,
  SNOOZE_AHEAD_MAX_DAYS,
  WAKE_NOTE_MAX,
  WAKES_PER_THREAD_MAX,
  type PrRef,
  type PrStatus,
  type PrWakeEvent,
  type PrWatchSeen,
  type StoredWakeCondition,
  type Thread,
  type ThreadId,
  type ThreadNotFound,
  type ThreadStatus,
  type ThreadWake,
  type ThreadWakes as ThreadWakesList,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { Timers } from "../embedding/timers.ts";
import { EventHub, isThreadRemoved } from "../events/event-hub.ts";
import { isBadgeOf } from "../git/extra-prs.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { readableOnly } from "../embedding/readable-by.ts";
import { redactText } from "../logging/redact.ts";
import {
  conditionWakeText,
  nextPrWatchSeen,
  prWakeDueAt,
  prWakeEventOf,
  prWakeText,
  wakeDueText,
  type PrWakeFired,
} from "../orchestration/rules.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import type { Handlers } from "../rpc/handlers/common.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { DAY_MS } from "../zone-time.ts";
import { conditionWakeOf, WakeConditions } from "./conditions.ts";

const THREAD_WAKE_RETRY = Duration.minutes(1);

export interface ThreadWakesShape {
  /**
   * `schedule_wake` on a plain thread: at most `WAKES_PER_THREAD_MAX` pending, counting `elsewhere`
   * (those its workspace's outbox still holds for it), a week ahead.
   */
  schedule(
    threadId: ThreadId,
    input: WakeInput,
    elsewhere?: number,
  ): Effect.Effect<{ readonly id: string; readonly at: string }, AppToolError>;
  /** How many wakes the thread has pending here. */
  pendingOf(threadId: ThreadId): Effect.Effect<number>;
  /**
   * Drops one of the thread's wakes by id, or with no id all of them; `cancelled` is 0 when none
   * matched, since `cancel_wake` also looks in the workspace's outbox.
   */
  cancel(threadId: ThreadId, id: string | undefined): Effect.Effect<{ readonly cancelled: number }>;
  /**
   * Arms every stored wake, one already due at once. Called once, after the session policy is set
   * and the wake tools are registered: a due wake opens a session, which keeps the policy and the
   * tool list it opened with.
   */
  readonly start: Effect.Effect<void>;
  /** Every pending wake, for the rows and headers that show them. */
  readonly list: Effect.Effect<ThreadWakesList>;
  /**
   * `thread.snooze`: out of the active lists until `until` (epoch ms), or with `undefined` back now.
   * Refused for a time already past or more than `SNOOZE_AHEAD_MAX_DAYS` ahead.
   */
  snooze(
    threadId: ThreadId,
    until: number | undefined,
  ): Effect.Effect<Thread, ThreadNotFound | InvalidState>;
}

const SNOOZE_BREAKERS: ReadonlySet<ThreadStatus> = new Set([
  "needsApproval",
  "needsInput",
  "error",
]);

const snoozeKey = (threadId: ThreadId) => `snooze:${threadId}`;

const unsnoozed = (thread: Thread): Thread => {
  const { snoozedUntil, ...rest } = thread;
  void snoozedUntil;
  return rest;
};

/** What `schedule_wake` asks for, its PR already resolved and looked up by the tool. */
export interface WakeInput {
  readonly at?: string | undefined;
  readonly inMinutes?: number | undefined;
  readonly note: string;
  /** A PR whose events fire it beside its time, which is then its fallback. */
  readonly onPr?: PrRef | undefined;
  readonly on?: ReadonlyArray<PrWakeEvent> | undefined;
  /** What the tool's lookup saw of `onPr`; absent when GitHub couldn't be asked. */
  readonly seen?: PrWatchSeen | undefined;
  /** What it waits for instead of a PR, armed by its source (`WakeConditions.arm`). */
  readonly conditionState?: StoredWakeCondition | undefined;
}

/** The PR or condition fields of a stored wake, from what `schedule_wake` was given. */
export const prWakeFields = (input: WakeInput) =>
  input.conditionState !== undefined
    ? { condition: input.conditionState.spec, conditionState: input.conditionState }
    : input.onPr === undefined
      ? {}
      : {
          onPr: { repo: input.onPr.repo, number: input.onPr.number },
          ...(input.on === undefined ? {} : { on: [...input.on] }),
          ...(input.seen === undefined ? {} : { seen: input.seen }),
        };

/** What the publisher's sweeps look up for a thread's wakes on PRs, the verdict's with reviews. */
export const prWakeWatches = (
  wakes: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly onPr?: PrRef | undefined;
    readonly on?: ReadonlyArray<PrWakeEvent> | undefined;
  }>,
) =>
  wakes.flatMap((wake) =>
    wake.onPr === undefined
      ? []
      : [
          {
            threadId: wake.threadId,
            repo: wake.onPr.repo,
            number: wake.onPr.number,
            reviews: wake.on?.includes("verdict") === true,
          },
        ],
  );

export class ThreadWakes extends Context.Service<ThreadWakes, ThreadWakesShape>()(
  "@gram/server/ThreadWakes",
) {}

const toolError = (tool: string, message: string) => new AppToolError({ tool, message });

/** The service; `start` arms the stored wakes, a fiber per wake, all ending with the scope. */
export const ThreadWakesLive = Layer.effect(
  ThreadWakes,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const hub = yield* EventHub;
    const publisher = yield* GitStatePublisher;
    const conditions = yield* WakeConditions;
    const timers = yield* Timers;
    const alarms = yield* FiberMap.make<string>();
    const armed = new Map<string, ThreadId>();
    const lock = yield* Semaphore.make(1);

    const syncWatches = store.listThreadWakes.pipe(
      Effect.flatMap((wakes) => publisher.watchPrs("threadWakes", prWakeWatches(wakes))),
    );

    const changed = Effect.andThen(syncWatches, hub.publish({ type: "threadWakes.changed" }));

    const findWake = (id: string) =>
      store.listThreadWakes.pipe(Effect.map((wakes) => wakes.find((each) => each.id === id)));

    const arm = (
      wake: ThreadWake,
      after?: Duration.Duration,
      fired?: PrWakeFired,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        armed.set(wake.id, wake.threadId);
        yield* FiberMap.run(
          alarms,
          wake.id,
          timers
            .until(
              `wake:${wake.id}`,
              after === undefined ? wake.at : now + Duration.toMillis(after),
            )
            .pipe(Effect.andThen(fire(wake.id, fired))),
        );
      });

    const held = (thread: Thread) =>
      Effect.gen(function* () {
        if (thread.parked) return true;
        if (thread.workspaceId === undefined) return false;
        const state = yield* store
          .getWorkspace(thread.workspaceId)
          .pipe(Effect.orElseSucceed(() => undefined));
        return state?.paused !== undefined;
      });

    const fire = (id: string, firedNow?: PrWakeFired): Effect.Effect<void> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const wake = yield* findWake(id);
          if (wake === undefined) return;
          const fired = wake.fired ?? firedNow;
          const met = wake.conditionState?.fired !== undefined;
          const now = yield* Clock.currentTimeMillis;
          if (fired === undefined && !met && now < wake.at) return yield* arm(wake);
          const thread = yield* store.getThread(wake.threadId).pipe(Effect.option);
          if (thread._tag === "Some" && (yield* held(thread.value))) {
            return yield* arm(wake, THREAD_WAKE_RETRY, fired);
          }
          if (thread._tag === "Some") {
            const text =
              wake.conditionState !== undefined
                ? conditionWakeText({ ...wake, conditionState: wake.conditionState })
                : wake.onPr === undefined
                  ? wakeDueText(wake)
                  : prWakeText({ ...wake, onPr: wake.onPr }, fired);
            const delivered = yield* runtimes
              .sendNotice(wake.threadId, `wake:${wake.id}`, { text })
              .pipe(
                Effect.as(true),
                Effect.catch((e) =>
                  Effect.logWarning("scheduled wake not delivered").pipe(
                    Effect.annotateLogs({ threadId: wake.threadId, error: e.message }),
                    Effect.as(e._tag !== "InvalidState"),
                  ),
                ),
              );
            if (!delivered) return yield* arm(wake, THREAD_WAKE_RETRY, fired);
          }
          yield* store.removeThreadWakes(wake.threadId, wake.id);
          armed.delete(wake.id);
          yield* changed;
        }),
      );

    const armSnooze = (threadId: ThreadId, until: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* FiberMap.run(
          alarms,
          snoozeKey(threadId),
          timers.until(snoozeKey(threadId), until).pipe(Effect.andThen(endSnooze(threadId, false))),
        );
      });

    const endSnooze = (threadId: ThreadId, early: boolean): Effect.Effect<void> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const found = yield* store.getThread(threadId).pipe(Effect.option);
          if (found._tag === "None") return;
          const until = found.value.snoozedUntil;
          if (until === undefined) return;
          const now = yield* Clock.currentTimeMillis;
          if (!early && now < until) return yield* armSnooze(threadId, until);
          yield* runtimes
            .updateThread(threadId, (thread) => ({ ...unsnoozed(thread), unread: true }))
            .pipe(Effect.ignore);
          yield* Effect.logInfo("snoozed thread back").pipe(
            Effect.annotateLogs({ threadId, early }),
          );
        }),
      );

    const snooze: ThreadWakesShape["snooze"] = (threadId, until) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (until === undefined) {
            yield* FiberMap.remove(alarms, snoozeKey(threadId));
            return yield* runtimes.updateThread(threadId, unsnoozed);
          }
          const now = yield* Clock.currentTimeMillis;
          if (!Number.isFinite(until) || until <= now) {
            return yield* new InvalidState({ message: "That time has already passed", threadId });
          }
          if (until > now + SNOOZE_AHEAD_MAX_DAYS * DAY_MS) {
            return yield* new InvalidState({
              message: `A snooze can be at most ${SNOOZE_AHEAD_MAX_DAYS} days ahead`,
              threadId,
            });
          }
          const thread = yield* runtimes.updateThread(threadId, (t) => ({
            ...t,
            snoozedUntil: until,
          }));
          yield* armSnooze(threadId, until);
          return thread;
        }),
      );

    const onWatchedPr = (badge: PrStatus) =>
      Effect.gen(function* () {
        for (const wake of yield* store.listThreadWakes) {
          if (wake.onPr === undefined || !isBadgeOf(badge, wake.onPr)) continue;
          if (wake.fired !== undefined) continue;
          const fired = prWakeEventOf(wake.seen, badge, wake.on ?? DEFAULT_PR_WAKE_EVENTS);
          if (fired === undefined) {
            const seen = nextPrWatchSeen(wake.seen, badge);
            if (JSON.stringify(seen) !== JSON.stringify(wake.seen)) {
              yield* store.updateThreadWakePr(wake.id, { seen });
            }
            continue;
          }
          yield* store.updateThreadWakePr(wake.id, { fired });
          armed.set(wake.id, wake.threadId);
          yield* FiberMap.run(alarms, wake.id, fire(wake.id, fired));
        }
      });
    yield* publisher.observe({
      onState: () => Effect.void,
      onRound: () => Effect.void,
      onWatchedPr,
    });

    let started = false;
    const start = Effect.gen(function* () {
      if (started) return;
      started = true;
      for (const thread of yield* store.listThreads) {
        if (thread.snoozedUntil !== undefined) yield* armSnooze(thread.id, thread.snoozedUntil);
      }
      for (const wake of yield* store.listThreadWakes) {
        yield* wake.fired !== undefined
          ? arm(wake, Duration.zero, wake.fired)
          : wake.conditionState?.fired !== undefined
            ? arm(wake, Duration.zero)
            : arm(wake);
      }
      yield* syncWatches;
    });

    yield* conditions.register({
      name: "thread wakes",
      pending: store.listThreadWakes.pipe(
        Effect.map((wakes) => wakes.flatMap((wake) => conditionWakeOf(wake) ?? [])),
      ),
      saveSeen: (id, seen) => store.updateThreadWakeCondition(id, { seen }).pipe(Effect.asVoid),
      fire: (id, fired) =>
        Effect.gen(function* () {
          if (!(yield* store.updateThreadWakeCondition(id, { fired }))) return;
          yield* changed;
          if (!started) return;
          const wake = yield* findWake(id);
          if (wake !== undefined) yield* arm(wake, Duration.zero);
        }),
    });

    yield* hub
      .internalEvents(
        (event): event is Extract<typeof event, { type: "thread.status" }> =>
          event.type === "thread.status" && SNOOZE_BREAKERS.has(event.status),
        "snooze breakers",
      )
      .pipe(
        Stream.runForEach(({ threadId }) =>
          store.getThread(threadId).pipe(
            Effect.flatMap((thread) =>
              thread.snoozedUntil === undefined ? Effect.void : endSnooze(threadId, true),
            ),
            Effect.ignore,
          ),
        ),
        Effect.forkScoped,
      );

    yield* hub.internalEvents(isThreadRemoved, "thread wakes").pipe(
      Stream.runForEach(({ threadId }) =>
        Effect.gen(function* () {
          yield* FiberMap.remove(alarms, snoozeKey(threadId));
          const ids = [...armed].flatMap(([id, owner]) => (owner === threadId ? [id] : []));
          if (ids.length === 0) return;
          for (const id of ids) {
            armed.delete(id);
            yield* FiberMap.remove(alarms, id);
          }
          yield* changed;
        }),
      ),
      Effect.forkScoped,
    );

    const schedule: ThreadWakesShape["schedule"] = (threadId, input, elsewhere = 0) =>
      Effect.gen(function* () {
        const tool = "schedule_wake";
        const now = yield* Clock.currentTimeMillis;
        const due = prWakeDueAt(input, now);
        if (!due.ok) return yield* toolError(tool, due.reason);
        const wake: ThreadWake = {
          id: randomUUID(),
          threadId,
          at: due.at,
          note: redactText(input.note).slice(0, WAKE_NOTE_MAX),
          setAt: now,
          ...prWakeFields(input),
        };
        if (!(yield* store.addThreadWake(wake, WAKES_PER_THREAD_MAX - elsewhere))) {
          return yield* toolError(
            tool,
            `You have ${WAKES_PER_THREAD_MAX} wakes pending already; cancel one with cancel_wake first.`,
          );
        }
        yield* arm(wake);
        yield* changed;
        if (wake.conditionState !== undefined) {
          yield* conditions.nudge(wake.conditionState.spec.kind);
        }
        const badge =
          wake.onPr === undefined ? undefined : yield* publisher.watchedBadge(wake.onPr);
        if (badge !== undefined) yield* onWatchedPr(badge);
        return { id: wake.id, at: new Date(wake.at).toISOString() };
      });

    const cancel: ThreadWakesShape["cancel"] = (threadId, id) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const dropped = yield* store.removeThreadWakes(threadId, id);
          for (const wake of dropped) {
            armed.delete(wake.id);
            yield* FiberMap.remove(alarms, wake.id);
          }
          if (dropped.length > 0) yield* changed;
          return { cancelled: dropped.length };
        }),
      );

    return ThreadWakes.of({
      schedule,
      cancel,
      start,
      pendingOf: (threadId) =>
        store.listThreadWakes.pipe(
          Effect.map((wakes) => wakes.filter((wake) => wake.threadId === threadId).length),
        ),
      list: store.listThreadWakes.pipe(Effect.map((wakes) => ({ wakes }))),
      snooze,
    });
  }),
);

/** `threads.wakes` and `thread.cancelWake`: the pending wakes the rows show, and the user's Cancel. */
export const threadWakeHandlers = Effect.gen(function* () {
  const wakes = yield* ThreadWakes;
  return {
    "threads.wakes": () =>
      wakes.list.pipe(
        Effect.flatMap(({ wakes: all }) =>
          Effect.map(
            readableOnly(all, (wake) => wake.threadId),
            (readable) => ({ wakes: readable }),
          ),
        ),
      ),
    "thread.cancelWake": ({ threadId, id }) => wakes.cancel(threadId, id),
    "thread.snooze": ({ threadId, until }) => wakes.snooze(threadId, until ?? undefined),
  } satisfies Partial<Handlers>;
});
