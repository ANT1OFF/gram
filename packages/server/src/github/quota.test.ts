import { describe, expect, it } from "@effect/vitest";
import type { RateLimitQuota } from "@gram/git";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { GhQuota, QUOTA_REFRESH, windowHeadroom } from "./quota.ts";

const quota = (remaining: number): RateLimitQuota => ({
  search: { limit: 30, remaining, used: 30 - remaining, resetAt: 0, resetInSeconds: 0 },
  checkedAt: 0,
});

describe("windowHeadroom", () => {
  it("reads an unreported window as full, never as empty", () => {
    expect(windowHeadroom(undefined)).toBe(1);
    expect(windowHeadroom({ limit: 0, remaining: 0, used: 0, resetAt: 0, resetInSeconds: 0 })).toBe(
      1,
    );
    expect(windowHeadroom(quota(15).search)).toBe(0.5);
    expect(windowHeadroom(quota(0).search)).toBe(0);
  });
});

describe("GhQuota", () => {
  it.effect("probes once per refresh window, and again the moment it is forced", () =>
    Effect.gen(function* () {
      let probes = 0;
      const layer = GhQuota.layerFrom(
        Effect.sync(() => {
          probes += 1;
          return quota(30 - probes);
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* GhQuota;
        expect((yield* service.current())?.search?.remaining).toBe(29);
        expect((yield* service.current())?.search?.remaining).toBe(29);
        expect(probes).toBe(1);

        expect((yield* service.current({ force: true }))?.search?.remaining).toBe(28);
        expect(probes).toBe(2);

        yield* TestClock.adjust(QUOTA_REFRESH);
        yield* service.current();
        expect(probes).toBe(3);
      }).pipe(Effect.provide(layer));
    }),
  );
});
