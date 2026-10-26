import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SETTINGS,
  type GitState,
  type PrStatus,
  type ServerEvent,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import {
  reviewRequestKey,
  ReviewRequestsError,
  type ReviewRequestDetails,
  type SearchedReviewRequest,
} from "@gram/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { bindAppTools } from "../app-tools/registry.ts";
import { listOpenPrsTool, listReviewRequestsTool } from "../app-tools/review-request-tools.ts";
import { EventHub } from "../events/event-hub.ts";
import { GitServerConfig } from "../git/platform.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import {
  GhReviewRequests,
  makeReviewRequestsPoller,
  ReviewRequestsPoller,
} from "./review-requests.ts";

const pr = (
  repo: string,
  number: number,
  updatedAt = "2026-09-17T08:00:00Z",
): SearchedReviewRequest => ({
  repo,
  number,
  title: `PR ${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  author: "octocat",
  isBot: false,
  isDraft: false,
  updatedAt,
  createdAt: "2026-09-10T08:00:00Z",
});

const botPr = (repo: string, number: number): SearchedReviewRequest => ({
  ...pr(repo, number),
  author: "dependabot[bot]",
  isBot: true,
});

/** A fake `gh`: whether it's signed in, what the search returns, and how often it ran. */
const fake = {
  ready: true,
  fail: false,
  /** Overrides the failure message, so a test can make GitHub refuse on rate-limit grounds. */
  failWith: undefined as string | undefined,
  results: [] as SearchedReviewRequest[],
  searches: 0,
  /** What the user's own-PR search returns, how often it ran, and whether it fails. */
  own: [] as SearchedReviewRequest[],
  ownSearches: 0,
  ownFail: false,
  /** How many details lookups ran, and how many PRs each was asked about. */
  lookups: [] as number[],
  directOnly: [] as boolean[],
  updatedSince: [] as (string | undefined)[],
  origins: new Map<string, string>(),
  /** By `reviewRequestKey`; a PR without an entry gets no details, as when GitHub refuses. */
  details: new Map<string, ReviewRequestDetails>(),
};

const reset = (results: SearchedReviewRequest[] = []) =>
  Object.assign(fake, {
    ready: true,
    fail: false,
    failWith: undefined,
    results,
    searches: 0,
    own: [],
    ownSearches: 0,
    ownFail: false,
    lookups: [],
    directOnly: [],
    updatedSince: [],
    origins: new Map(),
    details: new Map(),
  });

const withSetting = (
  reviewRequests: boolean,
  notifications: {
    readonly reviewRequestsDirectOnly?: boolean;
    readonly reviewRequestsHideBots?: boolean;
    readonly reviewRequestsMaxAgeDays?: number;
    readonly reviewRequestsAwaitChecks?: boolean;
    readonly reviewRequestsAwaitBot?: boolean;
    readonly reviewBotRepos?: ReadonlyArray<string>;
  } = {},
) => ({
  ...DEFAULT_SETTINGS,
  notifications: { ...DEFAULT_SETTINGS.notifications, reviewRequests, ...notifications },
});

const awaitingBotIn = (reviewBotRepos: ReadonlyArray<string>) =>
  withSetting(true, { reviewRequestsAwaitBot: true, reviewBotRepos });

const FakeGh = Layer.succeed(GhReviewRequests, {
  ready: Effect.sync(() => fake.ready),
  search: ({ directOnly, updatedSince }) =>
    Effect.suspend(() => {
      fake.searches++;
      fake.directOnly.push(directOnly);
      fake.updatedSince.push(updatedSince);
      return fake.fail
        ? Effect.fail(
            new ReviewRequestsError({ message: fake.failWith ?? "HTTP 401: Bad credentials" }),
          )
        : Effect.succeed([...fake.results]);
    }),
  searchOwn: Effect.suspend(() => {
    fake.ownSearches++;
    return fake.ownFail
      ? Effect.fail(new ReviewRequestsError({ message: "HTTP 502" }))
      : Effect.succeed([...fake.own]);
  }),
  details: (prs) =>
    Effect.sync(() => {
      fake.lookups.push(prs.length);
      return new Map(
        prs.flatMap((request) => {
          const details = fake.details.get(reviewRequestKey(request));
          return details === undefined ? [] : [[reviewRequestKey(request), details] as const];
        }),
      );
    }),
  originOf: (root) => Effect.sync(() => fake.origins.get(root)),
});

/** Advances a second at a time until the next search runs, and answers how long that took. */
const secondsUntilSearch = Effect.gen(function* () {
  const before = fake.searches;
  for (let second = 1; second <= 1800; second++) {
    yield* TestClock.adjust("1 second");
    if (fake.searches > before) return second;
  }
  return Number.POSITIVE_INFINITY;
});

const layer = (sweeps = true, interval = Duration.minutes(5)) =>
  makeReviewRequestsPoller({ interval, throttle: Duration.seconds(60) }).pipe(
    Layer.provideMerge(FakeGh),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
    Layer.provideMerge(
      Layer.succeed(GitServerConfig, {
        ...GitServerConfig.defaults,
        sweepInterval: sweeps ? Duration.seconds(15) : undefined,
      }),
    ),
    Layer.orDie,
  );

/** Everything the hub publishes from now on. */
const collect = Effect.gen(function* () {
  const hub = yield* EventHub;
  const events: ServerEvent[] = [];
  yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
    Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  return {
    notices: () => events.flatMap((e) => (e.type === "notify" ? [e.title] : [])),
    changes: () => events.filter((e) => e.type === "reviewRequests.changed").length,
    ownChanges: () => events.filter((e) => e.type === "openPrs.changed").length,
  };
});

describe("ReviewRequestsPoller", () => {
  it.effect("seeds the first result silently, then notifies once per newly requested PR", () =>
    Effect.gen(function* () {
      reset([pr("acme/web", 1)]);
      const poller = yield* ReviewRequestsPoller;
      const events = yield* collect;
      // The poll at launch seeds the list without a notice.
      for (let i = 0; i < 200 && (yield* poller.current).requests.length === 0; i++) {
        yield* Effect.yieldNow;
      }
      expect((yield* poller.current).requests.map((r) => r.number)).toEqual([1]);
      expect(fake.searches).toBe(1);
      expect(events.notices()).toEqual([]);

      fake.results = [pr("acme/web", 1), pr("acme/api", 7, "2026-09-17T09:00:00Z")];
      yield* TestClock.adjust("5 minutes");
      yield* Effect.yieldNow;
      expect(events.notices()).toEqual(["Review requested: acme/api#7 PR 7"]);
      expect((yield* poller.current).requests.map((r) => r.number)).toEqual([7, 1]);

      // The same result again raises nothing; one that goes and comes back is new again.
      yield* TestClock.adjust("5 minutes");
      fake.results = [pr("acme/web", 1)];
      yield* TestClock.adjust("5 minutes");
      fake.results = [pr("acme/web", 1), pr("acme/api", 7)];
      yield* TestClock.adjust("5 minutes");
      yield* Effect.yieldNow;
      expect(events.notices()).toEqual([
        "Review requested: acme/api#7 PR 7",
        "Review requested: acme/api#7 PR 7",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect(
    "lists each PR's age, checks and bot review, and keeps them over a refused lookup",
    () =>
      Effect.gen(function* () {
        reset([pr("acme/web", 1)]);
        fake.details.set("acme/web#1", {
          checks: "failing",
          reviewDecision: "REVIEW_REQUIRED",
          bot: { verdict: "approved", onHead: true },
        });
        const poller = yield* ReviewRequestsPoller;
        const events = yield* collect;
        yield* poller.poll;
        const marks = {
          createdAt: "2026-09-10T08:00:00Z",
          checks: "failing",
          reviewDecision: "REVIEW_REQUIRED",
          bot: { verdict: "approved", onHead: true },
        };
        expect((yield* poller.current).requests[0]).toMatchObject(marks);

        fake.details.clear();
        yield* poller.poll;
        expect((yield* poller.current).requests[0]).toMatchObject(marks);

        // Checks going green is a change the sidebar hears about, but not a notice.
        const before = events.changes();
        fake.details.set("acme/web#1", { checks: "passing" });
        yield* poller.poll;
        yield* Effect.yieldNow;
        expect((yield* poller.current).requests[0]?.checks).toBe("passing");
        expect((yield* poller.current).requests[0]?.bot).toBeUndefined();
        expect(events.changes()).toBe(before + 1);
        expect(events.notices()).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("runs nothing without gh or signed out, and keeps quiet when the search fails", () =>
    Effect.gen(function* () {
      reset([pr("acme/web", 1)]);
      fake.ready = false;
      const poller = yield* ReviewRequestsPoller;
      const events = yield* collect;
      yield* poller.poll;
      expect(fake.searches).toBe(0);
      expect(yield* poller.current).toEqual({ requests: [] });

      // Signed in, but the search itself fails (bad credentials, rate limit): no toast, no change.
      fake.ready = true;
      fake.fail = true;
      yield* poller.poll;
      expect(fake.searches).toBe(1);
      expect(yield* poller.current).toEqual({ requests: [] });
      expect(events.notices()).toEqual([]);
      expect(events.changes()).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect(
    "throttles focus refreshes to one a minute, and polls at once after turning back on",
    () =>
      Effect.gen(function* () {
        reset([pr("acme/web", 1)]);
        const poller = yield* ReviewRequestsPoller;
        const events = yield* collect;
        for (let i = 0; i < 200 && fake.searches === 0; i++) yield* Effect.yieldNow;
        yield* poller.refresh();
        expect(fake.searches).toBe(1);
        yield* TestClock.adjust("61 seconds");
        yield* poller.refresh();
        expect(fake.searches).toBe(2);

        const store = yield* ThreadStore;
        // The settings toggle sends a forced refresh after each change, inside the throttle.
        yield* store.putSettings(withSetting(false));
        yield* poller.refresh({ force: true });
        expect(fake.searches).toBe(2);
        expect((yield* poller.current).requests).toEqual([]);

        // Turned back on: it polls now, and seeds silently again.
        yield* store.putSettings(withSetting(true));
        fake.results = [pr("acme/web", 1), pr("acme/api", 2)];
        yield* poller.refresh({ force: true });
        expect(fake.searches).toBe(3);
        expect((yield* poller.current).requests.map((r) => r.number)).toEqual([1, 2]);
        expect(events.notices()).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("clears the list while signed out, and notifies only really new PRs after", () =>
    Effect.gen(function* () {
      reset([pr("acme/web", 1)]);
      const poller = yield* ReviewRequestsPoller;
      const events = yield* collect;
      yield* poller.poll;
      expect((yield* poller.current).requests).toHaveLength(1);

      fake.ready = false;
      yield* poller.poll;
      expect((yield* poller.current).requests).toEqual([]);

      fake.ready = true;
      fake.results = [pr("acme/web", 1), pr("acme/api", 9)];
      yield* poller.poll;
      expect((yield* poller.current).requests.map((r) => r.number)).toEqual([1, 9]);
      expect(events.notices()).toEqual(["Review requested: acme/api#9 PR 9"]);

      // A failed search keeps the last list.
      fake.fail = true;
      yield* poller.poll;
      expect((yield* poller.current).requests).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect("ignores focus refreshes while git sweeps are off, so tests never reach gh", () =>
    Effect.gen(function* () {
      reset([pr("acme/web", 1)]);
      const poller = yield* ReviewRequestsPoller;
      yield* poller.refresh();
      yield* TestClock.adjust("10 minutes");
      yield* poller.refresh({ force: true });
      expect(fake.searches).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect("searches direct-only unless the setting turns it off, and seeds again after", () =>
    Effect.gen(function* () {
      reset([pr("acme/web", 1)]);
      const store = yield* ThreadStore;
      const poller = yield* ReviewRequestsPoller;
      const events = yield* collect;
      yield* poller.poll;
      expect(fake.directOnly).toEqual([true]);

      yield* store.putSettings(withSetting(true, { reviewRequestsDirectOnly: false }));
      fake.results = [pr("acme/web", 1), pr("acme/team", 5)];
      yield* poller.poll;
      expect(fake.directOnly).toEqual([true, false]);
      expect((yield* poller.current).requests.map((r) => r.number)).toEqual([1, 5]);
      // The widened search seeds again, so the team's PRs arrive quietly.
      expect(events.notices()).toEqual([]);

      yield* store.putSettings(withSetting(true, { reviewRequestsDirectOnly: true }));
      yield* poller.poll;
      expect(fake.directOnly).toEqual([true, false, true]);
    }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect("drops bot PRs unless the setting turns the filter off, and seeds again after", () =>
    Effect.gen(function* () {
      reset([pr("acme/web", 1), botPr("acme/web", 2), botPr("acme/api", 3)]);
      const store = yield* ThreadStore;
      const poller = yield* ReviewRequestsPoller;
      const events = yield* collect;
      yield* poller.poll;
      expect((yield* poller.current).requests.map((r) => r.number)).toEqual([1]);

      yield* store.putSettings(withSetting(true, { reviewRequestsHideBots: false }));
      yield* poller.poll;
      expect((yield* poller.current).requests.map((r) => r.number)).toEqual([1, 2, 3]);
      // Widening seeds again, so the bots that were only hidden before arrive quietly.
      expect(events.notices()).toEqual([]);

      yield* store.putSettings(withSetting(true, { reviewRequestsHideBots: true }));
      yield* poller.poll;
      expect((yield* poller.current).requests.map((r) => r.number)).toEqual([1]);
    }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect("holds a notice until the checks pass and the bot is content, when asked to", () =>
    Effect.gen(function* () {
      reset([pr("acme/web", 1)]);
      fake.details.set("acme/web#1", { checks: "pending" });
      const store = yield* ThreadStore;
      yield* store.putSettings(
        withSetting(true, { reviewRequestsAwaitChecks: true, reviewRequestsAwaitBot: true }),
      );
      const poller = yield* ReviewRequestsPoller;
      const events = yield* collect;
      yield* poller.poll;

      // Held PRs are listed at once; only the notice waits.
      fake.results = [pr("acme/web", 1), pr("acme/api", 2), pr("acme/api", 3)];
      fake.details.set("acme/api#2", { checks: "pending" });
      fake.details.set("acme/api#3", {
        checks: "none",
        bot: { verdict: "commented", onHead: true },
      });
      yield* poller.poll;
      yield* Effect.yieldNow;
      expect((yield* poller.current).requests.map((r) => r.number)).toEqual([1, 2, 3]);
      expect(events.notices()).toEqual(["Review requested: acme/api#3 PR 3"]);

      // Green checks alone aren't enough, nor is a bot that reviewed an earlier commit.
      fake.details.set("acme/api#2", {
        checks: "passing",
        bot: { verdict: "approved", onHead: false },
      });
      yield* poller.poll;
      yield* Effect.yieldNow;
      expect(events.notices()).toHaveLength(1);

      // The PR that was held when the list was seeded notifies too, and each only once.
      fake.details.set("acme/api#2", {
        checks: "passing",
        bot: { verdict: "approved", onHead: true },
      });
      fake.details.set("acme/web#1", {
        checks: "passing",
        bot: { verdict: "approved", onHead: true },
      });
      yield* poller.poll;
      yield* poller.poll;
      yield* Effect.yieldNow;
      expect(events.notices().toSorted()).toEqual([
        "Review requested: acme/api#2 PR 2",
        "Review requested: acme/api#3 PR 3",
        "Review requested: acme/web#1 PR 1",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect("passes what a lifted hold was holding quietly, and never notifies twice", () =>
    Effect.gen(function* () {
      reset([pr("acme/web", 1)]);
      const store = yield* ThreadStore;
      const poller = yield* ReviewRequestsPoller;
      const events = yield* collect;
      yield* poller.poll;
      fake.results = [pr("acme/web", 1), pr("acme/api", 2)];
      fake.details.set("acme/api#2", { checks: "failing" });
      yield* poller.poll;
      yield* Effect.yieldNow;
      expect(events.notices()).toEqual(["Review requested: acme/api#2 PR 2"]);

      // Setting a hold doesn't raise #2 again once it goes green.
      yield* store.putSettings(withSetting(true, { reviewRequestsAwaitChecks: true }));
      fake.results = [...fake.results, pr("acme/api", 3)];
      fake.details.set("acme/api#3", { checks: "failing" });
      yield* poller.poll;
      fake.details.set("acme/api#2", { checks: "passing" });
      yield* poller.poll;
      yield* Effect.yieldNow;
      expect(events.notices()).toHaveLength(1);

      // Lifting it makes #3 due, which passes quietly rather than as a burst. A PR first seen in
      // that same poll was never held, so it still notifies.
      yield* store.putSettings(withSetting(true));
      fake.results = [...fake.results, pr("acme/api", 4)];
      yield* poller.poll;
      yield* Effect.yieldNow;
      expect(events.notices()).toEqual([
        "Review requested: acme/api#2 PR 2",
        "Review requested: acme/api#4 PR 4",
      ]);
      fake.details.set("acme/api#3", { checks: "passing" });
      yield* poller.poll;
      yield* Effect.yieldNow;
      expect(events.notices()).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect(
    "holds for the bot only where one reviews, releases a repo taken off quietly, and re-holds it put back",
    () =>
      Effect.gen(function* () {
        reset([]);
        const store = yield* ThreadStore;
        yield* store.putSettings(awaitingBotIn(["Acme/Api", "acme/web"]));
        const poller = yield* ReviewRequestsPoller;
        const events = yield* collect;
        yield* poller.poll;

        fake.results = [pr("acme/api", 1), pr("acme/web", 2), pr("acme/docs", 3)];
        yield* poller.poll;
        yield* Effect.yieldNow;
        expect(events.notices()).toEqual(["Review requested: acme/docs#3 PR 3"]);

        yield* store.putSettings(awaitingBotIn(["acme/web"]));
        yield* poller.poll;
        yield* Effect.yieldNow;
        expect(events.notices()).toHaveLength(1);
        fake.details.set("acme/web#2", {
          checks: "none",
          bot: { verdict: "approved", onHead: true },
        });
        yield* poller.poll;
        yield* Effect.yieldNow;
        expect(events.notices()).toEqual([
          "Review requested: acme/docs#3 PR 3",
          "Review requested: acme/web#2 PR 2",
        ]);

        // Put back, the repo holds #1 again, since passing it quietly was never a notice.
        yield* store.putSettings(awaitingBotIn(["acme/web", "acme/api"]));
        yield* poller.poll;
        fake.details.set("acme/api#1", {
          checks: "none",
          bot: { verdict: "approved", onHead: true },
        });
        yield* poller.poll;
        yield* poller.poll;
        yield* Effect.yieldNow;
        expect(events.notices()).toHaveLength(3);
        expect(events.notices()[2]).toBe("Review requested: acme/api#1 PR 1");
      }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect("forwards the search author and bot flag without inferring them", () =>
    Effect.gen(function* () {
      reset([pr("acme/web", 1)]);
      const poller = yield* ReviewRequestsPoller;
      yield* poller.poll;
      expect((yield* poller.current).requests[0]).toEqual({
        repo: "acme/web",
        number: 1,
        title: "PR 1",
        url: "https://github.com/acme/web/pull/1",
        author: "octocat",
        isBot: false,
        isDraft: false,
        updatedAt: "2026-09-17T08:00:00Z",
        createdAt: "2026-09-10T08:00:00Z",
      });
    }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect(
    "asks GitHub for the age cutoff, counted back from the clock, and seeds again after",
    () =>
      Effect.gen(function* () {
        reset([pr("acme/web", 1)]);
        const store = yield* ThreadStore;
        const poller = yield* ReviewRequestsPoller;
        const events = yield* collect;
        yield* TestClock.setTime(Date.parse("2026-09-18T11:30:00Z"));
        yield* poller.poll;
        expect(fake.updatedSince).toEqual([undefined]);

        yield* store.putSettings(withSetting(true, { reviewRequestsMaxAgeDays: 30 }));
        yield* poller.poll;
        expect(fake.updatedSince).toEqual([undefined, "2026-08-19"]);

        yield* store.putSettings(withSetting(true, { reviewRequestsMaxAgeDays: 7 }));
        fake.results = [pr("acme/web", 1), pr("acme/api", 4)];
        yield* poller.poll;
        expect(fake.updatedSince).toEqual([undefined, "2026-08-19", "2026-09-11"]);
        // A changed cutoff seeds again rather than notifying for what it uncovers.
        expect(events.notices()).toEqual([]);

        yield* store.putSettings(withSetting(true));
        yield* poller.poll;
        expect(fake.updatedSince).toEqual([undefined, "2026-08-19", "2026-09-11", undefined]);
      }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect(
    "backs the search poll off when GitHub refuses it, and recovers after a clean one",
    () =>
      Effect.gen(function* () {
        reset([pr("acme/web", 1)]);
        yield* ReviewRequestsPoller;
        for (let i = 0; i < 200 && fake.searches === 0; i++) yield* Effect.yieldNow;
        expect(yield* secondsUntilSearch).toBe(30);

        fake.fail = true;
        fake.failWith = "API rate limit exceeded for user ID 1.";
        expect(yield* secondsUntilSearch).toBe(30);

        // The refused search stretches the next wait past the jittered first rung (45–75 s).
        fake.fail = false;
        const backedOff = yield* secondsUntilSearch;
        expect(backedOff).toBeGreaterThanOrEqual(45);
        expect(backedOff).toBeLessThanOrEqual(75);

        expect(yield* secondsUntilSearch).toBe(30);
      }).pipe(Effect.scoped, Effect.provide(layer(true, Duration.seconds(30)))),
  );

  it.effect("skips a focus refresh while GitHub is still refusing the search", () =>
    Effect.gen(function* () {
      reset([pr("acme/web", 1)]);
      const poller = yield* ReviewRequestsPoller;
      for (let i = 0; i < 200 && fake.searches === 0; i++) yield* Effect.yieldNow;
      fake.fail = true;
      fake.failWith = "You have exceeded a secondary rate limit";
      yield* TestClock.adjust("5 minutes");
      expect(fake.searches).toBe(2);

      yield* TestClock.adjust("61 seconds");
      yield* poller.refresh();
      expect(fake.searches).toBe(2);
      // A settings change still gets its answer.
      yield* poller.refresh({ force: true });
      expect(fake.searches).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("names the known project whose origin is the PR's repo", () =>
    Effect.gen(function* () {
      reset([pr("Acme/Web", 3), pr("other/repo", 4)]);
      const store = yield* ThreadStore;
      const project = yield* store.ensureProject({ root: "/work/web", name: "web" });
      fake.origins.set(project.root, "acme/web");
      const poller = yield* ReviewRequestsPoller;
      yield* poller.poll;
      const requests = (yield* poller.current).requests;
      expect(requests.find((r) => r.number === 3)?.projectRoot).toBe("/work/web");
      expect(requests.find((r) => r.number === 4)).not.toHaveProperty("projectRoot");
    }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect("lists the cached requests to an agent through list_review_requests", () =>
    Effect.gen(function* () {
      reset([pr("acme/web", 1, "2026-09-17T09:00:00Z"), pr("acme/api", 7)]);
      const store = yield* ThreadStore;
      const poller = yield* ReviewRequestsPoller;
      for (let i = 0; i < 200 && fake.searches === 0; i++) yield* Effect.yieldNow;
      expect(fake.searches).toBe(1);
      const [tool] = bindAppTools([listReviewRequestsTool(poller, store)], "t-1" as ThreadId);
      expect(tool!.descriptor.class).toBe("read");

      const all = (yield* tool!.run({ refresh: true })) as {
        enabled: boolean;
        directOnly: boolean;
        checkedAt?: string;
        requests: ReadonlyArray<{ repo: string; number: number }>;
      };
      // Refreshing goes through the poll's own throttle, never a search of the tool's.
      expect(fake.searches).toBe(1);
      yield* TestClock.adjust("61 seconds");
      yield* tool!.run({ refresh: true });
      expect(fake.searches).toBe(2);
      expect(all).toMatchObject({ enabled: true, directOnly: true });
      expect(all.checkedAt).toBeDefined();
      expect(all.requests.map((r) => `${r.repo}#${r.number}`)).toEqual([
        "acme/web#1",
        "acme/api#7",
      ]);
      expect(yield* tool!.run({ repo: "ACME/api" })).toMatchObject({
        requests: [{ repo: "acme/api", number: 7, author: "octocat", title: "PR 7" }],
      });

      yield* store.putSettings(withSetting(false));
      yield* poller.poll;
      expect(yield* tool!.run({})).toMatchObject({ enabled: false, requests: [] });
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );
});

const mine = (
  repo: string,
  number: number,
  updatedAt = "2026-09-17T08:00:00Z",
): SearchedReviewRequest => ({ ...pr(repo, number, updatedAt), author: "me" });

const addThread = (
  id: string,
  root: string,
  fields: Partial<Pick<Thread, "boundPr" | "role" | "lastActivityAt">> & { branch?: string } = {},
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({ root, name: root });
    const { branch, ...rest } = fields;
    yield* store.insertThread({
      id,
      projectId: project.id,
      title: `Thread ${id}`,
      userNamed: false,
      model: { agent: "claude", model: "opus" },
      mode: "default",
      checkout: {
        kind: "worktree",
        path: `${root}/${id}`,
        ...(branch === undefined ? {} : { branch }),
      },
      labels: [],
      pinned: false,
      parked: false,
      unread: false,
      createdAt: 1,
      lastActivityAt: 1,
      ...rest,
    } as unknown as Thread);
    return project.root;
  });

/** A thread's PR badge in acme/web. */
const badgeOf = (number: number, extra: Partial<PrStatus>): PrStatus => ({
  number,
  state: "OPEN",
  url: `https://github.com/acme/web/pull/${number}`,
  title: `Badge ${number}`,
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  ...extra,
});

describe("ReviewRequestsPoller's open PRs", () => {
  it.effect(
    "lists the user's own PRs, drafts included, from the same details lookup, and never notifies",
    () =>
      Effect.gen(function* () {
        reset([pr("acme/web", 1)]);
        fake.own = [
          mine("acme/web", 7),
          { ...mine("acme/api", 9, "2026-09-17T09:00:00Z"), isDraft: true },
        ];
        fake.details.set("acme/web#7", {
          checks: "passing",
          headRef: "feat/seven",
          mergeState: "DIRTY",
          bot: { verdict: "approved", onHead: true },
          // Read beside the checks, after the search's index last saw the PR.
          updatedAt: "2026-09-17T08:05:00Z",
        });
        const store = yield* ThreadStore;
        yield* store.ensureProject({ root: "/work/web", name: "web" });
        fake.origins.set("/work/web", "acme/web");
        const poller = yield* ReviewRequestsPoller;
        const events = yield* collect;
        yield* poller.poll;
        yield* Effect.yieldNow;
        expect(fake.ownSearches).toBe(1);
        // Both lists' PRs go into one lookup.
        expect(fake.lookups).toEqual([3]);
        const { prs, checkedAt } = yield* poller.own;
        expect(checkedAt).toBeDefined();
        expect(prs).toEqual([
          {
            author: "me",
            isBot: false,
            repo: "acme/api",
            number: 9,
            title: "PR 9",
            url: "https://github.com/acme/api/pull/9",
            isDraft: true,
            updatedAt: "2026-09-17T09:00:00Z",
            createdAt: "2026-09-10T08:00:00Z",
          },
          {
            author: "me",
            isBot: false,
            repo: "acme/web",
            number: 7,
            title: "PR 7",
            url: "https://github.com/acme/web/pull/7",
            isDraft: false,
            updatedAt: "2026-09-17T08:05:00Z",
            detailsAt: "2026-09-17T08:05:00Z",
            informationAt: "2026-09-17T08:05:00Z",
            createdAt: "2026-09-10T08:00:00Z",
            headRef: "feat/seven",
            mergeState: "DIRTY",
            checks: "passing",
            bot: { verdict: "approved", onHead: true },
            projectRoot: "/work/web",
          },
        ]);
        expect(events.ownChanges()).toBe(1);

        // A new PR of the user's own is a change for the list, never a notice.
        fake.own = [...fake.own, mine("acme/web", 8)];
        yield* poller.poll;
        yield* Effect.yieldNow;
        expect((yield* poller.own).prs.map((p) => p.number)).toEqual([9, 7, 8]);
        expect(events.ownChanges()).toBe(2);
        expect(events.notices()).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect(
    "takes the draft flag from whichever of the search and the lookup saw GitHub later",
    () =>
      Effect.gen(function* () {
        reset([]);
        // The search's index still has it as a draft; the lookup read it marked ready since.
        fake.own = [{ ...mine("acme/web", 7), isDraft: true }];
        fake.details.set("acme/web#7", {
          checks: "passing",
          isDraft: false,
          updatedAt: "2026-09-17T08:05:00Z",
        });
        const poller = yield* ReviewRequestsPoller;
        yield* poller.poll;
        expect((yield* poller.own).prs).toMatchObject([
          { isDraft: false, updatedAt: "2026-09-17T08:05:00Z" },
        ]);

        // The lookup refused, so its details are carried, and the search has seen GitHub since.
        fake.details.clear();
        fake.own = [{ ...mine("acme/web", 7, "2026-09-17T09:00:00Z"), isDraft: true }];
        yield* poller.poll;
        // The checks are still the carried lookup's, and dated as such.
        expect((yield* poller.own).prs).toMatchObject([
          {
            isDraft: true,
            updatedAt: "2026-09-17T09:00:00Z",
            detailsAt: "2026-09-17T08:05:00Z",
            checks: "passing",
          },
        ]);
      }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect(
    "searches with review requests off, keeps the list over a failed search, and clears it signed out",
    () =>
      Effect.gen(function* () {
        reset([pr("acme/web", 1)]);
        fake.own = [mine("acme/web", 7)];
        fake.details.set("acme/web#7", { checks: "failing" });
        const store = yield* ThreadStore;
        yield* store.putSettings(withSetting(false));
        const poller = yield* ReviewRequestsPoller;
        yield* poller.poll;
        expect(fake.searches).toBe(0);
        expect((yield* poller.current).requests).toEqual([]);
        expect((yield* poller.own).prs).toMatchObject([{ number: 7, checks: "failing" }]);

        // A failed search keeps the list, and a refused lookup keeps each PR's marks.
        fake.ownFail = true;
        yield* poller.poll;
        expect((yield* poller.own).prs).toMatchObject([{ number: 7, checks: "failing" }]);
        fake.ownFail = false;
        fake.details.clear();
        yield* poller.poll;
        expect((yield* poller.own).prs).toMatchObject([{ number: 7, checks: "failing" }]);

        // A failed review-request search leaves the open PRs to update on their own.
        yield* store.putSettings(withSetting(true));
        fake.fail = true;
        fake.own = [mine("acme/web", 7), mine("acme/web", 8)];
        yield* poller.poll;
        expect((yield* poller.own).prs.map((p) => p.number)).toEqual([7, 8]);

        fake.ready = false;
        yield* poller.poll;
        expect(yield* poller.own).toEqual({ prs: [] });
      }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );

  it.effect("names each PR's owning thread to an agent through list_open_prs", () =>
    Effect.gen(function* () {
      reset([]);
      fake.own = [7, 8, 9, 10, 11].map((n) => mine("acme/web", n));
      for (const [n, branch] of [
        [8, "feat/eight"],
        [9, "feat/nine"],
        [10, "feat/ten"],
        [11, "feat/eleven"],
      ] as const) {
        fake.details.set(`acme/web#${n}`, { checks: "passing", headRef: branch });
      }
      const root = yield* addThread("t-bound", "/work/web", {
        boundPr: { repo: "Acme/Web", number: 7, monitor: false },
      });
      yield* addThread("t-branch", "/work/web", { branch: "feat/eight", lastActivityAt: 5 });
      // An orchestrator on the branch owns nothing.
      yield* addThread("t-orch", "/work/web", { branch: "feat/nine", role: "orchestrator" });
      // Its checkout was made on main, and git has it on the PR's branch since; and the other way.
      yield* addThread("t-moved", "/work/web", { branch: "main" });
      yield* addThread("t-left", "/work/web", { branch: "feat/eleven" });
      // Someone else's PR bound to a thread, which the authored-PR search never returns; and a
      // badge that saw #9 merged after the poll did.
      yield* addThread("t-theirs", "/work/web", { branch: "fix/theirs" });
      const live = new Map<string, GitState>([
        ["t-moved", { branch: "feat/ten", origin: "acme/web" } as GitState],
        ["t-left", { branch: "main", origin: "acme/web" } as GitState],
        [
          "t-theirs",
          {
            branch: "fix/theirs",
            origin: "acme/web",
            pr: badgeOf(40, { updatedAt: "2026-09-17T07:00:00Z" }),
            extraPrs: [badgeOf(9, { state: "MERGED", updatedAt: "2026-09-17T09:00:00Z" })],
          } as unknown as GitState,
        ],
      ]);
      const git = { stateForThread: (thread: Thread) => Effect.succeed(live.get(thread.id)) };
      fake.origins.set(root, "acme/web");
      const store = yield* ThreadStore;
      const poller = yield* ReviewRequestsPoller;
      yield* poller.poll;
      const [tool] = bindAppTools([listOpenPrsTool(poller, store, git)], "t-1" as ThreadId);
      expect(tool!.descriptor.class).toBe("read");
      const listed = (yield* tool!.run({})) as {
        checkedAt?: string;
        prs: ReadonlyArray<{ number: number; threadId?: string; threadTitle?: string }>;
      };
      expect(listed.checkedAt).toBeDefined();
      expect(listed.prs.map((p) => [p.number, p.threadId, p.threadTitle])).toEqual([
        [7, "t-bound", "Thread t-bound"],
        [8, "t-branch", "Thread t-branch"],
        [10, "t-moved", "Thread t-moved"],
        [11, undefined, undefined],
        [40, "t-theirs", "Thread t-theirs"],
      ]);
      expect(yield* tool!.run({ repo: "other/repo" })).toMatchObject({ prs: [] });
    }).pipe(Effect.scoped, Effect.provide(layer(false))),
  );
});

it.effect(
  "carries only failed aliases with their metadata stamps and recovers on the next fresh head",
  () =>
    Effect.gen(function* () {
      reset([pr("example/tools", 1)]);
      fake.own = [mine("example/tools", 2)];
      fake.details.set("example/tools#1", {
        checks: "pending",
        updatedAt: "2026-09-17T08:00:00Z",
        headOid: "one",
        labels: ["offline"],
        additions: 0,
        deletions: 9,
      });
      fake.details.set("example/tools#2", {
        checks: "passing",
        updatedAt: "2026-09-17T08:00:00Z",
        headOid: "two",
        labels: [],
        additions: 0,
        deletions: 0,
      });
      const poller = yield* ReviewRequestsPoller;
      const events = yield* collect;
      yield* poller.poll;
      expect((yield* poller.current).requests[0]).toMatchObject({
        author: "octocat",
        isBot: false,
        labels: ["offline"],
        additions: 0,
        deletions: 9,
      });
      fake.details.delete("example/tools#1");
      fake.results = [pr("example/tools", 1, "2026-09-17T09:00:00Z")];
      fake.details.set("example/tools#2", {
        checks: "failing",
        updatedAt: "2026-09-17T09:00:00Z",
        headOid: "three",
        additions: 5,
        deletions: 0,
      });
      yield* poller.poll;
      expect((yield* poller.current).requests[0]).toMatchObject({
        detailsStale: true,
        informationStale: true,
        informationAt: "2026-09-17T08:00:00Z",
        checks: "pending",
        additions: 0,
        deletions: 9,
      });
      expect((yield* poller.own).prs[0]).toMatchObject({
        checks: "failing",
        headOid: "three",
        additions: 5,
        deletions: 0,
      });
      expect((yield* poller.own).prs[0]?.detailsStale).toBeUndefined();
      fake.details.set("example/tools#1", {
        checks: "passing",
        updatedAt: "2026-09-17T09:00:00Z",
        headOid: "four",
        labels: [],
        additions: 2,
        deletions: 0,
      });
      yield* poller.poll;
      expect((yield* poller.current).requests[0]?.informationStale).toBeUndefined();
      expect((yield* poller.current).requests[0]).toMatchObject({
        informationAt: "2026-09-17T09:00:00Z",
        labels: [],
        additions: 2,
      });
      expect(fake.lookups).toEqual([2, 2, 2]);
      expect((yield* poller.own).prs.map((p) => p.number)).toEqual([2]);
      expect(events.notices()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer(false))),
);
