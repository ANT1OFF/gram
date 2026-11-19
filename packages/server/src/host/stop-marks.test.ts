import { HostId, LOCAL_HOST_ID, type Thread, ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import {
  EXPECT_FOR_MS,
  KEPT_FOLDERS_MAX,
  RESUME_STALL_MS,
  folderOwedResume,
  type MachineMarksByHost,
  makeStopMarks,
} from "./stop-marks.ts";

const machine = HostId.make("m-one");
const other = HostId.make("m-two");
const thread = (id: string) => ThreadId.make(id);
/** What a host says of its disk `id`, and of its start. */
const disk = (id: string, boot = `boot-${id}`) => ({ diskId: `disk-${id}`, bootId: boot });

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

  it("owes a resume until the last one running ends, and tells when threads may open", () => {
    let at = 0;
    const marks = makeStopMarks(() => at);
    const ready: Array<string> = [];
    marks.onReady((id) => ready.push(id));
    marks.expect(machine);
    marks.back(machine);
    marks.resumeStarted(machine);
    marks.resumeStarted(machine);
    marks.threadBack(machine, thread("a"));
    marks.threadBack(machine, thread("a"));
    expect(ready).toEqual(["m-one"]);
    // One of two ends: the other still puts folders back.
    marks.resumed(machine);
    at = 60 * 60_000;
    marks.progress(machine);
    expect(marks.resuming(machine)).toBe(true);
    marks.resumed(machine);
    expect(marks.resuming(machine)).toBe(false);
    expect(marks.stalled(machine)).toBeUndefined();
    expect(ready).toEqual(["m-one", "m-one"]);
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

  describe("the disk a machine's host says it is on", () => {
    it("tells a redial, a restart and a replacement apart", () => {
      const marks = makeStopMarks();
      expect(marks.hello(machine, {})).toEqual({ kind: "unknown" });
      expect(marks.disk(machine)).toBeUndefined();
      expect(marks.hello(machine, disk("aaaaaaaa"))).toEqual({ kind: "first" });
      expect(marks.hello(machine, disk("aaaaaaaa"))).toEqual({ kind: "redial" });
      expect(marks.hello(machine, disk("aaaaaaaa", "boot-cccccccc"))).toEqual({
        kind: "restarted",
      });
      expect(marks.resuming(machine)).toBe(false);
      expect(marks.hello(machine, disk("bbbbbbbb"))).toEqual({
        kind: "replaced",
        was: "disk-aaaaaaaa",
      });
      expect(marks.disk(machine)).toBe("disk-bbbbbbbb");
      // A host that says no disk changes nothing remembered.
      expect(marks.hello(machine, {})).toEqual({ kind: "unknown" });
      expect(marks.disk(machine)).toBe("disk-bbbbbbbb");
      expect(marks.hello(other, disk("aaaaaaaa"))).toEqual({ kind: "first" });
    });

    it("fences the disk a machine was replaced from, and the one it was told it leaves", () => {
      let at = 0;
      const marks = makeStopMarks(() => at);
      marks.hello(machine, disk("aaaaaaaa"));
      marks.hello(machine, disk("bbbbbbbb"));
      expect(marks.hello(machine, disk("aaaaaaaa"))).toEqual({ kind: "fenced", why: "replaced" });
      // Refused, it changes nothing: the new disk is still the machine's.
      expect(marks.disk(machine)).toBe("disk-bbbbbbbb");
      expect(marks.hello(machine, disk("bbbbbbbb"))).toEqual({ kind: "redial" });
      marks.expect(machine);
      expect(marks.hello(machine, disk("bbbbbbbb", "boot-dddddddd"))).toEqual({
        kind: "fenced",
        why: "expected",
      });
      expect(marks.hello(machine, disk("cccccccc"))).toMatchObject({ kind: "replaced" });
      // Once the word has run out, the disk is its own again.
      const later = makeStopMarks(() => at);
      later.hello(machine, disk("aaaaaaaa"));
      later.expect(machine);
      at = EXPECT_FOR_MS;
      expect(later.hello(machine, disk("aaaaaaaa", "boot-dddddddd"))).toEqual({
        kind: "restarted",
      });
      // A machine removed and joined again starts over.
      marks.forget(machine);
      expect(marks.hello(machine, disk("aaaaaaaa"))).toEqual({ kind: "first" });
    });

    it("owes a machine back on a new disk a resume, though no stop of it was seen", () => {
      const marks = makeStopMarks();
      marks.hello(machine, disk("aaaaaaaa"));
      marks.back(machine);
      expect(marks.resuming(machine)).toBe(false);
      marks.hello(machine, disk("bbbbbbbb"));
      marks.back(machine);
      expect(marks.resuming(machine)).toBe(true);
      expect(marks.owes(machine)).toBe(true);
    });

    it("drops what a resume of the disk before says, once the machine is on another", () => {
      const marks = makeStopMarks();
      marks.hello(machine, disk("aaaaaaaa"));
      marks.expect(machine);
      marks.back(machine);
      const before = marks.resumeStarted(machine);
      // Replaced while that resume ran: what it finds on the old disk isn't the new one's.
      marks.hello(machine, disk("bbbbbbbb"));
      marks.back(machine);
      marks.threadBack(machine, thread("a"), before);
      marks.block(machine, thread("b"), "Its folder is gone.", before);
      marks.resumed(machine, before, true);
      expect(marks.isThreadBack(machine, thread("a"))).toBe(false);
      expect(marks.blocked(machine, thread("b"))).toBeUndefined();
      expect(marks.resuming(machine)).toBe(true);
      // The new disk's own resume settles it.
      const now = marks.resumeStarted(machine);
      expect(now).not.toBe(before);
      marks.resumed(machine, now, true);
      expect(marks.owes(machine)).toBe(false);
    });

    it("keeps a resume owed when one ends without completing", () => {
      const marks = makeStopMarks();
      marks.expect(machine);
      marks.back(machine);
      const generation = marks.resumeStarted(machine);
      marks.resumed(machine, generation, false);
      expect(marks.resuming(machine)).toBe(true);
      expect(marks.resumeRunning(machine)).toBe(false);
      // Two at once: one that completes settles it only once the other ends too.
      const one = marks.resumeStarted(machine);
      const two = marks.resumeStarted(machine);
      marks.resumed(machine, one, true);
      expect(marks.owes(machine)).toBe(true);
      marks.resumed(machine, two, false);
      expect(marks.owes(machine)).toBe(false);
    });

    it("a stall opens the gate to later sessions but leaves the resume owed", () => {
      let at = 0;
      const marks = makeStopMarks(() => at);
      marks.expect(machine);
      marks.back(machine);
      at = RESUME_STALL_MS;
      expect(marks.resuming(machine)).toBe(false);
      expect(marks.stalled(machine)).toBe(RESUME_STALL_MS);
      expect(marks.owes(machine)).toBe(true);
      // A resume started after it closes the gate again, until it completes.
      const generation = marks.resumeStarted(machine);
      expect(marks.resuming(machine)).toBe(true);
      marks.resumed(machine, generation, true);
      expect(marks.owes(machine)).toBe(false);
    });

    it("keeps what a machine is owed across a restart of this Gram, but not the diff", () => {
      let kept: MachineMarksByHost = {};
      const persisted = () => ({
        initial: kept,
        save: (all: MachineMarksByHost) => {
          kept = structuredClone(all);
        },
      });
      let at = 0;
      const before = makeStopMarks(() => at, undefined, undefined, undefined, persisted());
      before.hello(machine, disk("aaaaaaaa"));
      before.stopped(machine, [thread("a"), thread("b")]);
      before.away(machine);
      before.keep(machine, thread("a"), "/w/a", {
        commit: "c1",
        caughtUp: false,
        saved: { files: [], uncommitted: false },
      });
      before.hello(machine, disk("bbbbbbbb"));
      before.back(machine);
      const generation = before.resumeStarted(machine);
      before.threadBack(machine, thread("a"), generation);
      before.block(machine, thread("b"), "Its folder is gone.", generation);
      before.expect(other);
      // An `expect` made before a short restart still holds after it.
      const early = makeStopMarks(() => 1000, undefined, undefined, undefined, persisted());
      early.back(other);
      expect(early.resuming(other)).toBe(true);

      // Down far longer than a stall: that isn't time the resume made no progress in.
      at = 10 * RESUME_STALL_MS;
      const after = makeStopMarks(() => at, undefined, undefined, undefined, persisted());
      expect(after.resuming(machine)).toBe(true);
      expect(after.resumeRunning(machine)).toBe(false);
      expect(after.isThreadBack(machine, thread("a"))).toBe(true);
      expect(after.blocked(machine, thread("b"))).toBe("Its folder is gone.");
      expect(after.keptOf(machine, thread("a"), "/w/a")).toEqual({ commit: "c1", caughtUp: false });
      expect(after.takeRested(machine)).toEqual([thread("a"), thread("b")]);
      expect(after.disk(machine)).toBe("disk-bbbbbbbb");
      expect(after.hello(machine, disk("aaaaaaaa"))).toEqual({ kind: "fenced", why: "replaced" });
      // A late result of the resume from before the restart doesn't settle the one owed now.
      after.resumed(machine, generation - 1, true);
      expect(after.owes(machine)).toBe(true);
      const now = after.resumeStarted(machine);
      after.resumed(machine, now, true);
      const again = makeStopMarks(() => at, undefined, undefined, undefined, persisted());
      expect(again.resuming(machine)).toBe(false);
      again.forget(machine);
      again.forget(other);
      expect(kept).toEqual({});
    });

    it("keeps the disk and what is owed in one write, and tries a failed one again", () => {
      const writes: Array<MachineMarksByHost> = [];
      let failing = false;
      const marks = makeStopMarks(undefined, undefined, undefined, undefined, {
        initial: {},
        save: (all) => {
          if (failing) throw new Error("disk full");
          writes.push(structuredClone(all));
        },
      });
      marks.hello(machine, disk("aaaaaaaa"));
      writes.length = 0;
      failing = true;
      marks.hello(machine, disk("bbbbbbbb"));
      marks.back(machine);
      expect(writes).toEqual([]);
      failing = false;
      // The next change of any machine writes what failed too.
      marks.expect(other);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.[machine]).toMatchObject({
        disk: { id: "disk-bbbbbbbb" },
        owed: {},
      });
      // Once kept, the replacement was one write: no state with the disk and without the debt.
      writes.length = 0;
      marks.hello(machine, disk("cccccccc"));
      expect(writes[0]?.[machine]).toMatchObject({ disk: { id: "disk-cccccccc" }, owed: {} });
    });

    it("keeps only the newest folders' records", () => {
      const marks = makeStopMarks();
      for (let at = 0; at <= KEPT_FOLDERS_MAX; at++)
        marks.keep(machine, thread("a"), `/w/${at}`, { commit: "c", caughtUp: false });
      expect(marks.keptOf(machine, thread("a"), "/w/0")).toBeUndefined();
      expect(marks.keptOf(machine, thread("a"), `/w/${KEPT_FOLDERS_MAX}`)).toBeDefined();
    });
  });
});
