import { describe, expect, it } from "@effect/vitest";
import {
  LIMIT_HISTORY_BUCKET_MS,
  LIMIT_HISTORY_RETENTION_MS,
  type ServerEvent,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { LIMIT_HISTORY_PRUNE_EVERY_MS } from "./limit-history.ts";
import { UsageLimitReadings } from "./limit-readings.ts";

// Synthetic readings on a pinned clock: no CLI, no account, no live provider.

type UsageLimitEvent = Extract<ServerEvent, { type: "usageLimit" }>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A pinned start, on a bucket boundary: 2026-11-01 09:00 UTC. */
const START = Date.UTC(2026, 10, 1, 9);

const reading = (overrides: Partial<UsageLimitEvent> = {}): UsageLimitEvent => ({
  type: "usageLimit",
  threadId: "t-1" as ThreadId,
  agent: "codex",
  status: "allowed",
  window: "five_hour",
  utilization: 0.4,
  resetsAt: START + 4 * HOUR,
  ...overrides,
});

/** The service over the database at `path`, its clock at `at`: each run is one server's lifetime. */
const withReadings = <A, E>(
  path: string,
  at: number,
  body: Effect.Effect<A, E, UsageLimitReadings | EventHub | SqlClient.SqlClient>,
) =>
  Effect.scoped(
    TestClock.setTime(at).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          return yield* body;
        }).pipe(
          Effect.provide(
            UsageLimitReadings.layer.pipe(
              Layer.provideMerge(EventHub.layer),
              Layer.provideMerge(ThreadStore.layerSqlite(path)),
              Layer.orDie,
            ),
          ),
        ),
      ),
    ),
  );

const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-limit-history-"));
  return { path: join(dir, "gram.db"), done: () => rmSync(dir, { recursive: true, force: true }) };
};

const rowCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [windows] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM usage_limit_history`;
  const [credits] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM usage_credit_history`;
  return { windows: windows?.n ?? 0, credits: credits?.n ?? 0 };
}).pipe(Effect.orDie);

describe("limit history sampling", () => {
  it.effect("keeps one bucket per quarter hour: the last share, the highest, and the reset", () =>
    withReadings(
      ":memory:",
      START,
      Effect.gen(function* () {
        const readings = yield* UsageLimitReadings;
        yield* readings.record(reading({ utilization: 0.4 }));
        yield* TestClock.adjust(5 * MINUTE);
        yield* readings.record(reading({ utilization: 0.55 }));
        yield* TestClock.adjust(5 * MINUTE);
        // Falls within the window but by less than a new window's drop: the peak stays.
        yield* readings.record(reading({ utilization: 0.5 }));
        yield* TestClock.adjust(10 * MINUTE);
        yield* readings.record(reading({ utilization: 0.6 }));
        const history = yield* readings.history(7);
        expect(history.step).toBe(LIMIT_HISTORY_BUCKET_MS);
        expect(history.since).toBe(START);
        expect(history.windows).toEqual([
          {
            agent: "codex",
            window: "five_hour",
            points: [
              { at: START, utilization: 0.5, peak: 0.55, resetsAt: START + 4 * HOUR },
              {
                at: START + LIMIT_HISTORY_BUCKET_MS,
                utilization: 0.6,
                peak: 0.6,
                resetsAt: START + 4 * HOUR,
              },
            ],
          },
        ]);
      }),
    ),
  );

  it.effect("writes nothing for a reading that changes no bucket", () =>
    withReadings(
      ":memory:",
      START,
      Effect.gen(function* () {
        const readings = yield* UsageLimitReadings;
        for (let i = 0; i < 10; i++) {
          yield* readings.record(reading());
          yield* TestClock.adjust(MINUTE);
        }
        expect(yield* rowCount).toEqual({ windows: 1, credits: 0 });
      }),
    ),
  );

  it.effect("keeps a credit balance per account, and never a gateway's or another window's", () =>
    withReadings(
      ":memory:",
      START,
      Effect.gen(function* () {
        const readings = yield* UsageLimitReadings;
        yield* readings.record(reading({ creditsAvailable: true, creditsBalance: "1,250" }));
        yield* readings.record(
          reading({ window: "seven_day", creditsAvailable: true, creditsBalance: "1,250" }),
        );
        yield* TestClock.adjust(HOUR);
        yield* readings.record(reading({ creditsAvailable: true, creditsBalance: "1180.5" }));
        // A balance that isn't a number is never charted as zero.
        yield* TestClock.adjust(HOUR);
        yield* readings.record(reading({ creditsAvailable: true, creditsBalance: "lots" }));
        yield* readings.record(
          reading({ agent: "claude", gateway: true, profileId: "p-1", utilization: 0.9 }),
        );
        yield* readings.record(reading({ agent: "claude", window: "overage", utilization: 0.9 }));
        const history = yield* readings.history(7);
        expect(history.credits).toEqual([
          {
            agent: "codex",
            points: [
              { at: START, balance: 1250 },
              { at: START + HOUR, balance: 1180.5 },
            ],
          },
        ]);
        expect(history.windows.map((each) => `${each.agent} ${each.window}`)).toEqual([
          "codex five_hour",
          "codex seven_day",
        ]);
      }),
    ),
  );

  it.effect("serves a month by the hour, the last share and the highest of each", () =>
    withReadings(
      ":memory:",
      START,
      Effect.gen(function* () {
        const readings = yield* UsageLimitReadings;
        for (const share of [0.1, 0.3, 0.2, 0.25]) {
          yield* readings.record(reading({ utilization: share }));
          yield* TestClock.adjust(LIMIT_HISTORY_BUCKET_MS);
        }
        const month = yield* readings.history(30);
        expect(month.step).toBe(HOUR);
        expect(month.windows[0]?.points).toEqual([
          { at: START, utilization: 0.25, peak: 0.3, resetsAt: START + 4 * HOUR },
        ]);
        expect((yield* readings.history(7)).windows[0]?.points).toHaveLength(4);
      }),
    ),
  );
});

describe("limit history retention", () => {
  it.effect("survives a restart, and keeps a peak read before it", () =>
    Effect.gen(function* () {
      const db = tempDb();
      yield* withReadings(
        db.path,
        START,
        Effect.gen(function* () {
          const readings = yield* UsageLimitReadings;
          yield* readings.record(reading({ utilization: 0.7 }));
        }),
      );
      const history = yield* withReadings(
        db.path,
        START + 5 * MINUTE,
        Effect.gen(function* () {
          const readings = yield* UsageLimitReadings;
          // A new window, its share far lower, in the same quarter hour as the last reading.
          yield* readings.record(reading({ utilization: 0.05, resetsAt: START + 5 * HOUR }));
          return yield* readings.history(7);
        }),
      );
      db.done();
      expect(history.windows[0]?.points).toEqual([
        { at: START, utilization: 0.05, peak: 0.7, resetsAt: START + 5 * HOUR },
      ]);
    }),
  );

  it.effect("prunes what ages past the retention on start", () =>
    Effect.gen(function* () {
      const db = tempDb();
      yield* withReadings(
        db.path,
        START,
        Effect.gen(function* () {
          const readings = yield* UsageLimitReadings;
          yield* readings.record(reading({ creditsAvailable: true, creditsBalance: "900" }));
          yield* TestClock.adjust(10 * DAY);
          yield* readings.record(
            reading({ utilization: 0.2, resetsAt: START + 10 * DAY + 4 * HOUR }),
          );
          expect(yield* rowCount).toEqual({ windows: 2, credits: 1 });
        }),
      );
      const after = yield* withReadings(
        db.path,
        START + LIMIT_HISTORY_RETENTION_MS + DAY,
        Effect.gen(function* () {
          const counts = yield* rowCount;
          const history = yield* (yield* UsageLimitReadings).history(30);
          return { counts, history };
        }),
      );
      db.done();
      // The first day's buckets went; the one ten days in is still within 35 days.
      expect(after.counts).toEqual({ windows: 1, credits: 0 });
      expect(after.history.since).toBe(START + 10 * DAY);
    }),
  );

  it.effect(
    "prunes while it runs, at most once an hour, and drops buckets from a wrong clock",
    () =>
      withReadings(
        ":memory:",
        START,
        Effect.gen(function* () {
          const readings = yield* UsageLimitReadings;
          const sql = yield* SqlClient.SqlClient;
          // As a clock set far ahead would have left them.
          yield* sql`INSERT INTO usage_limit_history
          (agent, limit_window, bucket, utilization, peak, resets_at)
          VALUES ('codex', 'five_hour', ${START + 30 * DAY}, 0.5, 0.5, NULL)`.pipe(Effect.orDie);
          yield* sql`INSERT INTO usage_limit_history
          (agent, limit_window, bucket, utilization, peak, resets_at)
          VALUES ('codex', 'five_hour', ${START - LIMIT_HISTORY_RETENTION_MS - DAY}, 0.5, 0.5, NULL)`.pipe(
            Effect.orDie,
          );
          // Pruned on start, under an hour ago: these wait for the next prune.
          yield* readings.record(reading());
          expect(yield* rowCount).toEqual({ windows: 3, credits: 0 });
          yield* TestClock.adjust(LIMIT_HISTORY_BUCKET_MS);
          yield* readings.record(reading({ utilization: 0.45 }));
          expect(yield* rowCount).toEqual({ windows: 4, credits: 0 });
          // An hour on, the next write prunes: the aged and the future buckets go, the rest stay.
          yield* TestClock.adjust(LIMIT_HISTORY_PRUNE_EVERY_MS);
          yield* readings.record(reading({ utilization: 0.5 }));
          expect(yield* rowCount).toEqual({ windows: 3, credits: 0 });
          expect((yield* readings.history(7)).windows[0]?.points.map((p) => p.at)).toEqual([
            START,
            START + LIMIT_HISTORY_BUCKET_MS,
            START + LIMIT_HISTORY_BUCKET_MS + LIMIT_HISTORY_PRUNE_EVERY_MS,
          ]);
        }),
      ),
  );

  it.effect("stays bounded: one row per window per quarter hour however often it is read", () =>
    withReadings(
      ":memory:",
      START,
      Effect.gen(function* () {
        const readings = yield* UsageLimitReadings;
        const days = 40;
        for (let step = 0; step < (days * DAY) / (5 * MINUTE); step++) {
          // A five-hour window filling and resetting, read every five minutes for 40 days.
          const at = START + step * 5 * MINUTE;
          const into = (at - START) % (5 * HOUR);
          yield* readings.record(
            reading({
              utilization: into / (5 * HOUR),
              resetsAt: at - into + 5 * HOUR,
            }),
          );
          yield* TestClock.adjust(5 * MINUTE);
        }
        const { windows } = yield* rowCount;
        const bound = LIMIT_HISTORY_RETENTION_MS / LIMIT_HISTORY_BUCKET_MS;
        expect(windows).toBeLessThanOrEqual(
          bound + LIMIT_HISTORY_PRUNE_EVERY_MS / LIMIT_HISTORY_BUCKET_MS,
        );
        expect(windows).toBeGreaterThan(bound - 8);
      }),
    ),
  );
});
