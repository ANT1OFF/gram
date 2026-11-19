import { HostId, LOCAL_HOST_ID, type Thread, ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import { folderOwedResume, makeStopMarks } from "./stop-marks.ts";

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
    // A stop after the machine was back starts over: what an unasked resume left isn't carried.
    marks.stopped(machine, [thread("a")]);
    marks.back(machine);
    marks.stopped(machine, [thread("d")]);
    expect(marks.takeRested(machine)).toEqual([thread("d")]);
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

  it("says since when a machine is wanted, and tells when that starts and ends", async () => {
    let at = 100;
    const told: string[] = [];
    const marks = makeStopMarks(
      () => at,
      undefined,
      (id) => told.push(id),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const one = yield* Effect.forkScoped(marks.wanting(machine, Deferred.await(first)));
        yield* Effect.yieldNow;
        at = 150;
        const two = yield* Effect.forkScoped(marks.wanting(machine, Effect.void));
        yield* Fiber.join(two);
        // The first wait's start stands while any wait does, and only the first and last tell.
        expect(marks.wantedSince(machine)).toBe(100);
        expect(told).toEqual(["m-one"]);
        yield* Deferred.succeed(first, undefined);
        yield* Fiber.join(one);
        expect(marks.wantedSince(machine)).toBeUndefined();
        expect(told).toEqual(["m-one", "m-one"]);
      }).pipe(Effect.scoped),
    );
  });

  it("a thread's missing folder is owed by its machine's resume until its folders are back", () => {
    const on = (id: string, hostId: HostId) =>
      ({
        id: thread(id),
        checkout: { kind: "worktree", path: `/w/${id}`, branch: id, hostId },
      }) as unknown as Thread;
    const marks = makeStopMarks();
    // Lost and back with no stop and no word of a new disk: a missing folder is just missing.
    marks.away(machine);
    marks.back(machine);
    expect(folderOwedResume(marks, on("a", machine))).toBe(false);
    // Told it comes back on a new disk: until the resume, its threads' folders are on their way.
    marks.expect(machine);
    marks.back(machine);
    expect(folderOwedResume(marks, on("a", machine))).toBe(true);
    expect(folderOwedResume(marks, on("b", machine))).toBe(true);
    expect(folderOwedResume(marks, on("a", other))).toBe(false);
    expect(folderOwedResume(marks, on("a", HostId.make(LOCAL_HOST_ID)))).toBe(false);
    marks.threadBack(machine, thread("a"));
    expect(folderOwedResume(marks, on("a", machine))).toBe(false);
    expect(folderOwedResume(marks, on("b", machine))).toBe(true);
    marks.resumed(machine);
    expect(folderOwedResume(marks, on("b", machine))).toBe(false);
  });
});
