import { describe, expect, it } from "@effect/vitest";
import { HostId, HostUnavailable } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeStopMarks } from "./stop-marks.ts";
import { awaitedMachines, type WorkerHost } from "./worker-host.ts";

// A session about to open on a joined machine that was stopped and started on another disk waits
// for the machine's threads to be resumed: until then its folder may not be there.

const ID = HostId.make("m-one");
const HOST = { id: ID } as unknown as WorkerHost;

const setup = () => {
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
    { getSettings: Effect.succeed({ experimental: { embedding: true } } as never) },
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

  it.effect("opens at once on a machine that was only readied and taken back", () =>
    Effect.gen(function* () {
      const { stops, forSession } = setup();
      stops.stopped(ID, []);
      stops.back(ID);
      expect(yield* forSession(ID)).toBe(HOST);
    }),
  );
});
