import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeAdmission, makeKeyedLock } from "./keyed-lock.ts";

it.effect("retains the same permit across an interrupted waiter and releases unused keys", () =>
  Effect.gen(function* () {
    const locks = makeKeyedLock<string>();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const holder = yield* locks
      .withLock(
        "checkout",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    expect(locks.size()).toBe(1);
    const waiting = yield* locks
      .withLock("checkout", Effect.die("interrupted waiter entered"))
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(waiting);
    expect(locks.size()).toBe(1);
    let acquired = false;
    const successor = yield* locks
      .withLock(
        "checkout",
        Effect.sync(() => {
          acquired = true;
        }),
      )
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    expect(acquired).toBe(false);
    yield* locks.withLock("other", Effect.void);
    expect(locks.size()).toBe(1);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(successor);
    expect(acquired).toBe(true);
    expect(locks.size()).toBe(0);
    yield* locks.withLock("checkout", Effect.fail("synthetic failure")).pipe(Effect.ignore);
    expect(locks.size()).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("admits a capped number in arrival order and moves the line as each leaves", () =>
  Effect.gen(function* () {
    let capacity = 1;
    const lines: Array<ReadonlyArray<string>> = [];
    const admission = makeAdmission<string>(
      Effect.sync(() => capacity),
      (waiting) => void lines.push(waiting),
    );
    const order: Array<string> = [];
    const gates = { a: yield* Deferred.make<void>(), b: yield* Deferred.make<void>() };
    const job = (key: "a" | "b" | "c") =>
      admission
        .inTurn(
          key,
          Effect.sync(() => void order.push(key)).pipe(
            Effect.andThen(key === "c" ? Effect.void : Deferred.await(gates[key])),
          ),
        )
        .pipe(Effect.forkScoped);
    const a = yield* job("a");
    yield* Effect.yieldNow;
    const b = yield* job("b");
    const c = yield* job("c");
    yield* Effect.yieldNow;
    expect(order).toEqual(["a"]);
    expect(lines.at(-1)).toEqual(["b", "c"]);
    // A larger cap is read when a slot frees.
    capacity = 2;
    yield* Deferred.succeed(gates.a, undefined);
    yield* Fiber.join(a);
    yield* Fiber.join(c);
    expect(order).toEqual(["a", "b", "c"]);
    yield* Deferred.succeed(gates.b, undefined);
    yield* Fiber.join(b);
    expect(admission.active()).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("gives an interrupted waiter's place, and an interrupted job's slot, to the next", () =>
  Effect.gen(function* () {
    const admission = makeAdmission<string>(Effect.succeed(1));
    const hold = yield* Deferred.make<void>();
    const first = yield* admission.inTurn("first", Deferred.await(hold)).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    const waiter = yield* admission
      .inTurn("waiter", Effect.die("an interrupted waiter ran"))
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(waiter);
    // Interrupted while it runs: its slot goes back.
    yield* Fiber.interrupt(first);
    expect(admission.active()).toBe(0);
    let ran = false;
    yield* admission.inTurn(
      "next",
      Effect.sync(() => {
        ran = true;
      }),
    );
    expect(ran).toBe(true);
    // Work already under way takes a slot at once, over the cap, and frees it as it ends.
    const held = yield* admission.takeSlot(Effect.void);
    expect(admission.active()).toBe(1);
    yield* held;
    expect(admission.active()).toBe(0);
  }).pipe(Effect.scoped),
);
