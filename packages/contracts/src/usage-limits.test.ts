import { describe, expect, it } from "vitest";
import {
  FORECAST_MIN_SPAN_MS,
  LIMIT_NO_RESET_TTL_MS,
  LIMIT_SAMPLES_MAX,
  limitCurrent,
  limitExpiresAt,
  limitForecast,
  nextLimitReading,
  type LimitReading,
} from "./usage-limits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-10-15T14:00:00Z");
const RESET = Date.parse("2026-10-15T18:00:00Z");

/** A window read at `[minutes before NOW, share]`, the last of them the current reading. */
const window = (
  samples: ReadonlyArray<readonly [number, number]>,
  resetsAt: number | null = RESET,
): LimitReading => {
  const kept = samples.map(([ago, utilization]) => ({ at: NOW - ago * MINUTE, utilization }));
  const last = kept.at(-1)!;
  return {
    status: "allowed",
    utilization: last.utilization,
    ...(resetsAt === null ? {} : { resetsAt }),
    at: last.at,
    samples: kept,
  };
};

describe("limit readings", () => {
  it("adds a sample when the share changes, and starts over in a new window", () => {
    const first = nextLimitReading(
      undefined,
      { status: "allowed", utilization: 0.3, resetsAt: RESET },
      NOW,
    )!;
    expect(first.samples).toEqual([{ at: NOW, utilization: 0.3 }]);
    const same = nextLimitReading(
      first,
      { status: "allowed", utilization: 0.3, resetsAt: RESET },
      NOW + MINUTE,
    )!;
    expect(same.at).toBe(NOW + MINUTE);
    expect(same.samples).toBe(first.samples);
    // A rolling reset that moved a little is the same window.
    const rose = nextLimitReading(
      same,
      { status: "allowed", utilization: 0.4, resetsAt: RESET + 5 * MINUTE },
      NOW + 2 * MINUTE,
    )!;
    expect(rose.samples.map((s) => s.utilization)).toEqual([0.3, 0.4]);
    // A reset hours later, or a share that fell, is a new window.
    const next = nextLimitReading(
      rose,
      { status: "allowed", utilization: 0.05, resetsAt: RESET + 5 * HOUR },
      NOW + 3 * MINUTE,
    )!;
    expect(next.samples).toEqual([{ at: NOW + 3 * MINUTE, utilization: 0.05 }]);
    const fell = nextLimitReading(
      rose,
      { status: "allowed", utilization: 0.1, resetsAt: RESET },
      NOW + 3 * MINUTE,
    )!;
    expect(fell.samples).toHaveLength(1);
  });

  it("ignores what it can't place, and keeps at most the cap of samples", () => {
    expect(nextLimitReading(undefined, { status: "warning" }, NOW)).toBeUndefined();
    expect(
      nextLimitReading(undefined, { status: "allowed", utilization: 0.5, resetsAt: NOW }, NOW),
    ).toBeUndefined();
    expect(nextLimitReading(undefined, { status: "rejected" }, NOW)?.utilization).toBe(1);
    let reading: LimitReading | undefined;
    for (let i = 0; i <= LIMIT_SAMPLES_MAX + 5; i++)
      reading = nextLimitReading(
        reading,
        { status: "allowed", utilization: i / 1000, resetsAt: RESET },
        NOW + i,
      );
    expect(reading!.samples).toHaveLength(LIMIT_SAMPLES_MAX);
    expect(reading!.samples.at(-1)?.utilization).toBe((LIMIT_SAMPLES_MAX + 5) / 1000);
  });

  it("a 100% metadata snapshot cannot clear a confirmed rejection of the same window", () => {
    const before = { ...window([[1, 1]]), status: "rejected" as const };
    const report = { status: "allowed" as const, utilization: 1, resetsAt: RESET };
    expect(nextLimitReading(before, report, NOW, { snapshot: true })?.status).toBe("rejected");
    expect(nextLimitReading(before, report, NOW)?.status).toBe("allowed");
    expect(
      nextLimitReading(before, { ...report, utilization: 0.5 }, NOW, { snapshot: true })?.status,
    ).toBe("allowed");
    expect(
      nextLimitReading(before, { ...report, resetsAt: RESET + 5 * HOUR }, NOW, { snapshot: true })
        ?.status,
    ).toBe("allowed");
  });

  it("retains a known reset across sparse stream updates of the same window", () => {
    const before = window([[1, 0.4]]);
    expect(nextLimitReading(before, { status: "allowed", utilization: 0.45 }, NOW)?.resetsAt).toBe(
      RESET,
    );
    expect(
      nextLimitReading(before, { status: "allowed", utilization: 0.01 }, NOW)?.resetsAt,
    ).toBeUndefined();
  });

  it("expire at the reset, or an hour after a reading without one", () => {
    const reset = window([[0, 0.4]]);
    expect(limitExpiresAt(reset)).toBe(RESET);
    expect(limitCurrent(reset, RESET - 1)).toBe(true);
    expect(limitCurrent(reset, RESET)).toBe(false);
    const none = window([[0, 0.4]], null);
    expect(limitExpiresAt(none)).toBe(NOW + LIMIT_NO_RESET_TTL_MS);
  });
});

/** The forecast's target and its time to the second: the pace is a float. */
const forecastAt = (reading: LimitReading) => {
  const forecast = limitForecast(reading, NOW);
  return forecast && { target: forecast.target, at: Math.round(forecast.at / 1000) * 1000 };
};

describe("the limit forecast", () => {
  it("projects the next target from the last hour's pace", () => {
    // 60% an hour ago, 80% now: 20 points an hour, so 90% in half an hour.
    expect(
      forecastAt(
        window([
          [90, 0.5],
          [60, 0.6],
          [0, 0.8],
        ]),
      ),
    ).toEqual({
      target: 0.9,
      at: NOW + 30 * MINUTE,
    });
    // A window that began 30 minutes ago is paced from its first reading.
    expect(
      forecastAt(
        window([
          [30, 0.7],
          [0, 0.8],
        ]),
      ),
    ).toEqual({
      target: 0.9,
      at: NOW + 30 * MINUTE,
    });
    // Past 90%, the next target is the whole limit.
    expect(
      forecastAt(
        window([
          [60, 0.8],
          [0, 0.92],
        ]),
      ),
    ).toEqual({
      target: 1,
      at: NOW + 40 * MINUTE,
    });
  });

  it("counts the time since the last reading at the pace it measured", () => {
    // Read 20 minutes ago and nothing since: the hour's rise spreads over the whole hour.
    expect(
      forecastAt(
        window([
          [60, 0.6],
          [20, 0.8],
        ]),
      )?.at,
    ).toBe(NOW + 30 * MINUTE);
  });

  it("says nothing without enough to go on", () => {
    // Watched for under the least span.
    const brief = FORECAST_MIN_SPAN_MS / MINUTE - 1;
    expect(
      limitForecast(
        window([
          [brief, 0.5],
          [0, 0.6],
        ]),
        NOW,
      ),
    ).toBeUndefined();
    // One reading only, or use that held still or fell.
    expect(limitForecast(window([[0, 0.6]]), NOW)).toBeUndefined();
    expect(
      limitForecast(
        window([
          [60, 0.6],
          [0, 0.6],
        ]),
        NOW,
      ),
    ).toBeUndefined();
    // No reset to measure against, or a pace that only gets there after it.
    expect(
      limitForecast(
        window(
          [
            [60, 0.6],
            [0, 0.8],
          ],
          null,
        ),
        NOW,
      ),
    ).toBeUndefined();
    expect(
      limitForecast(
        window([
          [60, 0.1],
          [0, 0.2],
        ]),
        NOW,
      ),
    ).toBeUndefined();
    // All used: nothing left to reach.
    expect(
      limitForecast(
        window([
          [60, 0.8],
          [0, 1],
        ]),
        NOW,
      ),
    ).toBeUndefined();
  });

  it("is deterministic for the same readings and time", () => {
    const reading = window([
      [45, 0.55],
      [30, 0.62],
      [5, 0.74],
    ]);
    expect(limitForecast(reading, NOW)).toEqual(limitForecast(reading, NOW));
  });
});
