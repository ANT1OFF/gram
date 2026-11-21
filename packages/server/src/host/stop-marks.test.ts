import { HostId, LOCAL_HOST_ID, type Thread, ThreadId } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import {
  EXPECT_FOR_MS,
  KEPT_FOLDERS_MAX,
  MarksNotKept,
  RESUME_STALL_MS,
  folderOwedResume,
  type MachineMarksByHost,
  makeStopMarks,
} from "./stop-marks.ts";

const machine = HostId.make("m-one");
const other = HostId.make("m-two");
const thread = (id: string) => ThreadId.make(id);
/** Reopens the machine's threads at rest as a resume does, each one acknowledged: the list. */
const takeRested = (marks: ReturnType<typeof makeStopMarks>, id = machine) => {
  const generation = marks.resumeStarted(id);
  const threads = [...marks.restedOf(id)];
  for (const threadId of threads) marks.restedDone(id, threadId, generation);
  marks.resumed(id, generation, false);
  return threads;
};
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

  it("owes a resume until one completes, and tells when threads may open", () => {
    let at = 0;
    const marks = makeStopMarks(() => at);
    const ready: Array<string> = [];
    marks.onReady((id) => ready.push(id));
    marks.expect(machine);
    marks.back(machine);
    const one = marks.resumeStarted(machine);
    const two = marks.resumeStarted(machine);
    marks.threadBack(machine, thread("a"));
    marks.threadBack(machine, thread("a"));
    expect(ready).toEqual(["m-one"]);
    // One of two ends without going through every folder: still owed.
    marks.resumed(machine, one, false);
    at = 60 * 60_000;
    marks.progress(machine);
    expect(marks.resuming(machine)).toBe(true);
    expect(marks.resumeRunning(machine)).toBe(true);
    // The other went through every folder: the machine owes nothing.
    marks.resumed(machine, two, true);
    expect(marks.resuming(machine)).toBe(false);
    expect(marks.resumeRunning(machine)).toBe(false);
    expect(marks.stalled(machine)).toBeUndefined();
    expect(ready).toEqual(["m-one", "m-one"]);
  });

  it("hands the rested threads out once, across stops, and keeps them when the machine is back", () => {
    const marks = makeStopMarks();
    marks.stopped(machine, [thread("a"), thread("b")]);
    marks.stopped(machine, [thread("b"), thread("c")]);
    marks.back(machine);
    expect(takeRested(marks)).toEqual([thread("a"), thread("b"), thread("c")]);
    expect(takeRested(marks)).toEqual([]);
    // A stop after the machine was back starts over: what an unasked resume left isn't carried.
    marks.stopped(machine, [thread("a")]);
    marks.back(machine);
    marks.stopped(machine, [thread("d")]);
    expect(takeRested(marks)).toEqual([thread("d")]);
  });

  it("a stop taken back leaves nothing, and is counted", () => {
    const marks = makeStopMarks();
    marks.stopped(machine, [thread("a")]);
    expect(marks.cancels(machine)).toBe(0);
    marks.cancel(machine);
    expect(marks.cancels(machine)).toBe(1);
    expect(marks.stoppedAt(machine)).toBeUndefined();
    expect(marks.recently(machine)).toBe(false);
    expect(takeRested(marks)).toEqual([]);
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
    expect(takeRested(marks)).toEqual([]);
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
    expect(takeRested(marks)).toEqual([thread("a")]);
  });

  it("forgets a removed machine", () => {
    const marks = makeStopMarks();
    marks.stopped(machine, [thread("a")]);
    marks.forget(machine);
    expect(marks.stoppedAt(machine)).toBeUndefined();
    expect(takeRested(marks)).toEqual([]);
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
      expect(marks.arrive(machine, {})).toEqual({ kind: "unknown" });
      expect(marks.disk(machine)).toBeUndefined();
      expect(marks.arrive(machine, disk("aaaaaaaa"))).toEqual({ kind: "first" });
      expect(marks.arrive(machine, disk("aaaaaaaa"))).toEqual({ kind: "redial" });
      expect(marks.arrive(machine, disk("aaaaaaaa", "boot-cccccccc"))).toEqual({
        kind: "restarted",
      });
      expect(marks.resuming(machine)).toBe(false);
      expect(marks.arrive(machine, disk("bbbbbbbb"))).toEqual({
        kind: "replaced",
        was: "disk-aaaaaaaa",
      });
      expect(marks.disk(machine)).toBe("disk-bbbbbbbb");
      // A host that says no disk changes nothing remembered.
      expect(marks.arrive(machine, {})).toEqual({ kind: "unknown" });
      expect(marks.disk(machine)).toBe("disk-bbbbbbbb");
      expect(marks.arrive(other, disk("aaaaaaaa"))).toEqual({ kind: "first" });
    });

    it("owes a machine back on a new disk a resume, though no stop of it was seen", () => {
      const marks = makeStopMarks();
      marks.arrive(machine, disk("aaaaaaaa"));
      marks.back(machine);
      expect(marks.resuming(machine)).toBe(false);
      marks.arrive(machine, disk("bbbbbbbb"));
      marks.back(machine);
      expect(marks.resuming(machine)).toBe(true);
      expect(marks.owes(machine)).toBe(true);
    });

    it("drops what a resume of the disk before says, once the machine is on another", () => {
      const marks = makeStopMarks();
      marks.arrive(machine, disk("aaaaaaaa"));
      marks.expect(machine);
      marks.back(machine);
      const before = marks.resumeStarted(machine);
      // Replaced while that resume ran: what it finds on the old disk isn't the new one's.
      marks.arrive(machine, disk("bbbbbbbb"));
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
      // Two at once: one that goes through every folder settles it, the other still running.
      const one = marks.resumeStarted(machine);
      marks.resumeStarted(machine);
      marks.resumed(machine, one, true);
      expect(marks.owes(machine)).toBe(false);
    });

    it("a stall is said, and the gate stays shut until a resume completes", () => {
      let at = 0;
      const marks = makeStopMarks(() => at);
      marks.expect(machine);
      marks.back(machine);
      at = RESUME_STALL_MS;
      expect(marks.resuming(machine)).toBe(true);
      expect(marks.stalled(machine)).toBe(RESUME_STALL_MS);
      // A resume started after it clears the stall; one that doesn't complete leaves it owed.
      const failed = marks.resumeStarted(machine);
      expect(marks.stalled(machine)).toBeUndefined();
      marks.resumed(machine, failed, false);
      expect(marks.resuming(machine)).toBe(true);
      const generation = marks.resumeStarted(machine);
      marks.resumed(machine, generation, true);
      expect(marks.resuming(machine)).toBe(false);
      expect(marks.stalled(machine)).toBeUndefined();
    });

    it("keeps a resume owed when the stop is taken back", () => {
      const marks = makeStopMarks();
      marks.arrive(machine, disk("aaaaaaaa"));
      marks.arrive(machine, disk("bbbbbbbb"));
      marks.back(machine);
      marks.cancel(machine);
      expect(marks.resuming(machine)).toBe(true);
    });

    it("refuses a disk the machine was replaced from, or leaves, changing nothing", () => {
      let at = 0;
      const marks = makeStopMarks(() => at);
      marks.arrive(machine, disk("aaaaaaaa"));
      marks.arrive(machine, disk("bbbbbbbb"));
      const generation = marks.resumeStarted(machine);
      // The old host, cut off and dialling in again with the machine's key. Before, it was taken
      // as the machine replaced afresh: its disk the machine's, the replacement's resume voided.
      expect(marks.arrive(machine, disk("aaaaaaaa"))).toEqual({ kind: "fenced", why: "replaced" });
      expect(marks.disk(machine)).toBe("disk-bbbbbbbb");
      expect(marks.isCurrent(machine, generation)).toBe(true);
      // Told the machine comes back on another disk: the host of the one it leaves isn't it,
      // until the word runs out.
      marks.expect(machine);
      expect(marks.arrive(machine, disk("bbbbbbbb", "boot-cccccccc"))).toEqual({
        kind: "fenced",
        why: "expected",
      });
      at += EXPECT_FOR_MS;
      expect(marks.arrive(machine, disk("bbbbbbbb", "boot-cccccccc")).kind).toBe("restarted");
      // Removed and joined again: its disk history starts over.
      marks.forget(machine);
      expect(marks.arrive(machine, disk("aaaaaaaa"))).toEqual({ kind: "first" });
    });

    it("lets the disk it last refused back in once told to, as the machine replaced again", () => {
      let at = 0;
      const marks = makeStopMarks(() => at);
      marks.arrive(machine, disk("aaaaaaaa"));
      marks.arrive(machine, disk("bbbbbbbb"));
      marks.resumed(machine, marks.resumeStarted(machine), true);
      expect(marks.owes(machine)).toBe(false);
      // Nothing refused yet: nothing to let in.
      expect(marks.readmit(machine)).toBeUndefined();
      expect(marks.arrive(machine, disk("aaaaaaaa")).kind).toBe("fenced");
      // A host nobody can give a new disk id: let back from this side, keeping the machine.
      expect(marks.readmit(machine)).toBe("disk-aaaaaaaa");
      expect(marks.arrive(machine, disk("aaaaaaaa"))).toEqual({
        kind: "replaced",
        was: "disk-bbbbbbbb",
      });
      expect(marks.owes(machine)).toBe(true);
      expect(marks.onOtherDisk(machine)).toBe(true);
      // Once, and that disk alone: the one it took over from is fenced now.
      expect(marks.arrive(machine, disk("bbbbbbbb")).kind).toBe("fenced");
      // Told so and not taken up in time: fenced again.
      expect(marks.readmit(machine)).toBe("disk-bbbbbbbb");
      at += EXPECT_FOR_MS;
      expect(marks.arrive(machine, disk("bbbbbbbb")).kind).toBe("fenced");
      // The leaving disk under an `expect` is let back the same way, as it is.
      marks.expect(machine);
      expect(marks.arrive(machine, disk("aaaaaaaa", "boot-dddddddd")).kind).toBe("fenced");
      expect(marks.readmit(machine)).toBe("disk-aaaaaaaa");
      expect(marks.arrive(machine, disk("aaaaaaaa", "boot-dddddddd")).kind).toBe("restarted");
    });

    it("remembers the disks a machine was replaced from", () => {
      let kept: MachineMarksByHost = {};
      const marks = makeStopMarks(undefined, undefined, undefined, undefined, {
        initial: {},
        save: (all) => {
          kept = structuredClone(all);
        },
      });
      for (const each of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) marks.arrive(machine, disk(each));
      expect(kept[machine]?.retired).toEqual(["disk-aaaaaaaa", "disk-bbbbbbbb"]);
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
      before.arrive(machine, disk("aaaaaaaa"));
      before.stopped(machine, [thread("a"), thread("b")]);
      before.away(machine);
      before.keep(machine, thread("a"), "/w/a", {
        commit: "c1",
        caughtUp: false,
        saved: { files: [], uncommitted: false },
      });
      before.arrive(machine, disk("bbbbbbbb"));
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
      expect(takeRested(after)).toEqual([thread("a"), thread("b")]);
      expect(after.disk(machine)).toBe("disk-bbbbbbbb");
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

    it("keeps the disk and what is owed in one write, and refuses an arrival it can't write", () => {
      const writes: Array<MachineMarksByHost> = [];
      let failing = false;
      const marks = makeStopMarks(undefined, undefined, undefined, undefined, {
        initial: {},
        save: (all) => {
          if (failing) throw new Error("disk full");
          writes.push(structuredClone(all));
        },
      });
      marks.arrive(machine, disk("aaaaaaaa"));
      writes.length = 0;
      failing = true;
      // Not written: the host isn't let in, and nothing of it is taken as so.
      expect(() => marks.arrive(machine, disk("bbbbbbbb"))).toThrow(MarksNotKept);
      expect(marks.disk(machine)).toBe("disk-aaaaaaaa");
      expect(marks.owes(machine)).toBe(false);
      failing = false;
      expect(marks.arrive(machine, disk("bbbbbbbb"))).toMatchObject({ kind: "replaced" });
      // One write: never a record with the new disk and without the debt.
      expect(writes).toHaveLength(1);
      expect(writes[0]?.[machine]).toMatchObject({ disk: { id: "disk-bbbbbbbb" }, owed: {} });
    });

    it("lifts a debt only once that is written; what adds caution holds meanwhile", () => {
      let failing = false;
      const marks = makeStopMarks(undefined, undefined, undefined, undefined, {
        initial: {},
        save: () => {
          if (failing) throw new Error("disk full");
        },
      });
      marks.arrive(machine, disk("aaaaaaaa"));
      marks.arrive(machine, disk("bbbbbbbb"));
      const generation = marks.resumeStarted(machine);
      failing = true;
      expect(() => marks.threadBack(machine, thread("a"), generation)).toThrow(MarksNotKept);
      expect(marks.isThreadBack(machine, thread("a"))).toBe(false);
      marks.resumed(machine, generation, true);
      expect(marks.owes(machine)).toBe(true);
      marks.stopped(other, [thread("b")]);
      expect(marks.holding(other)).toBe(true);
      expect(() => marks.cancel(other)).toThrow(MarksNotKept);
      expect(marks.holding(other)).toBe(true);
    });

    it("keeps writing other machines when one machine's record can't be written", () => {
      let kept: MachineMarksByHost = {};
      const marks = makeStopMarks(undefined, undefined, undefined, undefined, {
        initial: {},
        save: (all) => {
          if (all[machine]?.blocks?.[thread("poison")] !== undefined)
            throw new Error("The machines' marks don't fit in machine-marks.json.");
          kept = structuredClone(all);
        },
      });
      marks.arrive(machine, disk("aaaaaaaa"));
      marks.arrive(machine, disk("bbbbbbbb"));
      const poisoned = marks.resumeStarted(machine);
      marks.block(machine, thread("poison"), "Too big to keep.", poisoned);
      expect(marks.blocked(machine, thread("poison"))).toBe("Too big to keep.");

      marks.arrive(other, disk("cccccccc"));
      marks.arrive(other, disk("dddddddd"));
      const generation = marks.resumeStarted(other);
      marks.folderOwed(other, "/w/b", generation);
      marks.threadBack(other, thread("b"), generation);
      marks.folderDone(other, "/w/b", generation);
      marks.resumed(other, generation, true);
      expect(marks.owes(other)).toBe(false);
      expect(kept[other]?.disk?.id).toBe("disk-dddddddd");
      expect(kept[machine]?.blocks).toBeUndefined();
    });

    it("lets a resume of the new disk run once one of the old disk's ends", () => {
      const marks = makeStopMarks();
      marks.arrive(machine, disk("aaaaaaaa"));
      marks.arrive(machine, disk("bbbbbbbb"));
      const old = marks.resumeStarted(machine);
      marks.arrive(machine, disk("cccccccc"));
      // Before, its end kept counting as running, and nothing resumed the new disk again.
      marks.resumed(machine, old, false);
      expect(marks.resumeRunning(machine)).toBe(false);
      expect(marks.resuming(machine)).toBe(true);
    });

    it("owes a resume at each start of a disk the host can't say is the same", () => {
      const marks = makeStopMarks();
      expect(marks.arrive(machine, { ...disk("aaaaaaaa"), diskUnknown: true })).toEqual({
        kind: "first",
      });
      expect(marks.resuming(machine)).toBe(true);
      marks.settle(machine, marks.resumeStarted(machine));
      marks.arrive(machine, { ...disk("aaaaaaaa", "boot-bbbbbbbb"), diskUnknown: true });
      expect(marks.resuming(machine)).toBe(true);
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
