import { describe, expect, it } from "@effect/vitest";
import type { ServerEvent, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { UsageLimitReadings } from "./limit-readings.ts";

type UsageLimitEvent = Extract<ServerEvent, { type: "usageLimit" }>;

const HOUR = 3_600_000;
const MINUTE = 60_000;

const reading = (overrides: Partial<UsageLimitEvent> = {}): UsageLimitEvent => ({
  type: "usageLimit",
  threadId: "t-1" as ThreadId,
  agent: "claude",
  status: "allowed",
  window: "five_hour",
  utilization: 0.42,
  resetsAt: 5 * HOUR,
  ...overrides,
});

/** The service over the database at `path`: each run is one server's lifetime. */
const withReadings = <A, E>(
  path: string,
  body: Effect.Effect<A, E, UsageLimitReadings | EventHub>,
) =>
  Effect.scoped(
    body.pipe(
      Effect.provide(
        UsageLimitReadings.layer.pipe(
          Layer.provideMerge(EventHub.layer),
          Layer.provideMerge(ThreadStore.layerSqlite(path)),
          Layer.orDie,
        ),
      ),
    ),
  );

const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-limit-readings-"));
  return { path: join(dir, "gram.db"), done: () => rmSync(dir, { recursive: true, force: true }) };
};

describe("kept limit readings", () => {
  it.effect("snapshot metadata keeps a confirmed exhausted window's reset usable for waits", () =>
    withReadings(
      ":memory:",
      Effect.gen(function* () {
        const readings = yield* UsageLimitReadings;
        yield* readings.record(
          reading({ status: "rejected", window: "seven_day", utilization: 1, resetsAt: 72 * HOUR }),
        );
        const beforeQuery = yield* readings.current;
        yield* readings.replaceSubscription(
          "claude",
          [{ status: "allowed", window: "seven_day", utilization: 1, resetsAt: 72 * HOUR }],
          beforeQuery,
        );
        expect((yield* readings.current)[0]).toMatchObject({
          status: "rejected",
          resetsAt: 72 * HOUR,
          utilization: 1,
        });
        yield* readings.replaceSubscription(
          "claude",
          [{ status: "allowed", window: "seven_day", utilization: 0.2, resetsAt: 72 * HOUR }],
          yield* readings.current,
        );
        expect((yield* readings.current)[0]?.status).toBe("allowed");
      }),
    ),
  );
  it.effect("a slow snapshot cannot overwrite or clear newer stream observations", () =>
    withReadings(
      ":memory:",
      Effect.gen(function* () {
        const readings = yield* UsageLimitReadings;
        yield* readings.record(reading());
        const beforeQuery = yield* readings.current;
        yield* readings.record(reading({ utilization: 0.8 }));
        yield* readings.replaceSubscription(
          "claude",
          [{ window: "five_hour", status: "allowed", utilization: 0.1, resetsAt: 5 * HOUR }],
          beforeQuery,
        );
        expect((yield* readings.current)[0]?.utilization).toBe(0.8);
        yield* readings.replaceSubscription("claude", [], beforeQuery);
        expect((yield* readings.current)[0]?.utilization).toBe(0.8);
        yield* readings.replaceSubscription("claude", [], yield* readings.current);
        expect(yield* readings.current).toEqual([]);
      }),
    ),
  );
  it.effect("keeps each window's latest reading across a restart, with its samples", () =>
    Effect.gen(function* () {
      const db = tempDb();
      yield* withReadings(
        db.path,
        Effect.gen(function* () {
          const readings = yield* UsageLimitReadings;
          yield* readings.record(reading({ utilization: 0.3 }));
          yield* TestClock.adjust(20 * MINUTE);
          yield* readings.record(reading({ utilization: 0.42 }));
          yield* readings.record(
            reading({ window: "seven_day", utilization: 0.61, resetsAt: 72 * HOUR }),
          );
          // A gateway's window is its own, beside the subscription's.
          yield* readings.record(reading({ gateway: true, profileId: "gw", utilization: 0.9 }));
          // Overage and per-model windows aren't kept.
          yield* readings.record(reading({ window: "overage" }));
        }),
      );
      // A new server over the same database: what the meter is replayed comes back.
      const kept = yield* withReadings(
        db.path,
        Effect.gen(function* () {
          return yield* (yield* UsageLimitReadings).current;
        }),
      );
      db.done();
      expect(
        kept.toSorted((a, b) => a.window.localeCompare(b.window) || a.utilization - b.utilization),
      ).toEqual([
        {
          agent: "claude",
          window: "five_hour",
          status: "allowed",
          utilization: 0.42,
          resetsAt: 5 * HOUR,
          at: 20 * MINUTE,
          samples: [
            { at: 0, utilization: 0.3 },
            { at: 20 * MINUTE, utilization: 0.42 },
          ],
        },
        {
          agent: "claude",
          profileId: "gw",
          window: "five_hour",
          status: "allowed",
          utilization: 0.9,
          resetsAt: 5 * HOUR,
          at: 20 * MINUTE,
          samples: [{ at: 20 * MINUTE, utilization: 0.9 }],
        },
        {
          agent: "claude",
          window: "seven_day",
          status: "allowed",
          utilization: 0.61,
          resetsAt: 72 * HOUR,
          at: 20 * MINUTE,
          samples: [{ at: 20 * MINUTE, utilization: 0.61 }],
        },
      ]);
    }),
  );

  it.effect("drops a window once it has reset, from memory and from the database", () =>
    Effect.gen(function* () {
      const db = tempDb();
      yield* withReadings(
        db.path,
        Effect.gen(function* () {
          const readings = yield* UsageLimitReadings;
          yield* readings.record(reading({ resetsAt: HOUR }));
          yield* readings.record(reading({ window: "seven_day", resetsAt: 72 * HOUR }));
          // A rejection that named no reset lapses an hour after it came.
          yield* readings.record({
            type: "usageLimit",
            threadId: "t-1" as ThreadId,
            agent: "codex",
            status: "rejected",
            window: "five_hour",
          });
          expect((yield* readings.current).map((each) => each.window)).toHaveLength(3);
          yield* TestClock.adjust(HOUR);
          expect((yield* readings.current).map((each) => `${each.agent} ${each.window}`)).toEqual([
            "claude seven_day",
          ]);
        }),
      );
      const kept = yield* withReadings(
        db.path,
        Effect.gen(function* () {
          return yield* (yield* UsageLimitReadings).current;
        }),
      );
      db.done();
      expect(kept.map((each) => each.window)).toEqual(["seven_day"]);
    }),
  );

  it.effect("takes readings from the hub and replays them to a client that connects", () =>
    Effect.gen(function* () {
      const db = tempDb();
      const replay = yield* withReadings(
        db.path,
        Effect.gen(function* () {
          const hub = yield* EventHub;
          const readings = yield* UsageLimitReadings;
          // Its consumer subscribes as the layer starts; let it.
          for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
          yield* hub.publish(reading({ utilization: 0.55 }));
          for (let i = 0; i < 50 && (yield* readings.current).length === 0; i++)
            yield* Effect.yieldNow;
          // `events.subscribe`'s head, as the app handler builds it, without the runtimes.
          return yield* hub
            .serverEvents(
              readings.current.pipe(
                Effect.map((limits): ReadonlyArray<ServerEvent> => [
                  { type: "threads.snapshot", threads: [] },
                  { type: "usageLimits.snapshot", limits },
                ]),
              ),
            )
            .pipe(Stream.take(2), Stream.runCollect);
        }),
      );
      db.done();
      expect(replay.map((event) => event.type)).toEqual([
        "threads.snapshot",
        "usageLimits.snapshot",
      ]);
      const [, snapshot] = replay;
      expect(snapshot).toMatchObject({
        type: "usageLimits.snapshot",
        limits: [{ agent: "claude", window: "five_hour", utilization: 0.55 }],
      });
    }),
  );
});
