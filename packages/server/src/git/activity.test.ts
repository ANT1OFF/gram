import { describe, expect, it } from "@effect/vitest";
import { EventEmitter } from "node:events";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import {
  activityLevel,
  AppActivity,
  onScreen,
  pollWhileShown,
  powerStateOf,
  powerBridge,
  type ActivityLevel,
} from "./activity.ts";

describe("activityLevel", () => {
  it("polls when no window has reported, so headless runs never stall", () => {
    expect(activityLevel("awake", undefined)).toBe("active");
  });

  it("pauses while suspended, whatever the windows say", () => {
    expect(activityLevel("suspended", undefined)).toBe("paused");
    expect(activityLevel("suspended", [{ visible: true, focused: true }])).toBe("paused");
  });

  it("is idle on screen in the background, and hidden once no window is showing", () => {
    expect(activityLevel("awake", [{ visible: true, focused: true }])).toBe("active");
    expect(activityLevel("awake", [{ visible: true, focused: false }])).toBe("idle");
    expect(
      activityLevel("awake", [
        { visible: false, focused: false },
        { visible: true, focused: false },
      ]),
    ).toBe("idle");
    expect(activityLevel("awake", [{ visible: false, focused: false }])).toBe("hidden");
    expect(activityLevel("awake", [])).toBe("hidden");
  });

  it("keeps hidden apart from paused, so only a sleeping machine stops every poll", () => {
    expect(activityLevel("suspended", [{ visible: false, focused: false }])).toBe("paused");
    const levels: ReadonlyArray<ActivityLevel> = ["active", "idle", "hidden", "paused"];
    expect(levels.filter(onScreen)).toEqual(["active", "idle"]);
  });
});

describe("powerStateOf", () => {
  it("reads only the shell's power messages", () => {
    expect(powerStateOf({ type: "power", state: "suspended" })).toBe("suspended");
    expect(powerStateOf({ type: "power", state: "awake" })).toBe("awake");
    expect(powerStateOf({ type: "power", state: "dozing" })).toBeUndefined();
    expect(powerStateOf({ type: "boot", url: "x" })).toBeUndefined();
    expect(powerStateOf("power")).toBeUndefined();
  });
});

describe("AppActivity", () => {
  it.effect("logs a failed power callback and interrupts pending work when the bridge closes", () =>
    Effect.gen(function* () {
      const port = new EventEmitter();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Object.getOwnPropertyDescriptor(process, "parentPort");
          Object.defineProperty(process, "parentPort", { value: port, configurable: true });
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous) Object.defineProperty(process, "parentPort", previous);
            else Reflect.deleteProperty(process, "parentPort");
          }),
      );
      const logged = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const messages: Array<unknown> = [];
      const logger = Logger.make(({ message }) => {
        messages.push(message);
        Deferred.doneUnsafe(logged, Effect.void);
      });
      const activity = yield* AppActivity;
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      yield* Layer.buildWithScope(
        powerBridge.pipe(
          Layer.provide(
            Layer.succeed(AppActivity)({
              ...activity,
              setPower: (state) =>
                state === "suspended"
                  ? Effect.die("power callback defect")
                  : Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                    ),
            }),
          ),
        ),
        scope,
      ).pipe(Effect.provide(Logger.layer([logger])));
      port.emit("message", { data: { type: "power", state: "suspended" } });
      yield* Deferred.await(logged);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(expect.arrayContaining(["power event failed"]));

      const listener = port.listeners("message")[0]!;
      port.emit("message", { data: { type: "power", state: "awake" } });
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      expect(Deferred.isDoneUnsafe(interrupted)).toBe(true);
      expect(port.listenerCount("message")).toBe(0);
      listener({ data: { type: "power", state: "suspended" } });
      yield* Effect.yieldNow;
      expect(messages).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(AppActivity.layer)),
  );

  it.effect("remembers when the app stopped being in use, and forgets it on the way back", () =>
    Effect.gen(function* () {
      const activity = yield* AppActivity;
      expect(yield* activity.inactiveSince).toBeUndefined();

      yield* TestClock.adjust(1_000);
      yield* activity.setWindows([{ visible: true, focused: false }]);
      expect(yield* activity.inactiveSince).toBe(1_000);

      // Idle to hidden to asleep is one stretch away, not three.
      yield* TestClock.adjust(1_000);
      yield* activity.setWindows([{ visible: false, focused: false }]);
      yield* activity.setPower("suspended");
      expect(yield* activity.inactiveSince).toBe(1_000);

      yield* activity.setPower("awake");
      yield* activity.setWindows([{ visible: true, focused: true }]);
      expect(yield* activity.inactiveSince).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(AppActivity.layer)),
  );

  it.effect("holds awaitActive while paused and releases it on the way back", () =>
    Effect.gen(function* () {
      const activity = yield* AppActivity;
      yield* activity.awaitActive;

      yield* activity.setPower("suspended");
      const waiting = yield* Effect.forkScoped(activity.awaitActive);
      yield* Effect.yieldNow;
      expect(waiting.pollUnsafe()).toBeUndefined();

      yield* activity.setPower("awake");
      yield* Fiber.join(waiting);
      expect(yield* activity.level).toBe("active");
    }).pipe(Effect.scoped, Effect.provide(AppActivity.layer)),
  );

  it.effect(
    "holds awaitActive while hidden, but lets a waiter that only needs the machine awake go",
    () =>
      Effect.gen(function* () {
        const activity = yield* AppActivity;
        yield* activity.setPower("suspended");
        yield* activity.setWindows([{ visible: false, focused: false }]);
        const awake = yield* Effect.forkScoped(activity.awaitLevel((level) => level !== "paused"));
        const showing = yield* Effect.forkScoped(activity.awaitActive);
        yield* Effect.yieldNow;
        expect(awake.pollUnsafe()).toBeUndefined();

        yield* activity.setPower("awake");
        expect(yield* Fiber.join(awake)).toBe("hidden");
        expect(showing.pollUnsafe()).toBeUndefined();

        yield* activity.setWindows([{ visible: true, focused: false }]);
        yield* Fiber.join(showing);
        expect(yield* activity.level).toBe("idle");
      }).pipe(Effect.scoped, Effect.provide(AppActivity.layer)),
  );
});

describe("pollWhileShown", () => {
  it.effect(
    "polls on screen, slower while unfocused, never while hidden, and at once on return",
    () =>
      Effect.gen(function* () {
        const activity = yield* AppActivity;
        let passes = 0;
        yield* pollWhileShown(
          Option.some(activity),
          "5 seconds",
          Effect.sync(() => void passes++),
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        // No window has reported yet: active, as headless runs are.
        expect(passes).toBe(1);
        yield* TestClock.adjust("5 seconds");
        expect(passes).toBe(2);

        yield* activity.setWindows([{ visible: false, focused: false }]);
        yield* TestClock.adjust("1 hour");
        expect(passes).toBe(2);

        yield* activity.setWindows([{ visible: true, focused: false }]);
        yield* Effect.yieldNow;
        expect(passes).toBe(3);
        yield* TestClock.adjust("5 seconds");
        expect(passes).toBe(3);
        yield* TestClock.adjust("15 seconds");
        expect(passes).toBe(4);

        // Focus cuts the unfocused wait short.
        yield* TestClock.adjust("1 second");
        yield* activity.setWindows([{ visible: true, focused: true }]);
        yield* Effect.yieldNow;
        expect(passes).toBe(5);
        yield* TestClock.adjust("5 seconds");
        expect(passes).toBe(6);

        yield* activity.setPower("suspended");
        yield* TestClock.adjust("1 hour");
        expect(passes).toBe(6);
      }).pipe(Effect.scoped, Effect.provide(AppActivity.layer)),
  );

  it.effect("is the plain spaced loop without AppActivity", () =>
    Effect.gen(function* () {
      let passes = 0;
      yield* pollWhileShown(
        Option.none(),
        "5 seconds",
        Effect.sync(() => void passes++),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 minute");
      expect(passes).toBe(13);
    }).pipe(Effect.scoped),
  );
});
