import { describe, expect, it } from "@effect/vitest";
import { HostId, HostUnavailable, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  DRAFT_PRE_WAKE_AGAIN_MS,
  makeDraftPreWake,
  makeMachinePreWake,
  type MachinePreWakeShape,
} from "./pre-wake.ts";
import { makeStopMarks } from "./stop-marks.ts";

// A stopped machine is asked for ahead of work that is coming to it (a scheduled wake, a draft
// being typed), so whoever runs it starts it before the work is due. A machine asked for early is
// let go once it is back, so it is stopped when idle like any other.

const ID = HostId.make("m-one");
const THREAD = ThreadId.make("t-one");

const setup = (options: { embedding?: boolean; local?: boolean; confirmed?: boolean } = {}) => {
  let online = false;
  const stops = makeStopMarks();
  const thread = {
    id: THREAD,
    checkout: { path: "/work", ...(options.local === true ? {} : { hostId: ID }) },
  };
  return Effect.map(
    makeMachinePreWake({
      remote: {
        machines: {
          get: () => (options.confirmed === false ? { name: "w" } : { name: "w", confirmedAt: 1 }),
        } as never,
        connection: (id: HostId) =>
          online
            ? Effect.succeed({} as never)
            : Effect.fail(new HostUnavailable({ hostId: id, message: "away" })),
        stops,
      },
      store: {
        getThread: () => Effect.succeed(thread as never),
        getSettings: Effect.succeed({
          experimental: { embedding: options.embedding ?? true },
        } as never),
      },
    }),
    (preWake) => ({ preWake, stops, back: () => (online = true) }),
  );
};

describe("a machine asked for ahead of its work", () => {
  it.effect("is wanted until it is back, then let go", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { preWake, stops, back } = yield* setup();
        yield* preWake.ahead(THREAD, 120_000, "wake");
        yield* TestClock.adjust("1 second");
        expect(stops.wanted(ID)).toBe(true);
        back();
        yield* TestClock.adjust("2 seconds");
        expect(stops.wanted(ID)).toBe(false);
      }),
    ),
  );

  it.effect("is let go when it isn't back by the time asked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { preWake, stops } = yield* setup();
        yield* preWake.ahead(THREAD, 30_000, "draft");
        yield* TestClock.adjust("10 seconds");
        expect(stops.wanted(ID)).toBe(true);
        yield* TestClock.adjust("25 seconds");
        expect(stops.wanted(ID)).toBe(false);
      }),
    ),
  );

  it.effect("asks nothing of a machine that is there", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { preWake, stops, back } = yield* setup();
        back();
        yield* preWake.ahead(THREAD, 120_000, "wake");
        yield* TestClock.adjust("1 second");
        expect(stops.wantedSince(ID)).toBeUndefined();
      }),
    ),
  );

  it.effect("asks nothing with the hosted features off, or of this machine or one not joined", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const options of [{ embedding: false }, { local: true }, { confirmed: false }]) {
          const { preWake, stops } = yield* setup(options);
          yield* preWake.ahead(THREAD, 120_000, "wake");
          yield* TestClock.adjust("1 second");
          expect(stops.wantedSince(ID)).toBeUndefined();
        }
      }),
    ),
  );
});

const recorder = () => {
  const asked: Array<{ threadId: string; until: number }> = [];
  const preWake: MachinePreWakeShape = {
    ahead: (threadId, until) => Effect.sync(() => void asked.push({ threadId, until })),
  };
  return { asked, preWake };
};

describe("a draft asking for its thread's machine", () => {
  it.effect("asks once a new draft is being typed, in either order", () =>
    Effect.gen(function* () {
      const { asked, preWake } = recorder();
      const drafting = yield* makeDraftPreWake(preWake);
      yield* drafting.drafts("w1", []);
      yield* drafting.drafts("w1", [THREAD]);
      expect(asked).toEqual([]);
      yield* TestClock.adjust("1 second");
      yield* drafting.typed;
      expect(asked.map((each) => each.threadId)).toEqual([THREAD]);

      const other = ThreadId.make("t-two");
      yield* drafting.typed;
      yield* drafting.drafts("w1", [THREAD, other]);
      expect(asked.map((each) => each.threadId)).toEqual([THREAD, other]);
    }),
  );

  it.effect("asks nothing for drafts a window brings back without typing", () =>
    Effect.gen(function* () {
      const { asked, preWake } = recorder();
      const drafting = yield* makeDraftPreWake(preWake);
      yield* drafting.drafts("w1", [THREAD]);
      yield* TestClock.adjust("1 minute");
      yield* drafting.typed;
      expect(asked).toEqual([]);
    }),
  );

  it.effect("asks again for one thread only after a while", () =>
    Effect.gen(function* () {
      const { asked, preWake } = recorder();
      const drafting = yield* makeDraftPreWake(preWake);
      const draftAgain = Effect.gen(function* () {
        yield* drafting.typed;
        yield* drafting.drafts("w1", [THREAD]);
        yield* drafting.drafts("w1", []);
      });
      yield* draftAgain;
      yield* TestClock.adjust("1 minute");
      yield* draftAgain;
      expect(asked).toHaveLength(1);
      yield* TestClock.adjust(DRAFT_PRE_WAKE_AGAIN_MS);
      yield* draftAgain;
      expect(asked).toHaveLength(2);
    }),
  );
});
