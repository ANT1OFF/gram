// Whether anyone is around to see a poll's result. The sweep is server-side and outlives every
// window, so without this it keeps asking GitHub at full pace through a closed laptop lid and a
// minimised app.
//
// Two inputs: the OS power state, forwarded by the desktop shell over the utility-process port, and
// what each connected window says about itself. A server with no window attached (headless runs,
// the e2e harness, a browser tab that hasn't reported yet) is treated as active — polling must
// never depend on a window existing.

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { IDLE_MULTIPLIER } from "../github/poll-backoff.ts";

export type PowerState = "awake" | "suspended";

/** One connected window as its renderer sees itself. */
export interface WindowActivity {
  /**
   * The document is not hidden. macOS hides one that is minimised, on another Space or fully covered
   * by another app's windows, so a window the user merely isn't looking at is often not `visible`.
   */
  readonly visible: boolean;
  readonly focused: boolean;
}

/**
 * `active`: poll at the base cadence. `idle`: on screen but in the background, so a stale badge
 * costs the user nothing until they look — poll, but slower. `hidden`: awake with no window showing,
 * so no badge is worth a request, but a watch the user switched on still owes them its notification.
 * `paused`: the machine sleeps, and there is nothing to poll for.
 */
export type ActivityLevel = "active" | "idle" | "hidden" | "paused";

/** A window is showing, so a fresh badge has someone to see it. */
export const onScreen = (level: ActivityLevel): boolean => level === "active" || level === "idle";

/**
 * `windows` is `undefined` until a window has ever registered, which is how headless stays active;
 * an empty array afterwards means every window was closed.
 */
export const activityLevel = (
  power: PowerState,
  windows: ReadonlyArray<WindowActivity> | undefined,
): ActivityLevel => {
  if (power === "suspended") return "paused";
  if (windows === undefined) return "active";
  if (windows.some((w) => w.focused && w.visible)) return "active";
  if (windows.some((w) => w.visible)) return "idle";
  return "hidden";
};

export class AppActivity extends Context.Service<
  AppActivity,
  {
    readonly level: Effect.Effect<ActivityLevel>;
    /**
     * Epoch ms the app last stopped being `active` (no window focused and showing, or the machine
     * asleep); `undefined` while it is active. How long the user has been away from Gram.
     */
    readonly inactiveSince: Effect.Effect<number | undefined>;
    /** Completes with the level once `accept` holds for it; at once when it already does. */
    readonly awaitLevel: (
      accept: (level: ActivityLevel) => boolean,
    ) => Effect.Effect<ActivityLevel>;
    /** Completes at once while a window is showing; otherwise waits for one to come back. */
    readonly awaitActive: Effect.Effect<void>;
    readonly setPower: (state: PowerState) => Effect.Effect<void>;
    readonly setWindows: (windows: ReadonlyArray<WindowActivity>) => Effect.Effect<void>;
    readonly changes: Stream.Stream<ActivityLevel>;
  }
>()("@gram/server/AppActivity") {
  static readonly layer = Layer.effect(
    AppActivity,
    Effect.gen(function* () {
      let power: PowerState = "awake";
      let windows: ReadonlyArray<WindowActivity> | undefined;
      let level: ActivityLevel = "active";
      let inactiveSince: number | undefined;
      const levels = yield* PubSub.unbounded<ActivityLevel>();
      const resumes = yield* PubSub.unbounded<ActivityLevel>();

      const recompute = Effect.gen(function* () {
        const next = activityLevel(power, windows);
        if (next === level) return;
        const previous = level;
        level = next;
        if (next === "active") inactiveSince = undefined;
        else if (previous === "active") inactiveSince = yield* Clock.currentTimeMillis;
        yield* Effect.logDebug("poll activity changed").pipe(
          Effect.annotateLogs({ from: previous, to: next }),
        );
        yield* PubSub.publish(levels, next);
        yield* PubSub.publish(resumes, next);
      });

      const awaitLevel = (accept: (level: ActivityLevel) => boolean) =>
        Effect.gen(function* () {
          // Subscribed before the level is read, so a change between the two isn't missed.
          const wakes = yield* PubSub.subscribe(resumes);
          if (accept(level)) return level;
          const next = yield* Stream.fromSubscription(wakes).pipe(
            Stream.filter(accept),
            Stream.runHead,
          );
          return Option.getOrElse(next, () => level);
        }).pipe(Effect.scoped);

      return {
        level: Effect.sync(() => level),
        inactiveSince: Effect.sync(() => inactiveSince),
        awaitLevel,
        awaitActive: Effect.asVoid(awaitLevel(onScreen)),
        setPower: (state) =>
          Effect.suspend(() => {
            power = state;
            return recompute;
          }),
        setWindows: (next) =>
          Effect.suspend(() => {
            windows = next;
            return recompute;
          }),
        changes: Stream.fromPubSub(levels),
      };
    }),
  );
}

/** A message the desktop shell posts over the utility-process port. */
export const powerStateOf = (message: unknown): PowerState | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  if (record["type"] !== "power") return undefined;
  const state = record["state"];
  return state === "awake" || state === "suspended" ? state : undefined;
};

interface ParentPort {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
  off?(event: "message", listener: (message: { data: unknown }) => void): void;
}

/**
 * Feeds `AppActivity` from the desktop shell's `powerMonitor`. A no-op outside Electron's utility
 * process, so headless and test runs never pause.
 */
export const powerBridge = Layer.effectDiscard(
  Effect.gen(function* () {
    const port = (process as { parentPort?: ParentPort }).parentPort;
    if (port === undefined) return;
    const activity = yield* AppActivity;
    const run = yield* FiberSet.makeRuntime();
    const listener = ({ data }: { data: unknown }) => {
      const state = powerStateOf(data);
      if (state !== undefined)
        run(
          activity
            .setPower(state)
            .pipe(
              Effect.onError((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("power event failed", cause),
              ),
            ),
        );
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => port.on("message", listener)),
      () => Effect.sync(() => port.off?.("message", listener)),
    );
  }),
);

/** `AppActivity`, listening for the desktop shell's power events when there is a shell. */
export const AppActivityLive = powerBridge.pipe(Layer.provideMerge(AppActivity.layer));

/**
 * Runs `pass` every `interval` while a window is showing, stretched by `IDLE_MULTIPLIER` while it
 * is shown but not focused, and not at all while none is: the next pass waits for one to come back
 * and runs as it does, so what the window shows is fresh. Without `AppActivity` (headless, tests)
 * it is the plain spaced loop. For polls whose only reader is the window, such as a chip or meter;
 * a poll that work depends on while nobody looks keeps its own cadence.
 */
export const pollWhileShown = <E, R>(
  activity: Option.Option<AppActivity["Service"]>,
  interval: Duration.Input,
  pass: Effect.Effect<void, E, R>,
): Effect.Effect<never, E, R> => {
  const base = Duration.fromInputUnsafe(interval);
  return Effect.gen(function* () {
    const level = Option.isNone(activity) ? "active" : yield* activity.value.awaitLevel(onScreen);
    yield* pass;
    if (Option.isNone(activity) || level !== "idle") return yield* Effect.sleep(base);
    // Focus coming back cuts the stretched wait short.
    yield* Effect.raceFirst(
      Effect.sleep(Duration.times(base, IDLE_MULTIPLIER)),
      activity.value.awaitLevel((next) => next === "active"),
    );
  }).pipe(Effect.forever);
};
