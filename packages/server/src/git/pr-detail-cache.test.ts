import { describe, expect, it } from "@effect/vitest";
import type { PrDetail, PrDetailResponse } from "@gram/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { makePrDetailCache, PR_DETAIL_TTL_MS, prDetailStamp } from "./pr-detail-cache.ts";

const detail = { number: 7, title: "t" } as unknown as PrDetail;

/** A fake `Pr.detail` that counts calls and answers with `answer`. */
const fakeDetail = (answer: () => PrDetailResponse) => {
  const calls: Array<[string, number, string | undefined]> = [];
  const run = (cwd: string, number: number, repo?: string) =>
    Effect.sync(() => {
      calls.push([cwd, number, repo]);
      return answer();
    });
  return { run, calls };
};

describe("prDetailStamp", () => {
  const badge = {
    number: 12,
    url: "https://github.com/acme/web/pull/12",
    headRefOid: "abc",
    updatedAt: "2026-09-25T21:01:00Z",
  };

  it("stamps from the thread's badge only when it is the PR asked about", () => {
    expect(prDetailStamp(badge, { number: 12 })).toBe("abc:2026-09-25T21:01:00Z");
    expect(prDetailStamp(badge, { number: 12, repo: "ACME/web" })).toBe("abc:2026-09-25T21:01:00Z");
    // The checkout's own #12 isn't a bound acme/api#12.
    expect(prDetailStamp(badge, { number: 12, repo: "acme/api" })).toBeUndefined();
    expect(prDetailStamp(badge, { number: 13 })).toBeUndefined();
    expect(prDetailStamp(undefined, { number: 12 })).toBeUndefined();
  });
});

describe("makePrDetailCache", () => {
  it.effect("reuses an answer for 30 s, then asks again", () =>
    Effect.gen(function* () {
      const fake = fakeDetail(() => ({ available: true, detail }));
      const cached = makePrDetailCache(fake.run);
      const request = { cwd: "/work/app", number: 7, stamp: "abc:2026-09-16" };

      yield* cached(request);
      yield* TestClock.adjust(PR_DETAIL_TTL_MS - 1);
      expect(yield* cached(request)).toEqual({ available: true, detail });
      expect(fake.calls).toHaveLength(1);

      yield* TestClock.adjust(1);
      yield* cached(request);
      expect(fake.calls).toHaveLength(2);
    }),
  );

  it.effect("treats a new head or another repo as a different PR", () =>
    Effect.gen(function* () {
      const fake = fakeDetail(() => ({ available: true, detail }));
      const cached = makePrDetailCache(fake.run);
      yield* cached({ cwd: "/work/app", number: 7, stamp: "abc" });
      yield* cached({ cwd: "/work/app", number: 7, stamp: "def" });
      yield* cached({ cwd: "/work/app", number: 7, repo: "acme/lib", stamp: "def" });
      expect(fake.calls).toEqual([
        ["/work/app", 7, undefined],
        ["/work/app", 7, undefined],
        ["/work/app", 7, "acme/lib"],
      ]);
    }),
  );

  it.effect("shares one fetch between callers asking while it runs", () =>
    Effect.gen(function* () {
      const latch = yield* Deferred.make<void>();
      const calls: Array<number> = [];
      const cached = makePrDetailCache((_cwd, number) =>
        Effect.sync(() => void calls.push(number)).pipe(
          Effect.andThen(Deferred.await(latch)),
          Effect.as({ available: true, detail } satisfies PrDetailResponse),
        ),
      );
      const request = { cwd: "/work/app", number: 7, stamp: "abc" };
      const [first, second] = yield* Effect.all(
        [
          cached(request),
          cached(request),
          Effect.yieldNow.pipe(Effect.andThen(Deferred.succeed(latch, undefined))),
        ],
        { concurrency: "unbounded" },
      );
      expect(first).toEqual({ available: true, detail });
      expect(second).toEqual({ available: true, detail });
      expect(calls).toEqual([7]);
    }),
  );

  it.effect("never keeps an unavailable or failed answer", () =>
    Effect.gen(function* () {
      const answers: Array<PrDetailResponse> = [
        { available: false },
        { available: true, error: "HTTP 502" },
        { available: true, detail },
      ];
      const fake = fakeDetail(() => answers.shift()!);
      const cached = makePrDetailCache(fake.run);
      const request = { cwd: "/work/app", number: 7 };
      expect(yield* cached(request)).toEqual({ available: false });
      expect(yield* cached(request)).toEqual({ available: true, error: "HTTP 502" });
      expect(yield* cached(request)).toEqual({ available: true, detail });
      yield* cached(request);
      expect(fake.calls).toHaveLength(3);
    }),
  );
});
