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

const sleepUntil = (at: number): Effect.Effect<void> =>
  Number.isNaN(at)
    ? Effect.void
    : at === Number.POSITIVE_INFINITY
      ? Effect.never
      : Effect.flatMap(Clock.currentTimeMillis, (now) =>
          now >= at
            ? Effect.void
            : Effect.andThen(Effect.sleep(Duration.millis(at - now)), sleepUntil(at)),
        );

const local: TimersShape = { until: (_key, at) => sleepUntil(at) };

/** How long past its time a registered wait gives the scheduler before it ends by itself. */
export const FALLBACK_GRACE = Duration.seconds(30);

const pathOf = (key: string) => `/timers/${encodeURIComponent(key)}`;

const RETRY_EVERY = Duration.seconds(30);

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
    const stale = yield* Queue.unbounded<string>();
    const failing = new Set<string>();
    const touch = (key: string) => Queue.offer(stale, key).pipe(Effect.asVoid);

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
        if (at <= now) return;
        if (!Number.isFinite(at) || !KEY.test(key) || !(yield* embedding.on)) {
          return yield* local.until(key, at);
        }
        const mine: Waiting = { at, fired: yield* Deferred.make<void>() };
        const forget = Effect.suspend(() => {
          if (waiting.get(key) !== mine) return Effect.void;
          waiting.delete(key);
          return touch(key);
        });
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
        if (waiting.get(key) === mine) waiting.delete(key);
        yield* sleepUntil(Math.min(at, (yield* Clock.currentTimeMillis) + 60_000));
      });

    return { until };
  }),
);
