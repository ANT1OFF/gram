import { describe, expect, it } from "@effect/vitest";
import { HostId, HostUnavailable, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeStopMarks, RESUME_STALL_MS } from "./stop-marks.ts";
import { stopStatus } from "./stop-resume.ts";
import { awaitedMachines, type WorkerHost } from "./worker-host.ts";

// A session about to open on a joined machine that was stopped and started on another disk waits
// for the machine's threads to be resumed: until then its folder may not be there.

const ID = HostId.make("m-one");
const HOST = { id: ID } as unknown as WorkerHost;

const setup = (embedding = true) => {
  let online = true;
  const stops = makeStopMarks();
  const get = (id: HostId) =>
    online
      ? Effect.succeed(HOST)
      : Effect.fail(new HostUnavailable({ hostId: id, message: "away" }));
  const forSession = awaitedMachines(
    get,
    {
      machines: { get: () => ({ confirmedAt: 1 }) } as never,
      stops,
    },
    { getSettings: Effect.succeed({ experimental: { embedding } } as never) },
    60_000,
  );
  return { stops, forSession, away: () => (online = false), back: () => (online = true) };
};

describe("a session on a machine started again after a stop", () => {
  it.effect("waits for its threads to be resumed before it opens", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stops, forSession, away, back } = setup();
        stops.stopped(ID, []);
        stops.away(ID);
        away();
        // It dials in again, on another disk: its folders are put back by the resume.
        back();
        stops.back(ID);
        const opening = yield* Effect.forkScoped(forSession(ID));
        yield* TestClock.adjust("5 seconds");
        expect(opening.pollUnsafe()).toBeUndefined();
        stops.resumed(ID);
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(opening)).toBe(HOST);
      }),
    ),
  );

  it.effect("waits too when this Gram never saw the stop but was told the disk is new", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // As after a restart: nothing remembered of the stop, only what the starter said.
        const { stops, forSession } = setup();
        stops.expect(ID);
        stops.back(ID);
        const opening = yield* Effect.forkScoped(forSession(ID));
        yield* TestClock.adjust("5 seconds");
        expect(opening.pollUnsafe()).toBeUndefined();
        stops.resumed(ID);
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(opening)).toBe(HOST);
      }),
    ),
  );

  it.effect("opens a thread's session once its own folders are back, before the rest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stops, forSession } = setup();
        const mine = ThreadId.make("t-mine");
        stops.expect(ID);
        stops.back(ID);
        const opening = yield* Effect.forkScoped(forSession(ID, mine));
        yield* TestClock.adjust("5 seconds");
        expect(opening.pollUnsafe()).toBeUndefined();
        // Its folders go first.
        expect([...stops.awaited(ID)]).toEqual([mine]);
        stops.threadBack(ID, ThreadId.make("t-other"));
        yield* TestClock.adjust("5 seconds");
        expect(opening.pollUnsafe()).toBeUndefined();
        stops.threadBack(ID, mine);
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(opening)).toBe(HOST);
        // Another thread on it still waits for the whole resume.
        expect(stops.resuming(ID)).toBe(true);
      }),
    ),
  );

  it.effect("opens at once on a machine that was only readied and taken back", () =>
    Effect.gen(function* () {
      const { stops, forSession } = setup();
      stops.stopped(ID, []);
      stops.back(ID);
      expect(yield* forSession(ID)).toBe(HOST);
    }),
  );
});

describe("a session on a machine back on another disk, with the hosted features off", () => {
  it.effect("waits for the machine's resume rather than open over folders not put back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stops, forSession, away } = setup(false);
        stops.arrive(ID, { diskId: "disk-aaaaaaaa", bootId: "boot-aaaaaaaa" });
        stops.arrive(ID, { diskId: "disk-bbbbbbbb", bootId: "boot-bbbbbbbb" });
        stops.back(ID);
        const opening = yield* Effect.forkScoped(forSession(ID));
        yield* TestClock.adjust("5 seconds");
        expect(opening.pollUnsafe()).toBeUndefined();
        stops.resumed(ID, stops.resumeStarted(ID), true);
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(opening)).toBe(HOST);
        // A machine that is away isn't waited for, as before.
        away();
        const refused = yield* Effect.flip(forSession(ID));
        expect(refused.message).toBe("away");
      }),
    ),
  );
});

describe("the stop status of a machine back after a stop", () => {
  it.effect("still says it is owed a resume after the sessions waiting on it gave up", () =>
    Effect.gen(function* () {
      let at = 0;
      const stops = makeStopMarks(() => at);
      const deps = {
        hosts: {
          machines: { list: () => [{ id: ID, name: "box", confirmedAt: 1 }] },
          connection: () => Effect.succeed({}),
          stops,
        } as never,
      };
      stops.expect(ID);
      stops.back(ID);
      at = RESUME_STALL_MS;
      expect(stops.resuming(ID)).toBe(true);
      expect(stops.stalled(ID)).toBe(RESUME_STALL_MS);
      expect((yield* stopStatus(deps))[0]).toMatchObject({ resuming: true });
    }),
  );

  it.effect("says it is owed a resume until it has one, however it was started", () =>
    Effect.gen(function* () {
      const stops = makeStopMarks();
      const deps = {
        hosts: {
          machines: { list: () => [{ id: ID, name: "box", confirmedAt: 1 }] },
          connection: () => Effect.succeed({}),
          stops,
        } as never,
      };
      stops.stopped(ID, []);
      stops.away(ID);
      stops.back(ID);
      expect((yield* stopStatus(deps))[0]).toMatchObject({ online: true, resuming: true });
      stops.resumed(ID);
      expect((yield* stopStatus(deps))[0]?.resuming).toBeUndefined();
    }),
  );
});
