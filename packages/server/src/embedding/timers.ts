// Where a wake, a snooze or a routine waits for its time. On the desktop that is a sleep in the
// server's own process. A server run behind another service may be stopped while it is idle, and a
// stopped server fires nothing: there each wait is also registered with the deployment's scheduler
// (`GRAM_SCHEDULER_URL`), which starts the server if it has to and calls back when the time comes.
//
//   PUT    <scheduler>/timers/<key>   { "key": "...", "at": "2026-01-01T09:00:00.000Z", "atMs": 1767258000000 }
//   DELETE <scheduler>/timers/<key>
//   POST   /embed/v1/timers/fire      { "key": "..." }   →  { "fired": true | false }
//   GET    /embed/v1/timers           →  { "timers": [ { "key", "at", "atMs" } ] }
//
// What is waited for stays in the server's own store, as before: the scheduler holds a key and a
// time and nothing else, and learns nothing of what the wake is for. So the two can't disagree
// about what is due. A server that starts arms every stored wait again, fires at once whatever
// fell due while it was down, and registers the rest, which is how a registration the scheduler
// lost comes back. A call for a key nothing waits on answers `fired: false`, and the scheduler
// drops it: the wait was cancelled, or already fired.
//
// The scheduler's call is the trigger, and a wait also ends by itself a little after its time
// (`FALLBACK_GRACE`), so a scheduler that is down delays a running server's wakes and never loses
// them.

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { callOutside } from "./outside.ts";
import { Embedding } from "./embedding.ts";
import { answer, EmbedInbound, refusal } from "./inbound.ts";

export interface TimersShape {
  /**
   * Completes once `at` (epoch ms) has come. `key` names the wait to an outside scheduler, so it
   * is stable across restarts and unique among everything waiting. Interrupting it takes the wait
   * back.
   */
  readonly until: (key: string, at: number) => Effect.Effect<void>;
}

const local: TimersShape = {
  until: (_key, at) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sleep(Duration.millis(Math.max(0, at - now))),
    ),
};

/** How long past its time a registered wait gives the scheduler before it ends by itself. */
export const FALLBACK_GRACE = Duration.seconds(30);

const pathOf = (key: string) => `/timers/${encodeURIComponent(key)}`;

/** How long until a registration the scheduler couldn't be told of is tried again. */
const RETRY_EVERY = Duration.seconds(30);

/** A key as the scheduler is given it: printable, with no separator a path could be split on. */
const KEY = /^[A-Za-z0-9_.:@-]{1,200}$/;

/**
 * The timers every wake, snooze and routine waits on. A sleep unless a layer says otherwise, so a
 * test or a build with no scheduler needs to provide nothing.
 */
export const Timers = Context.Reference<TimersShape>("@gram/server/Timers", {
  defaultValue: () => local,
});

/** Sleeps, and registers each wait with the configured scheduler while hosted features are on. */
export const TimersLive = Layer.effect(
  Timers,
  Effect.gen(function* () {
    const embedding = yield* Embedding;
    const inbound = yield* EmbedInbound;
    const scheduler = embedding.config.scheduler;
    if (scheduler === undefined) return local;

    interface Waiting {
      readonly at: number;
      readonly fired: Deferred.Deferred<void>;
    }
    const waiting = new Map<string, Waiting>();

    const scope = yield* Effect.scope;
    /** Keys whose registration may not be what `waiting` says; each is made so, one at a time. */
    const stale = yield* Queue.unbounded<string>();
    /** Keys the scheduler couldn't be told of, so the log says so once, not on every retry. */
    const failing = new Set<string>();
    const touch = (key: string) => Queue.offer(stale, key).pipe(Effect.asVoid);

    /**
     * Makes the scheduler's copy of `key` what `waiting` holds now: registered at its time, or
     * gone. Told from the state rather than as a queue of puts and deletes, so a wait cancelled and
     * armed again can't end up deleted, whichever call lands last. A call that fails is tried
     * again while the server runs; the wait's own fallback covers the time between.
     */
    const reconcile = (key: string) =>
      Effect.suspend(() => {
        const wanted = waiting.get(key);
        return callOutside(
          "scheduler",
          scheduler,
          wanted === undefined
            ? { method: "DELETE", path: pathOf(key), accept: [404] }
            : {
                method: "PUT",
                path: pathOf(key),
                json: { key, at: new Date(wanted.at).toISOString(), atMs: wanted.at },
              },
        );
      }).pipe(
        Effect.andThen(Effect.sync(() => void failing.delete(key))),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (!failing.has(key)) {
              failing.add(key);
              yield* Effect.logWarning("scheduler not told of a timer; trying again").pipe(
                Effect.annotateLogs({ key, error: error.message }),
              );
            }
            yield* Effect.sleep(RETRY_EVERY).pipe(Effect.andThen(touch(key)), Effect.forkIn(scope));
          }),
        ),
      );
    yield* Queue.take(stale).pipe(
      Effect.flatMap(reconcile),
      // Nothing one key does may end the worker every other key is told through.
      Effect.catchCause((cause) =>
        Effect.logWarning("telling the scheduler of a timer failed").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    yield* inbound.route("POST", "timers/fire", (body) =>
      Effect.gen(function* () {
        const key = body?.["key"];
        if (typeof key !== "string" || !KEY.test(key))
          return refusal(400, "`key` is a timer's key");
        const found = waiting.get(key);
        if (found === undefined) return answer({ fired: false });
        yield* Deferred.succeed(found.fired, undefined);
        return answer({ fired: true });
      }),
    );
    yield* inbound.route("GET", "timers", () =>
      Effect.sync(() =>
        answer({
          timers: [...waiting].map(([key, { at }]) => ({
            key,
            at: new Date(at).toISOString(),
            atMs: at,
          })),
        }),
      ),
    );

    const until: TimersShape["until"] = (key, at) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // Due already: nothing to register. Off, or a key no scheduler could be told: a sleep.
        if (at <= now) return;
        if (!Number.isFinite(at) || !KEY.test(key) || !(yield* embedding.on)) {
          return yield* local.until(key, at);
        }
        const mine: Waiting = { at, fired: yield* Deferred.make<void>() };
        /** Forgets the wait, unless the key was armed again and holds a newer one. */
        const forget = Effect.suspend(() => {
          if (waiting.get(key) !== mine) return Effect.void;
          waiting.delete(key);
          return touch(key);
        });
        // Registered and awaited as one step: an interrupt between the two would leave the wait,
        // and its timer at the scheduler, with nobody to forget them.
        const outcome = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            waiting.set(key, mine);
            yield* touch(key);
            return yield* restore(
              Effect.raceFirst(
                Deferred.await(mine.fired).pipe(Effect.as("called" as const)),
                Effect.sleep(Duration.sum(Duration.millis(at - now), FALLBACK_GRACE)).pipe(
                  Effect.as("fallback" as const),
                ),
              ),
            ).pipe(Effect.onInterrupt(() => forget));
          }),
        );
        if (outcome === "fallback") {
          yield* Effect.logWarning("timer fired by its fallback; the scheduler didn't call").pipe(
            Effect.annotateLogs({ key }),
          );
          return yield* forget;
        }
        // The scheduler fired it and holds it no longer.
        if (waiting.get(key) === mine) waiting.delete(key);
        // Its clock decided, and this one may be a moment behind: whoever waits checks the time by
        // this clock, and would only arm the wait again.
        const left = at - (yield* Clock.currentTimeMillis);
        if (left > 0) yield* Effect.sleep(Duration.millis(Math.min(left, 60_000)));
      });

    return { until };
  }),
);
