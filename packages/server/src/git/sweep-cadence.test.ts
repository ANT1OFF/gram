import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import type { GitState, PrStatus, ThreadId } from "@gram/contracts";
import {
  GitStateRuntime,
  Pr,
  ProcLive,
  ReviewBots,
  samePathKey,
  WorktreeError,
  Worktrees,
  WorktreesLive,
} from "@gram/git";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { asBackground, GhBudget, GhPriority } from "../github/budget.ts";
import { OpenPrs } from "../github/open-prs.ts";
import { RateLimitMonitor } from "../github/rate-limit-monitor.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { AppActivity } from "./activity.ts";
import { GitRefresh, GitServerConfig } from "./platform.ts";
import {
  GitStatePublisher,
  GitStatePublisherLive,
  hasWatch,
  LISTED_LOCAL_EVERY,
  localEvery,
  sweepTier,
} from "./publisher.ts";
import { makeRepo, removeDir, tempDir } from "./test-repo.ts";
import { ThreadVisibility } from "./visibility.ts";

const SWEEP = Duration.seconds(15);
const REFUSAL = "API rate limit exceeded for user ID 1.";

const badge: PrStatus = {
  number: 7,
  state: "OPEN",
  url: "https://github.com/acme/web/pull/7",
  title: "t",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
};

// Every snapshot carries a PR badge, which keeps the sweep from looking for one on another worktree.
const snapshot: GitState = {
  repo: true,
  worktree: false,
  head: "abc",
  changesToken: "t",
  changedFiles: 0,
  behindBase: 0,
  aheadBase: 0,
  conflicts: false,
  branch: "feat",
  origin: "acme/web",
  pr: badge,
};

/**
 * Which checkouts the fake git runtime was asked about, and at which tier; `reused`, per remote
 * refresh, whether it took the checkout's last local read.
 */
const seen = {
  remote: [] as Array<string>,
  local: [] as Array<string>,
  reused: [] as Array<boolean>,
};
/** Each `Pr.prime` call: the checkouts it named, and how many remote refreshes had run by then. */
let primed: Array<{ readonly cwds: ReadonlyArray<string>; readonly remoteBefore: number }> = [];
beforeEach(() => {
  seen.remote = [];
  seen.local = [];
  seen.reused = [];
  primed = [];
  refuseNext = false;
  priorities = [];
  snapshotOf = () => snapshot;
  worktreeLists.at = [];
  worktreeLists.failNext = false;
});

/**
 * The worktree lists the PR-elsewhere cue asked for, each as how many remote refreshes had run by
 * then: one a sweep, after the thread's first. `failNext` fails the next one.
 */
const worktreeLists = { at: [] as Array<number>, failNext: false };

/**
 * The repo's one worktree, its main checkout on `feat`, listed without a `git` run: the test clock
 * these tests move would time a real one out.
 */
const CountingWorktrees = Layer.effect(
  Worktrees,
  Effect.map(Effect.service(Worktrees), (worktrees) =>
    Worktrees.of({
      ...worktrees,
      list: (repoPath) =>
        Effect.suspend(() => {
          worktreeLists.at.push(seen.remote.length);
          if (worktreeLists.failNext) {
            worktreeLists.failNext = false;
            return Effect.fail(
              new WorktreeError({ reason: "failed", message: "git timed out", dirty: false }),
            );
          }
          return Effect.succeed({
            repoTop: repoPath,
            worktrees: [
              {
                path: repoPath,
                branch: "feat",
                detached: false,
                isMain: true,
                isOpen: true,
                lastActivity: 0,
              },
            ],
          });
        }),
    }),
  ),
).pipe(Layer.provide(WorktreesLive));

/** Set by `refuse`: the next remote refresh is answered as a rate-limited `gh` would answer it. */
let refuseNext = false;
/** The `GhPriority` each remote refresh ran under, in order. */
let priorities: Array<string> = [];
/** What the fake git runtime answers for a checkout, when not the usual open PR. */
let snapshotOf: (cwd: string) => GitState = () => snapshot;

const FakeGitState = Layer.effect(
  GitStateRuntime,
  Effect.gen(function* () {
    const monitor = yield* RateLimitMonitor;
    return {
      local: (cwd) => Effect.sync(() => snapshotOf(cwd)),
      snapshot: (cwd, options) =>
        Effect.gen(function* () {
          (options.remote ? seen.remote : seen.local).push(samePathKey(cwd));
          if (options.remote) seen.reused.push(options.reuseLocal === true);
          if (options.remote) priorities.push(yield* GhPriority);
          if (options.remote && refuseNext) {
            refuseNext = false;
            yield* monitor.record("core", REFUSAL);
          }
          return snapshotOf(cwd);
        }),
      watch: () => Stream.never,
      present: () => Effect.succeed(true),
    };
  }),
);

/** Waits on real time, since the cue's `git` runs are real processes. */
const listed = (count: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 20_000;
    while (worktreeLists.at.length < count && Date.now() < deadline) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    expect(worktreeLists.at.length).toBeGreaterThanOrEqual(count);
  });

const FakePr = Layer.succeed(Pr, {
  status: () => Effect.succeed(badge),
  checks: () => Effect.succeed([]),
  seenChecks: () => Effect.succeed(undefined),
  prime: (lookups) =>
    Effect.sync(() => {
      primed.push({
        cwds: lookups.map((lookup) => samePathKey(lookup.cwd)),
        remoteBefore: seen.remote.length,
      });
    }),
  detail: () => Effect.succeed({ available: false }),
});

const layer = (options: { readonly sweeps?: boolean } = {}) =>
  GitStatePublisherLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(ThreadVisibility.layer, AppActivity.layer, GhBudget.layer, OpenPrs.layerNone),
    ),
    Layer.provideMerge(RuntimeTestLayer),
    Layer.provideMerge(
      Layer.mergeAll(
        FakeGitState,
        FakePr,
        GitRefresh.layer,
        CountingWorktrees,
        Layer.succeed(GitServerConfig, {
          ...GitServerConfig.defaults,
          sweepInterval: options.sweeps === false ? undefined : SWEEP,
        }),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(ProcLive, ReviewBots.layer, RateLimitMonitor.layer)),
    Layer.orDie,
  );

/**
 * A thread on `path`, watched, with its first refresh already done, and opened once the sweep loop's
 * first pass is behind it. That pass is forked as the layer is built and sweeps without waiting, so
 * which side of the thread it fell was the scheduler's choice: Effect yields a fiber every 2048 ops,
 * and a migration added to the layer build moved the yield. A pass that came after the thread asked
 * about it at second zero, and a test counting from here read that as a sweep one second in.
 */
const openThread = (path: string, options: { readonly sweeps?: boolean } = {}) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const publisher = yield* GitStatePublisher;
    // Every pass primes, with nothing to ask about when no thread is open.
    if (options.sweeps !== false)
      yield* waitFor(
        "the sweep loop's first pass",
        Effect.sync(() => primed.length > 0),
      );
    const thread = yield* runtimes.create({ projectRoot: path, checkout: { kind: "main", path } });
    yield* publisher.sync;
    yield* waitFor(
      "the first refresh",
      Effect.sync(() => seen.remote.length + seen.local.length),
    );
    return thread;
  });

/**
 * Has GitHub refuse the next sweep's lookup. Inside the sweep, because that is what backs it off: a
 * refusal while the loop sleeps is someone else's, a click or an agent's tool call.
 */
const refuse = Effect.sync(() => {
  refuseNext = true;
});

const remoteCount = Effect.sync(() => seen.remote.length);
const grewTo = (count: number) =>
  waitFor(
    `${count} remote refreshes`,
    Effect.sync(() => seen.remote.length >= count),
  );

/**
 * Advances the test clock a second at a time until the next sweep runs, and answers how many
 * seconds that took. Reads the cadence without pinning the ±25% jitter on a backed-off wait.
 */
const secondsUntilSweep = (limit = 1800) =>
  Effect.gen(function* () {
    const before = yield* remoteCount;
    for (let second = 1; second <= limit; second++) {
      yield* TestClock.adjust(Duration.seconds(1));
      if ((yield* remoteCount) > before) return second;
    }
    return Number.POSITIVE_INFINITY;
  });

/**
 * Three minutes, give or take: the hidden wait races a window coming back, so it starts on a forked
 * fiber and can land a test-clock second either side.
 */
const expectHiddenCadence = (seconds: number) => {
  expect(seconds).toBeGreaterThanOrEqual(175);
  expect(seconds).toBeLessThanOrEqual(185);
};

describe("sweep cadence", () => {
  it.effect("sweeps at the base interval, backs off on a refusal, and recovers after one", () =>
    Effect.gen(function* () {
      yield* openThread("/work/a");
      expect(yield* secondsUntilSweep()).toBe(15);
      expect(yield* secondsUntilSweep()).toBe(15);

      // The pass after the refusal sees it, and stretches the wait that follows.
      yield* refuse;
      expect(yield* secondsUntilSweep()).toBe(15);
      const backedOff = yield* secondsUntilSweep();
      expect(backedOff).toBeGreaterThanOrEqual(45);
      expect(backedOff).toBeLessThanOrEqual(75);

      // That retry was clean, so the cadence is the base one again.
      expect(yield* secondsUntilSweep()).toBe(15);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("asks about every swept checkout's PR together, before refreshing any", () =>
    Effect.gen(function* () {
      yield* openThread("/work/p1");
      yield* openThread("/work/p2");
      const before = yield* remoteCount;
      yield* secondsUntilSweep();
      yield* grewTo(before + 2);

      const sweep = primed.find((call) => call.cwds.length === 2);
      expect(sweep?.cwds.toSorted()).toEqual([samePathKey("/work/p1"), samePathKey("/work/p2")]);
      expect(sweep?.remoteBefore).toBe(before);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("leaves a checkout nobody can see out of what it asks GitHub", () =>
    Effect.gen(function* () {
      const visibility = yield* ThreadVisibility;
      yield* openThread("/work/p3");
      yield* visibility.update([{ threadIds: [], sidebarCollapsed: true }]);
      primed = [];
      yield* TestClock.adjust(Duration.seconds(45));
      expect(primed.flatMap((call) => call.cwds)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("waits for the reset GitHub named, without asking again before it", () =>
    Effect.gen(function* () {
      const budget = yield* GhBudget;
      yield* openThread("/work/q1");
      yield* secondsUntilSweep();

      // What a refused document's headers say: nothing left, and twenty minutes to the reset.
      const resetAt = Math.round((yield* Clock.currentTimeMillis) / 1000) + 1200;
      yield* budget.observe({
        resource: "graphql",
        limit: 5000,
        remaining: 0,
        used: 5000,
        resetAt,
      });
      const waited = yield* secondsUntilSweep(3600);
      expect(waited).toBeGreaterThanOrEqual(1200);
      expect(waited).toBeLessThanOrEqual(1200 + 20);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("slows down as the allowance drains, and stops at the share kept for other tools", () =>
    Effect.gen(function* () {
      const budget = yield* GhBudget;
      yield* openThread("/work/q2");
      yield* secondsUntilSweep();
      const nowSeconds = Math.round((yield* Clock.currentTimeMillis) / 1000);
      const left = (remaining: number, resetIn: number) =>
        budget.observe({
          resource: "graphql",
          limit: 5000,
          remaining,
          used: 5000 - remaining,
          resetAt: nowSeconds + resetIn,
        });

      // Twenty spendable points over an hour, half of them for polling.
      yield* left(520, 3600);
      yield* secondsUntilSweep(3600);
      const slowed = yield* secondsUntilSweep(3600);
      expect(slowed).toBeGreaterThan(300);
      expect(slowed).toBeLessThan(400);

      // Down to the reserve: no lookups at all until the reset.
      yield* left(500, 3000);
      const before = yield* remoteCount;
      yield* TestClock.adjust(Duration.seconds(2400));
      expect(yield* remoteCount).toBeLessThanOrEqual(before + 1);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("doesn't back off for a refusal that wasn't the sweep's", () =>
    Effect.gen(function* () {
      yield* openThread("/work/q3");
      yield* secondsUntilSweep();
      // A click, or an agent's tool call, refused while the loop sleeps.
      yield* Effect.flatMap(RateLimitMonitor, (monitor) => monitor.record("core", REFUSAL));
      expect(yield* secondsUntilSweep()).toBe(15);
      expect(yield* secondsUntilSweep()).toBe(15);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect(
    "refreshes a thread as the user moves into it, unless it was only just asked about",
    () =>
      Effect.gen(function* () {
        const visibility = yield* ThreadVisibility;
        const cool = yield* openThread("/work/f1");
        const other = yield* openThread("/work/f2");
        const view = (focusedThreadId: ThreadId) => [
          { threadIds: [cool.id, other.id], sidebarCollapsed: false, focusedThreadId },
        ];
        yield* visibility.update(view(other.id));
        // Left alone for a day, its row is asked about a few times an hour.
        yield* TestClock.adjust(Duration.hours(25));
        yield* TestClock.adjust(Duration.seconds(11));
        const before = seen.remote.filter((cwd) => cwd === samePathKey("/work/f1")).length;

        yield* visibility.update(view(cool.id));
        yield* waitFor(
          "the focused thread's refresh",
          Effect.sync(
            () => seen.remote.filter((cwd) => cwd === samePathKey("/work/f1")).length > before,
          ),
        );

        // Straight back again: what was asked a moment ago is fresh enough.
        const asked = () => seen.remote.filter((cwd) => cwd === samePathKey("/work/f1")).length;
        const settled = asked();
        yield* visibility.update(view(other.id));
        yield* visibility.update(view(cool.id));
        yield* Effect.yieldNow;
        expect(asked()).toBe(settled);
      }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("asks less often about a thread the longer it is left alone", () =>
    Effect.gen(function* () {
      yield* openThread("/work/f3");
      expect(yield* secondsUntilSweep()).toBe(15);
      yield* TestClock.adjust(Duration.minutes(61));
      yield* secondsUntilSweep();
      expect(yield* secondsUntilSweep()).toBe(60);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("follows a cooled thread closely again while GitHub is about to react", () =>
    Effect.gen(function* () {
      const refreshes = yield* GitRefresh;
      yield* openThread("/work/f4");
      yield* TestClock.adjust(Duration.minutes(61));
      yield* secondsUntilSweep();

      // A push: CI is about to start.
      yield* refreshes.request("/work/f4", true, { expectChange: true });
      // The refresh it asked for, then the sweep already on its way: from there, every sweep.
      yield* secondsUntilSweep();
      expect(yield* secondsUntilSweep()).toBeLessThanOrEqual(15);
      expect(yield* secondsUntilSweep()).toBe(15);
      expect(yield* secondsUntilSweep()).toBe(15);
      // And once that has had its few minutes, the thread is as cool as it was.
      yield* TestClock.adjust(Duration.minutes(4));
      yield* secondsUntilSweep();
      expect(yield* secondsUntilSweep()).toBe(60);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("stops asking about a PR merged at the checkout's HEAD", () =>
    Effect.gen(function* () {
      snapshotOf = () => ({ ...snapshot, pr: { ...badge, state: "MERGED", headRefOid: "abc" } });
      yield* openThread("/work/f5");
      const before = yield* remoteCount;
      yield* TestClock.adjust(Duration.minutes(30));
      expect(yield* remoteCount).toBe(before);
      // The local tier still runs: a commit on top moves HEAD, and that ends it.
      expect(seen.local.length).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("runs a queued refresh for whoever asked, and the sweep as background work", () =>
    Effect.gen(function* () {
      const refreshes = yield* GitRefresh;
      yield* openThread("/work/pri");
      yield* secondsUntilSweep();
      expect(priorities.at(-1)).toBe("background");

      // Babysit and the monitors ask through the queue: the fiber that drains it isn't theirs.
      yield* asBackground(refreshes.request("/work/pri", true));
      yield* grewTo((yield* remoteCount) + 1);
      expect(priorities.at(-1)).toBe("background");

      yield* refreshes.request("/work/pri", true);
      yield* grewTo((yield* remoteCount) + 1);
      expect(priorities.at(-1)).toBe("interactive");
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("leaves the network tier alone for a thread nobody can see", () =>
    Effect.gen(function* () {
      const visibility = yield* ThreadVisibility;
      const thread = yield* openThread("/work/b");
      yield* visibility.update([{ threadIds: [], sidebarCollapsed: true }]);
      const before = yield* remoteCount;
      const localBefore = seen.local.length;

      yield* TestClock.adjust(Duration.seconds(45));
      expect(yield* remoteCount).toBe(before);
      // Nor the local tier: its watcher reports what changes, and coming back on screen reads anew.
      expect(seen.local.length).toBe(localBefore);

      // A pane showing it again brings the badge back now, rather than at the next sweep.
      yield* visibility.update([{ threadIds: [thread.id], sidebarCollapsed: true }]);
      yield* grewTo(before + 1);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("reads a listed checkout every eighth sweep, and one a pane shows every sweep", () =>
    Effect.gen(function* () {
      const visibility = yield* ThreadVisibility;
      // Merged at HEAD: never asked about again, so every sweep is the local tier alone.
      snapshotOf = () => ({ ...snapshot, pr: { ...badge, state: "MERGED", headRefOid: "abc" } });
      const thread = yield* openThread("/work/r1");
      yield* TestClock.adjust(Duration.seconds(15 * 2 * LISTED_LOCAL_EVERY));
      expect(seen.local.length).toBe(2);

      yield* visibility.update([{ threadIds: [thread.id], sidebarCollapsed: false }]);
      yield* TestClock.adjust(Duration.seconds(15 * 4));
      expect(seen.local.length).toBe(6);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("looks an unchanged checkout's PR up on the local read it already has", () =>
    Effect.gen(function* () {
      yield* openThread("/work/r2");
      seen.reused = [];
      yield* TestClock.adjust(Duration.seconds(15 * LISTED_LOCAL_EVERY));
      // Its own row alone on screen, so every eighth of those lookups reads it anew.
      expect(seen.reused).toEqual([
        ...Array.from({ length: LISTED_LOCAL_EVERY - 1 }, () => true),
        false,
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("looks a watched thread's PR up every three minutes while nobody can see it", () =>
    Effect.gen(function* () {
      const visibility = yield* ThreadVisibility;
      const runtimes = yield* ThreadRuntimes;
      const watched = yield* openThread("/work/l");
      yield* openThread("/work/m");
      yield* runtimes.updateThread(watched.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: true },
      }));
      yield* visibility.update([{ threadIds: [], sidebarCollapsed: true }]);
      // Whatever the sweep before the collapse left of its count, the waits after it are whole ones.
      yield* secondsUntilSweep();
      seen.remote = [];

      expect(yield* secondsUntilSweep()).toBe(180);
      expect(yield* secondsUntilSweep()).toBe(180);
      expect(new Set(seen.remote)).toEqual(new Set([samePathKey("/work/l")]));
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("keeps that cadence for an off-screen watch while the app is in the background", () =>
    Effect.gen(function* () {
      const activity = yield* AppActivity;
      const visibility = yield* ThreadVisibility;
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* openThread("/work/n");
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: false, reviewMonitor: true },
      }));
      yield* visibility.update([{ threadIds: [], sidebarCollapsed: true }]);
      yield* activity.setWindows([{ visible: true, focused: false }]);
      yield* secondsUntilSweep();
      yield* secondsUntilSweep();

      expect(yield* secondsUntilSweep()).toBe(180);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("a refusal pushes an off-screen watch's lookup back with the sweep", () =>
    Effect.gen(function* () {
      const visibility = yield* ThreadVisibility;
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* openThread("/work/o");
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: true },
      }));
      yield* visibility.update([{ threadIds: [], sidebarCollapsed: true }]);
      yield* secondsUntilSweep();

      // The lookup GitHub refuses, then the one after it: eleven base waits and one backed-off
      // one, which is never under 45 s.
      yield* refuse;
      yield* secondsUntilSweep();
      expect(yield* secondsUntilSweep()).toBeGreaterThanOrEqual(11 * 15 + 45);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("stops sweeping while the machine is suspended, and resumes on wake", () =>
    Effect.gen(function* () {
      const activity = yield* AppActivity;
      yield* openThread("/work/c");

      yield* activity.setPower("suspended");
      yield* TestClock.adjust(SWEEP);
      const asleep = yield* remoteCount;
      yield* TestClock.adjust(Duration.minutes(30));
      expect(yield* remoteCount).toBe(asleep);

      yield* activity.setPower("awake");
      yield* grewTo(asleep + 1);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect(
    "polls with no window reported, and leaves an unwatched thread alone while hidden",
    () =>
      Effect.gen(function* () {
        const activity = yield* AppActivity;
        yield* openThread("/work/d");

        // Headless: no window has ever registered, so the sweep keeps its cadence.
        yield* TestClock.adjust(SWEEP);
        expect(yield* remoteCount).toBeGreaterThan(0);

        yield* activity.setWindows([{ visible: false, focused: false }]);
        yield* TestClock.adjust(SWEEP);
        const hidden = yield* remoteCount;
        yield* TestClock.adjust(Duration.minutes(10));
        expect(yield* remoteCount).toBe(hidden);

        yield* activity.setWindows([{ visible: true, focused: true }]);
        yield* grewTo(hidden + 1);
      }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("while hidden, sweeps only a thread with a watch on, every three minutes", () =>
    Effect.gen(function* () {
      const activity = yield* AppActivity;
      const runtimes = yield* ThreadRuntimes;
      const watched = yield* openThread("/work/g");
      yield* openThread("/work/h");
      yield* runtimes.updateThread(watched.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: true },
      }));

      yield* activity.setWindows([{ visible: false, focused: false }]);
      // Whichever wait was running when the windows went away, the ones after it are hidden ones.
      yield* secondsUntilSweep();
      seen.remote = [];
      expectHiddenCadence(yield* secondsUntilSweep());
      expectHiddenCadence(yield* secondsUntilSweep());
      expect(new Set(seen.remote)).toEqual(new Set([samePathKey("/work/g")]));

      // A window coming back doesn't wait the three minutes out, and sweeps everything again.
      seen.remote = [];
      yield* activity.setWindows([{ visible: true, focused: true }]);
      yield* grewTo(2);
      expect(new Set(seen.remote)).toEqual(
        new Set([samePathKey("/work/g"), samePathKey("/work/h")]),
      );
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("while hidden, a watched thread is swept even with its chips off screen", () =>
    Effect.gen(function* () {
      const activity = yield* AppActivity;
      const visibility = yield* ThreadVisibility;
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* openThread("/work/i");
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: false, reviewMonitor: true },
      }));
      yield* visibility.update([{ threadIds: [], sidebarCollapsed: true }]);
      yield* activity.setWindows([{ visible: false, focused: false }]);
      yield* secondsUntilSweep();

      expectHiddenCadence(yield* secondsUntilSweep());
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("while hidden, a suspended machine still stops the watched sweep", () =>
    Effect.gen(function* () {
      const activity = yield* AppActivity;
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* openThread("/work/j");
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: true },
      }));
      yield* activity.setWindows([{ visible: false, focused: false }]);
      yield* activity.setPower("suspended");
      yield* TestClock.adjust(Duration.minutes(4));
      const asleep = yield* remoteCount;
      yield* TestClock.adjust(Duration.minutes(30));
      expect(yield* remoteCount).toBe(asleep);

      // Waking behind a locked screen or a covering window picks the watch up at once.
      yield* activity.setPower("awake");
      yield* grewTo(asleep + 1);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("a window coming back doesn't cut a rate-limit backoff short", () =>
    Effect.gen(function* () {
      const activity = yield* AppActivity;
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* openThread("/work/k");
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: true },
      }));
      yield* activity.setWindows([{ visible: false, focused: false }]);
      yield* secondsUntilSweep();
      yield* refuse;
      expectHiddenCadence(yield* secondsUntilSweep());

      // That pass saw the refusal, so the wait now running is GitHub's.
      const before = yield* remoteCount;
      yield* activity.setWindows([{ visible: true, focused: true }]);
      yield* TestClock.adjust(Duration.seconds(30));
      expect(yield* remoteCount).toBe(before);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  describe("the PR-elsewhere cue between work-elsewhere passes", () => {
    const dirs: Array<string> = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) removeDir(dir);
    });

    /** A real repo whose checkout has no PR of its own, so the sweep looks for one elsewhere. */
    const repoWithoutPr = () => {
      const dir = tempDir();
      dirs.push(dir);
      const { pr: _pr, ...withoutPr } = snapshot;
      snapshotOf = () => withoutPr;
      return makeRepo(dir);
    };
    it.effect("looks again on the first sweep back on screen", () =>
      Effect.gen(function* () {
        const activity = yield* AppActivity;
        yield* openThread(repoWithoutPr());
        // The thread is new to the cue on the next pass, the first after the loop's scan pass.
        yield* secondsUntilSweep();
        yield* listed(1);
        yield* secondsUntilSweep();
        yield* activity.setWindows([{ visible: false, focused: false }]);
        yield* TestClock.adjust(Duration.minutes(10));

        // Not a scan pass, and nothing tracked moved; but whatever moved while hidden is looked at.
        yield* activity.setWindows([{ visible: true, focused: true }]);
        yield* listed(2);
        // Sweep 1, then the third, back on screen, not the second.
        expect(worktreeLists.at).toEqual([2, 4]);
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );

    it.effect("looks again on the next sweep after a read that failed", () =>
      Effect.gen(function* () {
        yield* openThread(repoWithoutPr());
        worktreeLists.failNext = true;
        yield* secondsUntilSweep();
        yield* listed(1);
        yield* secondsUntilSweep();
        yield* listed(2);
        // Read once, it waits for the scan pass, the fourth.
        yield* secondsUntilSweep();
        yield* secondsUntilSweep();
        yield* listed(3);
        expect(worktreeLists.at).toEqual([2, 3, 5]);
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
  });

  it.effect("sweeps a quarter as often while the app is on screen but in the background", () =>
    Effect.gen(function* () {
      const activity = yield* AppActivity;
      yield* openThread("/work/e");
      yield* activity.setWindows([{ visible: true, focused: false }]);

      // The wait already running was set at the focused cadence: the ones after it show this one.
      yield* secondsUntilSweep();
      expect(yield* secondsUntilSweep()).toBe(60);
      expect(yield* secondsUntilSweep()).toBe(60);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.effect("never starts a sweep loop while sweeps are off", () =>
    Effect.gen(function* () {
      yield* openThread("/work/f", { sweeps: false });
      yield* TestClock.adjust(Duration.minutes(30));
      expect(yield* remoteCount).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer({ sweeps: false }))),
  );
});

describe("sweepTier", () => {
  it("sweeps every tier of a checkout someone can see, once it is due", () => {
    expect(sweepTier({ gated: false, skipped: 0, every: 1 })).toBe("full");
    expect(sweepTier({ gated: false, skipped: 2, every: 4 })).toBe("local");
    expect(sweepTier({ gated: false, skipped: 3, every: 4 })).toBe("full");
  });

  it("never asks GitHub about a checkout that is never due", () => {
    const never = Number.POSITIVE_INFINITY;
    expect(sweepTier({ gated: true, skipped: 0, every: never })).toBe("local");
    expect(sweepTier({ gated: false, skipped: 1000, every: never })).toBe("local");
  });

  it("looks an off-screen watch's PR up alone, on the sweep it falls due", () => {
    const tiers = Array.from({ length: 12 }, (_, skipped) =>
      sweepTier({ gated: true, skipped, every: 12 }),
    );
    expect(tiers).toEqual([...Array.from({ length: 11 }, () => "local"), "watch"]);
  });
});

describe("localEvery", () => {
  it("reads what a pane shows every sweep, a listed row now and then, a hidden one never", () => {
    expect(localEvery("focused")).toBe(1);
    expect(localEvery("shown")).toBe(1);
    expect(localEvery("listed")).toBe(LISTED_LOCAL_EVERY);
    expect(localEvery("hidden")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("hasWatch", () => {
  const thread = { id: "t" } as Parameters<typeof hasWatch>[0];
  const pr = { repo: "acme/web", number: 7 };

  it("is off for a thread that only shows a badge", () => {
    expect(hasWatch(thread)).toBe(false);
    expect(hasWatch({ ...thread, boundPr: { ...pr, monitor: false } })).toBe(false);
    expect(hasWatch({ ...thread, extraPrs: [{ ...pr, monitor: false }] })).toBe(false);
  });

  it("is on for Watch CI, Watch reviews, a watched extra PR and a running babysit", () => {
    expect(hasWatch({ ...thread, boundPr: { ...pr, monitor: true } })).toBe(true);
    expect(hasWatch({ ...thread, boundPr: { ...pr, monitor: false, reviewMonitor: true } })).toBe(
      true,
    );
    expect(hasWatch({ ...thread, extraPrs: [{ ...pr, monitor: true }] })).toBe(true);
    const babysit = { phase: "watching" } as NonNullable<typeof thread.babysit>;
    expect(hasWatch({ ...thread, babysit })).toBe(true);
    expect(hasWatch({ ...thread, babysit: { ...babysit, phase: "stopped" } })).toBe(false);
  });
});
