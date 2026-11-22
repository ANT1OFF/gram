// Which of a PR's states cancel its running checks, as merge_when_ready sees them. The checks
// service is a fake that records what is cancelled; `local-check-cancel.test.ts` covers the rest.
import type { BoundPr, MergeIntent, PrStatus, Thread, ThreadId } from "@gram/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { LocalCheck, LocalChecksShape } from "./local-checks.ts";
import { makeCheckSettle } from "./merge-check-cancel.ts";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const STARTED = Date.parse("2026-11-21T10:00:00Z");
const BEFORE = "2026-11-21T09:59:00Z";
const AFTER = "2026-11-21T10:01:00Z";

const running = (head: string): LocalCheck => ({
  head,
  base: "c".repeat(40),
  tree: "d".repeat(40),
  status: "running",
  command: "invented-check",
  isolation: "invented",
  pr: { repo: "invented/shop", number: 7 },
  startedAt: STARTED,
  host: "invented",
});

/** A fake checks service holding `checks` as running: `cancel` ends those `keep` doesn't keep. */
const fakeChecks = (checks: ReadonlyArray<LocalCheck>) => {
  const cancelled: Array<{ readonly head: string; readonly why: string }> = [];
  const service = {
    cancel: (_pr, why, keep) =>
      Effect.sync(() => {
        const ended = checks.filter((check) => keep?.(check) !== true);
        for (const check of ended) cancelled.push({ head: check.head, why });
        return ended;
      }),
  } as Pick<LocalChecksShape, "cancel"> as LocalChecksShape;
  return { cancelled, service };
};

const intent = { method: "squash", setAt: 1 } as MergeIntent;
const thread = (armed: boolean): Thread =>
  ({
    id: "worker" as ThreadId,
    boundPr: {
      repo: "invented/shop",
      number: 7,
      monitor: true,
      ...(armed ? { mergeWhenReady: intent } : {}),
    } satisfies BoundPr,
  }) as unknown as Thread;
const badge = (state: PrStatus["state"], head: string, updatedAt?: string): PrStatus =>
  ({
    number: 7,
    url: "https://github.com/invented/shop/pull/7",
    state,
    headRefOid: head,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }) as PrStatus;

describe("a PR's state cancelling its checks", () => {
  it.effect("drops them when its merge intent is dropped, not while none was ever set", () =>
    Effect.gen(function* () {
      const checks = fakeChecks([running(HEAD)]);
      const settle = makeCheckSettle(checks.service);
      // A check local_check ran with no merge armed runs on.
      yield* settle(thread(false), badge("OPEN", HEAD, AFTER));
      expect(checks.cancelled).toEqual([]);
      yield* settle(thread(true), badge("OPEN", HEAD, AFTER));
      expect(checks.cancelled).toEqual([]);
      yield* settle(thread(false), badge("OPEN", HEAD, AFTER));
      expect(checks.cancelled).toEqual([{ head: HEAD, why: "merge_when_ready was dropped" }]);
    }),
  );

  it.effect("cancels them once the PR merged, however it was read", () =>
    Effect.gen(function* () {
      const checks = fakeChecks([running(HEAD)]);
      yield* makeCheckSettle(checks.service)(thread(false), badge("MERGED", HEAD));
      expect(checks.cancelled).toEqual([{ head: HEAD, why: "the pull request merged" }]);
    }),
  );

  it.effect("cancels them once closed, on a read made after they started", () =>
    Effect.gen(function* () {
      const checks = fakeChecks([running(HEAD)]);
      const settle = makeCheckSettle(checks.service);
      // Read before it started, as a reopened PR's stale badge would be.
      yield* settle(thread(false), badge("CLOSED", HEAD, BEFORE));
      expect(checks.cancelled).toEqual([]);
      yield* settle(thread(false), badge("CLOSED", HEAD, AFTER));
      expect(checks.cancelled).toEqual([{ head: HEAD, why: "the pull request was closed" }]);
    }),
  );

  it.effect("cancels a check of an old head once the head moves, keeping the new head's", () =>
    Effect.gen(function* () {
      const checks = fakeChecks([running(HEAD), running(NEXT)]);
      const settle = makeCheckSettle(checks.service);
      // A badge read before the push names a head the checks moved past: nothing is cancelled.
      yield* settle(thread(false), badge("OPEN", HEAD, BEFORE));
      expect(checks.cancelled).toEqual([]);
      yield* settle(thread(false), badge("OPEN", NEXT));
      expect(checks.cancelled).toEqual([]);
      yield* settle(thread(false), badge("OPEN", NEXT, AFTER));
      expect(checks.cancelled).toEqual([
        { head: HEAD, why: `the pull request's head moved to ${NEXT.slice(0, 7)}` },
      ]);
    }),
  );
});
