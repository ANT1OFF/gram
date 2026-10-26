import { afterAll, describe, expect, it } from "@effect/vitest";
import type { PrReviewState, PrStatus, ServerEvent } from "@gram/contracts";
import { Pr } from "@gram/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import { makeRuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { gitPlatformTest } from "./platform.ts";
import { GitStatePublisher, GitStatePublisherLive } from "./publisher.ts";
import { eventually, hasGit, makeRepo, removeDir, tempDir } from "./test-repo.ts";

const counts = { unresolved: 2, blockers: 1, suggestions: 1, outdatedUnresolved: 0 };

const reviewState = (overrides: Partial<PrReviewState>): PrReviewState => ({
  bots: ["example-code-review"],
  reviewedHead: true,
  roundInFlight: false,
  threads: counts,
  ...overrides,
});

const current: {
  badge: PrStatus | undefined;
  /** The badge of the PR bound from another repo, acme/api#13. */
  bound: PrStatus | undefined;
  /** Whether each bound lookup asked for the reviews. */
  askedReviews: Array<boolean>;
} = { badge: undefined, bound: undefined, askedReviews: [] };

const badgeWith = (review: PrReviewState, repo = "acme/web", number = 12): PrStatus => ({
  number,
  state: "OPEN",
  url: `https://github.com/${repo}/pull/${number}`,
  title: "t",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  review,
});

const MockPr = Layer.succeed(Pr, {
  status: (_cwd, bound) =>
    Effect.sync(() => {
      if (bound === undefined) return current.badge;
      current.askedReviews.push(bound.reviews === true);
      if (bound.reviews === true || current.bound === undefined) return current.bound;
      const { review: _unread, ...badge } = current.bound;
      return { ...badge, reviewUnread: true };
    }),
  checks: () => Effect.succeed([]),
  prime: () => Effect.void,
  seenChecks: () => Effect.succeed(undefined),
  detail: () => Effect.succeed({ available: false }),
});

const TestLayer = GitStatePublisherLive.pipe(
  Layer.provideMerge(makeRuntimeTestLayer()),
  Layer.provideMerge(
    // Longer than a refresh takes under full-suite load, so later refreshes land inside the window.
    gitPlatformTest({ pr: MockPr, config: { reviewRoundDebounce: Duration.seconds(3) } }),
  ),
);

describe.skipIf(!hasGit)("pr.reviewRound", () => {
  const dirs: Array<string> = [];
  afterAll(() => {
    for (const dir of dirs) removeDir(dir);
  });

  it.live("publishes once per completed round after the quiet window, never for the baseline", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      dirs.push(dir);
      const repo = makeRepo(dir);
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const events = yield* Queue.unbounded<ServerEvent>();
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.filter((event) => event.type === "pr.reviewRound"),
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const thread = yield* runtimes.create({
        projectRoot: repo,
        checkout: { kind: "main", path: repo },
      });

      current.badge = badgeWith(
        reviewState({ latestReviewId: "PRR_1", latestVerdict: "commented" }),
      );
      yield* publisher.refresh(repo, { remote: true });
      yield* Effect.sleep("150 millis");
      expect(yield* Queue.clear(events)).toEqual([]);

      current.badge = badgeWith(reviewState({ latestReviewId: "PRR_1", roundInFlight: true }));
      yield* publisher.refresh(repo, { remote: true });
      current.badge = badgeWith(
        reviewState({
          latestReviewId: "PRR_2",
          latestVerdict: "changesRequested",
          verdictOnHead: "changesRequested",
        }),
      );
      yield* publisher.refresh(repo, { remote: true });
      current.badge = badgeWith(
        reviewState({
          latestReviewId: "PRR_2",
          latestVerdict: "changesRequested",
          verdictOnHead: "changesRequested",
          threads: { ...counts, unresolved: 3 },
        }),
      );
      yield* publisher.refresh(repo, { remote: true });

      const round = yield* eventually(
        "a review round",
        Queue.clear(events).pipe(Effect.map((drained) => drained[0])),
      );
      expect(round).toEqual({
        type: "pr.reviewRound",
        threadId: thread.id,
        round: {
          number: 12,
          reviewId: "PRR_2",
          verdict: "changesRequested",
          verdictOnHead: "changesRequested",
          counts: { ...counts, unresolved: 3 },
        },
      });
      yield* Effect.sleep("3500 millis");
      expect(yield* Queue.clear(events)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live(
    "detects rounds on a PR bound from another repo by its own badge, asking its reviews",
    () =>
      Effect.gen(function* () {
        const dir = tempDir();
        dirs.push(dir);
        const repo = makeRepo(dir);
        const hub = yield* EventHub;
        const runtimes = yield* ThreadRuntimes;
        const publisher = yield* GitStatePublisher;
        const events = yield* Queue.unbounded<ServerEvent>();
        yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
          Stream.filter((event) => event.type === "pr.reviewRound"),
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkScoped,
        );
        const thread = yield* runtimes.create({
          projectRoot: repo,
          checkout: { kind: "main", path: repo },
        });
        current.askedReviews = [];
        current.badge = badgeWith(reviewState({ latestReviewId: "PRR_7" }));
        yield* publisher.refresh(repo, { remote: true });

        // Bound without a review monitor, it isn't asked for its reviews.
        yield* runtimes.updateThread(thread.id, (t) => ({
          ...t,
          boundPr: { repo: "acme/api", number: 13, monitor: true },
        }));
        current.bound = badgeWith(reviewState({ latestReviewId: "PRR_1" }), "acme/api", 13);
        yield* publisher.refresh(repo, { remote: true });
        expect(current.askedReviews).toEqual([false]);

        yield* runtimes.updateThread(thread.id, (t) => ({
          ...t,
          boundPr: { repo: "acme/api", number: 13, monitor: true, reviewMonitor: true },
        }));
        // The checkout's own PR moves on too; neither its round nor the bound PR's first review
        // read, another PR's than the thread's last, is a round.
        current.badge = badgeWith(reviewState({ latestReviewId: "PRR_8" }));
        current.bound = badgeWith(
          reviewState({ latestReviewId: "PRR_1", latestVerdict: "commented" }),
          "acme/api",
          13,
        );
        yield* publisher.refresh(repo, { remote: true });
        expect(current.askedReviews.at(-1)).toBe(true);
        yield* Effect.sleep("3500 millis");
        expect(yield* Queue.clear(events)).toEqual([]);

        current.bound = badgeWith(
          reviewState({ latestReviewId: "PRR_2", verdictOnHead: "changesRequested" }),
          "acme/api",
          13,
        );
        yield* publisher.refresh(repo, { remote: true });
        const round = yield* eventually(
          "a review round",
          Queue.clear(events).pipe(Effect.map((drained) => drained[0])),
        );
        expect(round).toMatchObject({
          threadId: thread.id,
          round: { number: 13, reviewId: "PRR_2", verdictOnHead: "changesRequested" },
        });
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
