import { HostId, ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import { makeStopMarks } from "./stop-marks.ts";

const machine = HostId.make("m-one");
const other = HostId.make("m-two");
const thread = (id: string) => ThreadId.make(id);

describe("stop marks", () => {
  it("a machine is stopped from its stop until it is back", () => {
    let at = 10;
    const marks = makeStopMarks(() => at);
    expect(marks.stoppedAt(machine)).toBeUndefined();
    marks.stopped(machine, []);
    at = 20;
    expect(marks.stoppedAt(machine)).toBe(10);
    expect(marks.stoppedAt(other)).toBeUndefined();
    marks.back(machine);
    expect(marks.stoppedAt(machine)).toBeUndefined();
  });

  it("hands the rested threads out once, across stops, and keeps them when the machine is back", () => {
    const marks = makeStopMarks();
    marks.stopped(machine, [thread("a"), thread("b")]);
    marks.stopped(machine, [thread("b"), thread("c")]);
    marks.back(machine);
    expect(marks.takeRested(machine)).toEqual([thread("a"), thread("b"), thread("c")]);
    expect(marks.takeRested(machine)).toEqual([]);
  });

  it("a stop taken back leaves nothing, and is counted", () => {
    const marks = makeStopMarks();
    marks.stopped(machine, [thread("a")]);
    expect(marks.cancels(machine)).toBe(0);
    marks.cancel(machine);
    expect(marks.cancels(machine)).toBe(1);
    expect(marks.stoppedAt(machine)).toBeUndefined();
    expect(marks.recently(machine)).toBe(false);
    expect(marks.takeRested(machine)).toEqual([]);
  });

  it("a readied machine holds while it is there, and wasn't stopped once its hold ran out", () => {
    let at = 0;
    const marks = makeStopMarks(() => at, 100);
    marks.stopped(machine, [thread("a")]);
    expect(marks.holding(machine)).toBe(true);
    at = 99;
    expect(marks.holding(machine)).toBe(true);
    at = 100;
    expect(marks.holding(machine)).toBe(false);
    expect(marks.stoppedAt(machine)).toBeUndefined();
    expect(marks.takeRested(machine)).toEqual([]);
    // Its sessions are still waited for as a stopped machine's for a while.
    expect(marks.recently(machine)).toBe(true);
  });

  it("a readied machine that went away stays stopped until it dials in", () => {
    let at = 0;
    const marks = makeStopMarks(() => at, 100);
    marks.stopped(machine, [thread("a")]);
    marks.away(machine);
    expect(marks.holding(machine)).toBe(false);
    at = 10_000;
    expect(marks.stoppedAt(machine)).toBe(0);
    marks.back(machine);
    expect(marks.stoppedAt(machine)).toBeUndefined();
    expect(marks.takeRested(machine)).toEqual([thread("a")]);
  });

  it("forgets a removed machine", () => {
    const marks = makeStopMarks();
    marks.stopped(machine, [thread("a")]);
    marks.forget(machine);
    expect(marks.stoppedAt(machine)).toBeUndefined();
    expect(marks.takeRested(machine)).toEqual([]);
  });

  it("a machine is wanted while anything waits on it, however the wait ends", async () => {
    const marks = makeStopMarks();
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const second = yield* Deferred.make<void>();
        const one = yield* Effect.forkScoped(marks.wanting(machine, Deferred.await(first)));
        const two = yield* Effect.forkScoped(marks.wanting(machine, Deferred.await(second)));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(marks.wanted(machine)).toBe(true);
        expect(marks.wanted(other)).toBe(false);
        yield* Deferred.succeed(first, undefined);
        yield* Fiber.join(one);
        expect(marks.wanted(machine)).toBe(true);
        yield* Fiber.interrupt(two);
        expect(marks.wanted(machine)).toBe(false);
      }).pipe(Effect.scoped),
    );
  });
});
