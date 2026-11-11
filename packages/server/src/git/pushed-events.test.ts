import { beforeEach, describe, expect, it } from "@effect/vitest";
import type { GitState, PrStatus } from "@gram/contracts";
import { GitStateRuntime, Pr, ProcLive, ReviewBots, samePathKey, WorktreesLive } from "@gram/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Embedding } from "../embedding/embedding.ts";
import { GhBudget } from "../github/budget.ts";
import { OpenPrs } from "../github/open-prs.ts";
import { RateLimitMonitor } from "../github/rate-limit-monitor.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { AppActivity } from "./activity.ts";
import { GitRefresh, GitServerConfig } from "./platform.ts";
import {
  GitStatePublisher,
  GitStatePublisherLive,
  PUSHED_RECONCILE_EVERY,
  pushedEventTouches,
  RepoEvents,
} from "./publisher.ts";
import { ThreadVisibility } from "./visibility.ts";

const SWEEP = Duration.seconds(15);

const badge: PrStatus = {
  number: 7,
  state: "OPEN",
  url: "https://github.com/acme/web/pull/7",
  title: "t",
  isDraft: false,
  checks: "pending",
  headMatches: true,
  aheadOfPr: false,
};

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

/** The checkouts the fake git runtime read from the network, in order. */
let remote: Array<string> = [];
/** Whether the hosted features setting is on. */
let hosted = true;
beforeEach(() => {
  remote = [];
  hosted = true;
});

const FakeGitState = Layer.succeed(GitStateRuntime, {
  local: () => Effect.succeed(snapshot),
  snapshot: (cwd, options) =>
    Effect.sync(() => {
      if (options.remote) remote.push(samePathKey(cwd));
      return snapshot;
    }),
  watch: () => Stream.never,
  present: () => Effect.succeed(true),
});

const FakePr = Layer.succeed(Pr, {
  status: () => Effect.succeed(badge),
  checks: () => Effect.succeed([]),
  seenChecks: () => Effect.succeed(undefined),
  prime: () => Effect.void,
  detail: () => Effect.succeed({ available: false }),
});

const layer = (repoEvents: "poll" | "pushed") =>
  GitStatePublisherLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ThreadVisibility.layer,
        AppActivity.layer,
        GhBudget.layer,
        OpenPrs.layerNone,
        Embedding.layerOf(
          { repoEvents, inboundToken: "t".repeat(32) },
          Effect.sync(() => hosted),
        ),
      ),
    ),
    Layer.provideMerge(RuntimeTestLayer),
    Layer.provideMerge(
      Layer.mergeAll(
        FakeGitState,
        FakePr,
        GitRefresh.layer,
        WorktreesLive,
        Layer.succeed(GitServerConfig, { ...GitServerConfig.defaults, sweepInterval: SWEEP }),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(ProcLive, ReviewBots.layer, RateLimitMonitor.layer)),
    Layer.orDie,
  );

/** A thread on `path`, its first read from the network done. */
const openThread = (path: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const publisher = yield* GitStatePublisher;
    const thread = yield* runtimes.create({ projectRoot: path, checkout: { kind: "main", path } });
    yield* publisher.sync;
    yield* waitFor(
      "the first refresh",
      Effect.sync(() => remote.includes(samePathKey(path))),
    );
    return thread;
  });

const readsOf = (path: string) => remote.filter((each) => each === samePathKey(path)).length;

/** Moves the test clock on a second at a time, so every timer due in between fires in order. */
const pass = (duration: Duration.Duration) =>
  Effect.gen(function* () {
    for (let second = 0; second < Duration.toSeconds(duration); second++) {
      yield* TestClock.adjust(Duration.seconds(1));
    }
  });

describe("pushedEventTouches", () => {
  const state = { origin: "acme/web", branch: "feat", pr: badge };

  it("matches a checkout's own PR by number, whatever the repository's case", () => {
    expect(pushedEventTouches({ repo: "Acme/Web", number: 7 }, state, [])).toBe(true);
    expect(pushedEventTouches({ repo: "acme/web", number: 8 }, state, [])).toBe(false);
    expect(pushedEventTouches({ repo: "acme/api", number: 7 }, state, [])).toBe(false);
  });

  it("matches a checkout by its branch, for a pull request it doesn't know yet", () => {
    const unopened = { origin: "acme/web", branch: "feat" };
    expect(pushedEventTouches({ repo: "acme/web", branch: "feat" }, unopened, [])).toBe(true);
    expect(pushedEventTouches({ repo: "acme/web", branch: "main" }, unopened, [])).toBe(false);
    expect(pushedEventTouches({ repo: "acme/api", branch: "feat" }, unopened, [])).toBe(false);
  });

  it("matches every checkout of the repository when the event names no PR or branch", () => {
    expect(pushedEventTouches({ repo: "acme/web" }, state, [])).toBe(true);
    expect(pushedEventTouches({ repo: "acme/api" }, state, [])).toBe(false);
  });

  it("matches a PR a thread is bound to, follows or waits on in another repository", () => {
    const elsewhere = { repo: "acme/api", number: 3 };
    const event = { repo: "acme/api", number: 3 };
    expect(pushedEventTouches(event, state, [{ boundPr: elsewhere }])).toBe(true);
    expect(pushedEventTouches(event, state, [{ extraPrs: [elsewhere] }])).toBe(true);
    expect(pushedEventTouches(event, state, [{}], [elsewhere])).toBe(true);
    expect(pushedEventTouches(event, state, [{}])).toBe(false);
    expect(pushedEventTouches(event, undefined, [])).toBe(false);
  });
});

describe("pushed repository events", () => {
  it.effect("stop the sweeps asking GitHub, and an event reads the checkout it names", () =>
    Effect.gen(function* () {
      const events = yield* RepoEvents;
      yield* openThread("/work/a");
      yield* openThread("/work/b");
      const before = remote.length;

      // Twenty sweeps come and go, with the PR's checks pending, and none asks GitHub.
      yield* pass(Duration.minutes(5));
      expect(remote.length).toBe(before);

      // A check finished on the PR both checkouts show: both are read, once each, for a burst.
      expect(yield* events.pushed({ repo: "acme/web", number: 7 })).toBe(2);
      expect(yield* events.pushed({ repo: "acme/web", number: 7 })).toBe(2);
      expect(yield* events.pushed({ repo: "acme/web", branch: "feat" })).toBe(2);
      yield* pass(Duration.seconds(3));
      yield* waitFor(
        "both checkouts read",
        Effect.sync(() => remote.length >= before + 2),
      );
      expect(remote.length).toBe(before + 2);

      // Another repository's event, or another PR's, reads nothing.
      expect(yield* events.pushed({ repo: "acme/api", number: 7 })).toBe(0);
      expect(yield* events.pushed({ repo: "acme/web", number: 8 })).toBe(0);
      yield* pass(Duration.seconds(30));
      expect(remote.length).toBe(before + 2);
    }).pipe(Effect.scoped, Effect.provide(layer("pushed"))),
  );

  it.effect("keep reads of one checkout apart, however many events name it", () =>
    Effect.gen(function* () {
      const events = yield* RepoEvents;
      yield* openThread("/work/f");
      const before = readsOf("/work/f");
      // An event a second for ten seconds: a read every five at most.
      for (let second = 0; second < 10; second++) {
        yield* events.pushed({ repo: "acme/web" });
        yield* pass(Duration.seconds(1));
      }
      const reads = readsOf("/work/f") - before;
      expect(reads).toBeGreaterThanOrEqual(1);
      expect(reads).toBeLessThanOrEqual(2);
      // The last events are still owed their read.
      yield* pass(Duration.seconds(6));
      expect(readsOf("/work/f") - before).toBe(reads + 1);
    }).pipe(Effect.scoped, Effect.provide(layer("pushed"))),
  );

  it.effect("still reconcile now and then, for an event that never arrived", () =>
    Effect.gen(function* () {
      yield* openThread("/work/c");
      const before = readsOf("/work/c");
      yield* pass(Duration.sum(PUSHED_RECONCILE_EVERY, Duration.minutes(1)));
      yield* waitFor(
        "the reconcile",
        Effect.sync(() => readsOf("/work/c") > before),
      );
      expect(readsOf("/work/c")).toBe(before + 1);
    }).pipe(Effect.scoped, Effect.provide(layer("pushed"))),
  );

  it.effect("change nothing while the hosted features setting is off", () =>
    Effect.gen(function* () {
      hosted = false;
      yield* openThread("/work/d");
      const before = remote.length;
      // Pending checks are asked about on every sweep, as ever.
      yield* pass(Duration.minutes(1));
      expect(remote.length - before).toBeGreaterThanOrEqual(3);
    }).pipe(Effect.scoped, Effect.provide(layer("pushed"))),
  );

  it.effect("change nothing where events aren't pushed", () =>
    Effect.gen(function* () {
      yield* openThread("/work/e");
      // An event told anyway reads nothing: the sweeps are asking.
      expect(yield* (yield* RepoEvents).pushed({ repo: "acme/web", number: 7 })).toBe(0);
      const before = remote.length;
      yield* pass(Duration.minutes(1));
      expect(remote.length - before).toBeGreaterThanOrEqual(3);
    }).pipe(Effect.scoped, Effect.provide(layer("poll"))),
  );
});
