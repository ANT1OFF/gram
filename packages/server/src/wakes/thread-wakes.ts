/**
 * Wakes a plain thread sets itself with `schedule_wake`. A workspace's threads keep theirs in its
 * outbox (`orchestration/service.ts`); every other thread's go through here, kept in `thread_wakes`
 * so a restart arms them again and one that fell due while the app was down fires at start. A due
 * wake reaches its thread as a server notice (`ThreadRuntimes.sendNotice`), never as the user's
 * words, so the turn it starts has no more authority than the one that set it. A wake on another
 * PR's events also fires on the first of them, which the publisher's sweeps watch for.
 */
import { randomUUID } from "node:crypto";
import {
  AppToolError,
  DEFAULT_PR_WAKE_EVENTS,
  WAKE_NOTE_MAX,
  WAKES_PER_THREAD_MAX,
  type PrRef,
  type PrStatus,
  type PrWakeEvent,
  type PrWatchSeen,
  type Thread,
  type ThreadId,
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
import { EventHub, isThreadRemoved } from "../events/event-hub.ts";
import { isBadgeOf } from "../git/extra-prs.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { redactText } from "../logging/redact.ts";
import {
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

/** How soon a due wake is tried again when its thread can't take it yet, or is parked. */
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
}

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
}

/** The PR fields of a stored wake, from what `schedule_wake` was given. */
export const prWakeFields = (input: WakeInput) =>
  input.onPr === undefined
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
    /** Per wake id, the fiber that fires it. */
    const alarms = yield* FiberMap.make<string>();
    /** Each armed wake's thread, so a thread's removal can stop its alarms. */
    const armed = new Map<string, ThreadId>();
    /** A wake's delivery and its cancellation, one at a time, as orchestration's `wakeLock`. */
    const lock = yield* Semaphore.make(1);

    /** The PRs the stored wakes wait on, handed to the publisher's sweeps. */
    const syncWatches = store.listThreadWakes.pipe(
      Effect.flatMap((wakes) => publisher.watchPrs("threadWakes", prWakeWatches(wakes))),
    );

    const changed = Effect.andThen(syncWatches, hub.publish({ type: "threadWakes.changed" }));

    const findWake = (id: string) =>
      store.listThreadWakes.pipe(Effect.map((wakes) => wakes.find((each) => each.id === id)));

    /** Fires `wake` at its time, or `after` from now to try one due again, `fired` if its PR's event did. */
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
          Effect.sleep(after ?? Duration.millis(Math.max(0, wake.at - now))).pipe(
            Effect.andThen(fire(wake.id, fired)),
          ),
        );
      });

    /**
     * Whether a due wake waits: its thread is parked, or is in a workspace that is paused. A
     * workspace thread's wake may have been set here while workspaces could still be turned off,
     * and a pause (the one that boot brings such a user, say) must stop it as it stops the outbox's.
     */
    const held = (thread: Thread) =>
      Effect.gen(function* () {
        if (thread.parked) return true;
        if (thread.workspaceId === undefined) return false;
        const state = yield* store
          .getWorkspace(thread.workspaceId)
          .pipe(Effect.orElseSucceed(() => undefined));
        return state?.paused !== undefined;
      });

    /**
     * A wake fell due, or its PR's event `fired`. A parked or paused thread's waits, tried again until
     * the thread is back; a thread that is gone takes it with it. Otherwise it is sent as a notice
     * and dropped.
     */
    const fire = (id: string, firedNow?: PrWakeFired): Effect.Effect<void> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const wake = yield* findWake(id);
          if (wake === undefined) return;
          // The event kept on the wake is the first one; a later one a concurrent look armed with
          // gives way to it.
          const fired = wake.fired ?? firedNow;
          const now = yield* Clock.currentTimeMillis;
          if (fired === undefined && now < wake.at) return yield* arm(wake);
          const thread = yield* store.getThread(wake.threadId).pipe(Effect.option);
          if (thread._tag === "Some" && (yield* held(thread.value))) {
            return yield* arm(wake, THREAD_WAKE_RETRY, fired);
          }
          if (thread._tag === "Some") {
            const text =
              wake.onPr === undefined
                ? wakeDueText(wake)
                : prWakeText({ ...wake, onPr: wake.onPr }, fired);
            const delivered = yield* runtimes
              .sendNotice(wake.threadId, `wake:${wake.id}`, { text })
              .pipe(
                Effect.as(true),
                Effect.catch((e) =>
                  Effect.logWarning("scheduled wake not delivered").pipe(
                    Effect.annotateLogs({ threadId: wake.threadId, error: e.message }),
                    // As a worker's wake: an agent that won't start leaves the notice queued and a
                    // thread that's gone takes nothing, while anything holding the thread (a close
                    // or a worktree cleanup) leaves the wake to be tried again.
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

    /** A watched PR's new badge: each wake waiting on it fires on the first of its events. */
    const onWatchedPr = (badge: PrStatus) =>
      Effect.gen(function* () {
        for (const wake of yield* store.listThreadWakes) {
          if (wake.onPr === undefined || !isBadgeOf(badge, wake.onPr)) continue;
          // One that fired already waits for its thread with that event.
          if (wake.fired !== undefined) continue;
          const fired = prWakeEventOf(wake.seen, badge, wake.on ?? DEFAULT_PR_WAKE_EVENTS);
          // What it saw is kept, so a restart measures the next event from it; not on an event,
          // which a held thread must still be told once it is back.
          if (fired === undefined) {
            const seen = nextPrWatchSeen(wake.seen, badge);
            if (JSON.stringify(seen) !== JSON.stringify(wake.seen)) {
              yield* store.updateThreadWakePr(wake.id, { seen });
            }
            continue;
          }
          // Kept before it is delivered: a parked thread's waits for it, restart or not.
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
      for (const wake of yield* store.listThreadWakes) {
        yield* wake.fired === undefined ? arm(wake) : arm(wake, Duration.zero, wake.fired);
      }
      yield* syncWatches;
    });

    // The store drops a closed or removed thread's wakes with it; their alarms go here.
    yield* hub.internalEvents(isThreadRemoved, "thread wakes").pipe(
      Stream.runForEach(({ threadId }) =>
        Effect.gen(function* () {
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
          // Redaction can lengthen it past what the row carries.
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
        // Another watch of the PR may have seen it move since the tool looked it up.
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
    });
  }),
);

/** `threads.wakes` and `thread.cancelWake`: the pending wakes the rows show, and the user's Cancel. */
export const threadWakeHandlers = Effect.gen(function* () {
  const wakes = yield* ThreadWakes;
  return {
    "threads.wakes": () => wakes.list,
    // A wake that fired or was cancelled while the user's click was in flight is simply gone.
    "thread.cancelWake": ({ threadId, id }) => wakes.cancel(threadId, id),
  } satisfies Partial<Handlers>;
});
