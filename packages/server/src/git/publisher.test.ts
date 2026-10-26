import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { GitState, PrStatus, ServerEvent } from "@gram/contracts";
import {
  Pr,
  prChecksStamp,
  PrLookupError,
  Proc,
  ProcLive,
  type PrDetail,
  samePathKey,
  type SeenChecks,
} from "@gram/git";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { EventHub } from "../events/event-hub.ts";
import { gatedHubLayer, makePublishGate, type PublishGate } from "../events/gated-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { GitRefresh, gitPlatformTest } from "./platform.ts";
import { testTools } from "./test-tools.ts";
import {
  ciMessage,
  GitStatePublisher,
  GitStatePublisherLive,
  PARKED_LOOKUP_EVERY,
  WORK_ELSEWHERE_SWEEPS,
} from "./publisher.ts";
import {
  eventually,
  hasGit,
  makeRepo,
  removeDir,
  removeDirStrict,
  run,
  tempDir,
  write,
} from "./test-repo.ts";

const badge = (overrides: Partial<PrStatus> = {}): PrStatus => ({
  number: 7,
  state: "OPEN",
  url: "u",
  title: "t",
  isDraft: false,
  checks: "pending",
  headMatches: true,
  aheadOfPr: false,
  ...overrides,
});

const detail: PrDetail = {
  number: 7,
  state: "OPEN",
  url: "u",
  title: "t",
  body: "",
  isDraft: false,
  author: "octocat",
  baseRefName: "main",
  headRefName: "feat",
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  commits: 1,
  reviewDecision: "",
  reviews: 0,
  checks: "failing",
  checksPassed: 1,
  checksTotal: 2,
  checkRuns: [
    { name: "build", status: "failing", link: "" },
    { name: "lint", status: "passing", link: "" },
  ],
  commitList: [],
  conversation: [],
  files: [],
  reviewRequests: [],
  latestReviews: [],
  labels: [],
};

const WEB_7 = "https://github.com/acme/web/pull/7";
const LIB_42 = "https://github.com/acme/lib/pull/42";

/**
 * `badge`: the branch's PR; `bound`: what a lookup by repo and number returns, unless
 * `boundFails`, when that lookup fails as an unreachable GitHub's does.
 */
const current: {
  badge: PrStatus | undefined;
  bound: PrStatus | undefined;
  boundFails?: boolean;
  /** What `Pr.seenChecks` answers for every PR. */
  seen?: SeenChecks | undefined;
} = {
  badge: undefined,
  bound: undefined,
};

/** Branch PR lookups, one per remote refresh that reads the checkout. */
const branchLookups = { count: 0 };
/** Lookups of a PR by repo and number. */
const boundLookups = { count: 0 };

const MockPr = Layer.succeed(Pr, {
  status: (_cwd, bound) =>
    Effect.sync(() => {
      if (bound !== undefined) {
        boundLookups.count++;
        return current.boundFails === true ? undefined : current.bound;
      }
      branchLookups.count++;
      return current.badge;
    }).pipe(
      Effect.flatMap((found) =>
        bound !== undefined && current.boundFails === true
          ? Effect.fail(new PrLookupError({ message: "unreachable" }))
          : Effect.succeed(found),
      ),
    ),
  checks: () => Effect.succeed(detail.checkRuns),
  prime: () => Effect.void,
  seenChecks: () => Effect.sync(() => current.seen),
  detail: () => Effect.succeed({ available: true, detail }),
});

/** Each checkout's own PR, by `samePathKey`, for `PerCheckoutPr`. */
const badgesAt = new Map<string, PrStatus>();

/** Branch lookups answered per checkout from `badgesAt`; nothing is bound. */
const PerCheckoutPr = Layer.succeed(Pr, {
  status: (cwd, bound) =>
    Effect.sync(() => (bound === undefined ? badgesAt.get(samePathKey(cwd)) : undefined)),
  checks: () => Effect.succeed([]),
  prime: () => Effect.void,
  seenChecks: () => Effect.succeed(undefined),
  detail: () => Effect.succeed({ available: false }),
});

/** Where `GatedPr`'s branch lookups wait, when a test sets one. */
const lookupGate: { current: PublishGate | undefined } = { current: undefined };

/** `MockPr` whose branch lookups wait at `lookupGate`: a refresh held inside git, under its lock. */
const GatedPr = Layer.succeed(Pr, {
  status: (_cwd, bound) =>
    Effect.gen(function* () {
      if (bound !== undefined) return current.bound;
      const gate = lookupGate.current;
      if (gate !== undefined) {
        yield* Deferred.succeed(gate.started, undefined);
        yield* Deferred.await(gate.gate);
      }
      return current.badge;
    }),
  checks: () => Effect.succeed(detail.checkRuns),
  prime: () => Effect.void,
  seenChecks: () => Effect.succeed(undefined),
  detail: () => Effect.succeed({ available: true, detail }),
});

/**
 * A thread on `root` whose first queued remote refresh is held at `gate` while an observer sees its
 * pending checks; `held` records how that refresh ended.
 */
const heldRefresh = (root: string, gate: PublishGate) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const publisher = yield* GitStatePublisher;
    const refreshes = yield* GitRefresh;
    const thread = yield* runtimes.create({
      projectRoot: root,
      checkout: { kind: "main", path: root },
    });
    yield* eventually("the first git.state", publisher.stateFor(root));
    const held = { finished: false, interrupted: false };
    yield* publisher.observe({
      onState: (_thread, state) =>
        state.pr?.checks !== "pending"
          ? Effect.void
          : Effect.gen(function* () {
              yield* Deferred.succeed(gate.started, undefined);
              yield* Deferred.await(gate.gate);
              held.finished = true;
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  held.interrupted = true;
                }),
              ),
            ),
      onRound: () => Effect.void,
    });
    current.badge = badge({ checks: "pending" });
    yield* refreshes.request(root, true);
    yield* Deferred.await(gate.started);
    return { thread, held, lookupsBefore: branchLookups.count };
  });

/** Queues `times` remote refreshes for `root` and lets the publisher take them. */
const requestMeanwhile = (root: string, times: number) =>
  Effect.gen(function* () {
    const refreshes = yield* GitRefresh;
    for (let i = 0; i < times; i++) yield* refreshes.request(root, true);
    yield* waitFor(
      "the requests taken",
      Queue.size(refreshes.requests).pipe(Effect.map((size) => size === 0)),
    );
    yield* Effect.sleep("50 millis");
  });

const lookups = { calls: 0, inFlight: 0, peak: 0, checkouts: new Set<string>() };

/**
 * Holds each PR lookup until three overlap or half a second passes, so a sweep without a cap of two
 * shows a higher `lookups.peak` even when slow git staggers the refreshes.
 */
const CountingPr = Layer.succeed(Pr, {
  status: (cwd) =>
    Effect.gen(function* () {
      lookups.calls++;
      lookups.checkouts.add(cwd);
      lookups.inFlight++;
      lookups.peak = Math.max(lookups.peak, lookups.inFlight);
      const deadline = Date.now() + 500;
      while (lookups.inFlight < 3 && Date.now() < deadline) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      }
      lookups.inFlight--;
      return undefined;
    }),
  checks: () => Effect.succeed([]),
  prime: () => Effect.void,
  seenChecks: () => Effect.succeed(undefined),
  detail: () => Effect.succeed({ available: false }),
});

/** The working directory of every process the platform starts while a test collects them. */
const gitRuns = { cwds: [] as Array<string> };

const CountingProc = Layer.effect(
  Proc,
  Effect.map(Effect.service(Proc), (proc) =>
    Proc.of({
      run: (bin, args, options) =>
        Effect.suspend(() => {
          gitRuns.cwds.push(options.cwd);
          return proc.run(bin, args, options);
        }),
    }),
  ),
).pipe(Layer.provide(ProcLive));

const publisherLayer = (config: Parameters<typeof gitPlatformTest>[0] = {}) =>
  GitStatePublisherLive.pipe(
    Layer.provideMerge(RuntimeTestLayer),
    Layer.provideMerge(gitPlatformTest({ pr: MockPr, ...config })),
  );

/** Direct lookup tests control authentication instead of depending on the host's gh login. */
const directLookupLayer = (ghReady: boolean) =>
  GitStatePublisherLive.pipe(
    Layer.provideMerge(RuntimeTestLayer),
    Layer.provideMerge(
      gitPlatformTest({
        pr: MockPr,
        tools: testTools({ git: true, gh: ghReady ? "ready" : "signed-out", claude: false }),
      }),
    ),
  );

/** The gate the publisher's "merged" notice waits on, when a test sets one. */
const mergedNoticeGate: { current: PublishGate | undefined } = { current: undefined };

/** The publisher with its "merged" notices held at `mergedNoticeGate`. */
const gatedPublisherLayer = GitStatePublisherLive.pipe(
  Layer.provide(
    gatedHubLayer(
      (event) => event.type === "notify" && event.title.endsWith(" merged"),
      () => mergedNoticeGate.current,
    ),
  ),
  Layer.provideMerge(RuntimeTestLayer),
  Layer.provideMerge(gitPlatformTest({ pr: MockPr })),
);

/** The gate the next completion write waits on, when a test sets one; taken by that write. */
const completionGate: { current: PublishGate | undefined } = { current: undefined };

/** The publisher with its next completion write held at `completionGate`, its check queued. */
const gatedCompletionLayer = GitStatePublisherLive.pipe(
  Layer.provide(
    Layer.effect(
      ThreadRuntimes,
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        return ThreadRuntimes.of({
          ...runtimes,
          updateCompletion: (threadId, change) =>
            Effect.gen(function* () {
              const gate = completionGate.current;
              if (gate !== undefined) {
                completionGate.current = undefined;
                yield* Deferred.succeed(gate.started, undefined);
                yield* Deferred.await(gate.gate);
              }
              return yield* runtimes.updateCompletion(threadId, change);
            }),
        });
      }),
    ),
  ),
  Layer.provideMerge(RuntimeTestLayer),
  Layer.provideMerge(gitPlatformTest({ pr: MockPr })),
);

describe("ciMessage", () => {
  it("fires only when pending checks settle", () => {
    expect(ciMessage(undefined, "failing", ["build"], 7)).toBeUndefined();
    expect(ciMessage("passing", "failing", ["build"], 7)).toBeUndefined();
    expect(ciMessage("pending", "pending", [], 7)).toBeUndefined();
    expect(ciMessage("pending", "passing", [], 7)).toBe("CI passed on #7");
    expect(ciMessage("pending", "failing", ["build", "lint"], 7)).toBe(
      "CI failed on #7: build, lint",
    );
    expect(ciMessage("pending", "failing", [], 7)).toBe("CI failed on #7");
  });
});

describe.skipIf(!hasGit)("GitStatePublisher", () => {
  it.live("records direct watched lookups before notifying observers and suppresses repeats", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      const ref = { repo: "acme/lib", number: 42 };
      const seen: Array<PrStatus> = [];
      yield* publisher.watchPrs("dependency", [{ ...ref, threadId: thread.id }]);
      yield* publisher.observe({
        onState: () => Effect.void,
        onRound: () => Effect.void,
        onWatchedPr: (observed) =>
          Effect.gen(function* () {
            expect(yield* publisher.watchedBadge(ref)).toEqual(observed);
            seen.push(observed);
          }),
      });
      current.bound = badge({ number: 42, url: LIB_42 });
      expect(yield* publisher.lookupPr(thread, ref)).toEqual(Option.some(current.bound));
      yield* publisher.lookupPr(thread, ref);
      expect(seen).toEqual([current.bound]);
      current.bound = badge({ number: 42, url: LIB_42, checks: "passing" });
      yield* publisher.lookupPr(thread, ref);
      expect(seen).toHaveLength(2);
      yield* publisher.watchPrs("dependency", []);
      expect(yield* publisher.watchedBadge(ref)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(directLookupLayer(true))),
  );

  it.live("refuses direct lookups before calling Pr when gh is not ready", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* eventually("the first git.state", publisher.stateFor(root));
      const ref = { repo: "acme/lib", number: 42 };
      const seen: Array<PrStatus> = [];
      yield* publisher.watchPrs("dependency", [{ ...ref, threadId: thread.id }]);
      yield* publisher.observe({
        onState: () => Effect.void,
        onRound: () => Effect.void,
        onWatchedPr: (observed) => Effect.sync(() => seen.push(observed)),
      });
      current.bound = badge({ number: 42, url: LIB_42 });
      const before = boundLookups.count;
      expect(yield* publisher.lookupPr(thread, ref)).toEqual(Option.none());
      expect(boundLookups.count).toBe(before);
      expect(yield* publisher.watchedBadge(ref)).toBeUndefined();
      expect(seen).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(directLookupLayer(false))),
  );

  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
    current.badge = undefined;
    current.bound = undefined;
    current.seen = undefined;
    badgesAt.clear();
    lookupGate.current = undefined;
  });
  const repo = () => {
    const dir = tempDir();
    dirs.push(dir);
    return makeRepo(dir);
  };

  it.live("publishes git.state for an open thread's checkout, then again after an edit", () =>
    Effect.gen(function* () {
      const root = repo();
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const events = yield* Queue.unbounded<ServerEvent>();
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      const states: Array<GitState> = [];
      const nextState = eventually(
        "git.state",
        Effect.gen(function* () {
          const drained = yield* Queue.clear(events);
          for (const event of drained) {
            if (event.type === "git.state" && event.threadId === thread.id)
              states.push(event.state);
          }
          return states.at(-1);
        }),
      );
      expect(yield* nextState).toMatchObject({ repo: true, branch: "main", changedFiles: 0 });
      write(nodePath.join(root, "new.txt"), "x\n");
      const edited = yield* eventually(
        "edited git.state",
        nextState.pipe(Effect.map((state) => state.changedFiles === 1 && state)),
      );
      expect(edited.changedFiles).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(publisherLayer())),
  );

  // Windows won't delete a watched folder, as a user deleting it outside Gram finds.
  it.live.skipIf(process.platform === "win32")(
    "marks a deleted worktree missing, keeps its PR looked up, and clears it once back",
    () =>
      Effect.gen(function* () {
        const root = repo();
        run(root, "remote", "add", "origin", "https://github.com/acme/web.git");
        const tree = nodePath.join(root, ".worktrees", "feat");
        run(root, "worktree", "add", "-q", "-b", "feat", tree);
        const runtimes = yield* ThreadRuntimes;
        const publisher = yield* GitStatePublisher;
        const thread = yield* runtimes.create({
          projectRoot: root,
          checkout: { kind: "worktree", path: tree, branch: "feat", repoRoot: root },
        });
        current.badge = badge({ checks: "pending", headRefOid: "h1" });
        yield* publisher.refresh(tree, { remote: true });
        const shown = () => publisher.stateForThread(thread);
        yield* eventually(
          "the PR badge",
          shown().pipe(Effect.map((state) => state?.pr?.checks === "pending")),
        );

        removeDirStrict(tree);
        // The branch lookup needs the folder: the PR is asked about by number instead, which isn't
        // anchored to the branch, so the anchoring the branch lookup found is kept.
        current.bound = badge({
          state: "MERGED",
          checks: "passing",
          headRefOid: "h1",
          headMatches: false,
        });
        yield* publisher.refresh(tree, { remote: true });
        const missing = yield* eventually(
          "the missing state",
          shown().pipe(Effect.map((state) => state?.missing === true && state)),
        );
        expect(missing).toMatchObject({ branch: "feat", origin: "acme/web" });
        expect(missing.pr).toMatchObject({ state: "MERGED", headMatches: true });
        // Unbound, a merged PR the checkout matched still completes the thread.
        const store = yield* ThreadStore;
        yield* waitFor(
          "the settle",
          store.getCompletedReason(thread.id).pipe(Effect.map((r) => r === "prMerged")),
        );

        run(root, "worktree", "prune");
        run(root, "worktree", "add", "-q", tree, "feat");
        yield* publisher.refresh(tree, { remote: false });
        const back = yield* eventually(
          "the state back",
          shown().pipe(
            Effect.map((state) => state !== undefined && state.missing !== true && state),
          ),
        );
        expect(back).toMatchObject({ repo: true, branch: "feat" });
      }).pipe(Effect.scoped, Effect.provide(publisherLayer())),
  );

  it.live("stops watching a held checkout until the hold is released", () =>
    Effect.gen(function* () {
      const root = repo();
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const events = yield* Queue.unbounded<ServerEvent>();
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      const stateOf = (event: ServerEvent) =>
        event.type === "git.state" && event.threadId === thread.id ? event.state : undefined;
      const published = (changedFiles: number) =>
        eventually(
          `git.state with ${changedFiles} changed files`,
          Queue.clear(events).pipe(
            Effect.map((drained) => drained.some((e) => stateOf(e)?.changedFiles === changedFiles)),
          ),
        );
      yield* published(0);

      const release = yield* publisher.hold(root);
      yield* Queue.clear(events);
      write(nodePath.join(root, "held.txt"), "x\n");
      // Well past the watcher's debounce: nothing is watching the held checkout.
      yield* Effect.sleep("1500 millis");
      expect((yield* Queue.clear(events)).filter((e) => stateOf(e) !== undefined)).toEqual([]);

      yield* release;
      yield* published(1);
    }).pipe(Effect.scoped, Effect.provide(publisherLayer())),
  );

  // Five repos and threads on slow Windows git, then the held lookups, need more than the default.
  it.live(
    "sweeps checkouts a few at a time, so the git processes it starts stay bounded",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const publisher = yield* GitStatePublisher;
        const roots: Array<string> = [];
        for (let i = 0; i < 5; i++) {
          const root = repo();
          roots.push(root);
          yield* runtimes.create({ projectRoot: root, checkout: { kind: "main", path: root } });
        }
        // Every checkout's first local state, so the sweep doesn't race the watches starting.
        for (const root of roots)
          yield* eventually("the first git.state", publisher.stateFor(root));
        Object.assign(lookups, { calls: 0, inFlight: 0, peak: 0, checkouts: new Set<string>() });

        // A refresh whose local git fails under load skips its lookup, so sweep until each checkout
        // has been looked up.
        const deadline = Date.now() + 30_000;
        do {
          yield* publisher.sweep;
        } while (lookups.checkouts.size < roots.length && Date.now() < deadline);
        expect(
          lookups.checkouts.size,
          `checkouts looked up in ${lookups.calls} lookups: ${[...lookups.checkouts].join(", ")}`,
        ).toBe(roots.length);
        // Slow git can stagger refreshes below the cap, never above it.
        expect(lookups.peak, `peak across ${lookups.calls} lookups`).toBeLessThanOrEqual(2);
      }).pipe(Effect.provide(publisherLayer({ pr: CountingPr, config: { sweepConcurrency: 2 } }))),
    60_000,
  );

  it.live("scans other worktrees for uncommitted work every few sweeps, carrying the answer", () =>
    Effect.gen(function* () {
      const root = repo();
      const sibling = nodePath.join(nodePath.dirname(root), "feat-tree");
      run(root, "worktree", "add", "-q", "-b", "feat", sibling);
      write(nodePath.join(sibling, "wip.txt"), "work in progress");
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      yield* runtimes.create({ projectRoot: root, checkout: { kind: "main", path: root } });
      yield* eventually("the first git.state", publisher.stateFor(root));
      const advised = publisher
        .stateFor(root)
        .pipe(Effect.map((state) => state?.workElsewhere?.branch));

      yield* publisher.sweep;
      expect(yield* advised).toBe("feat");
      removeDir(nodePath.join(sibling, "wip.txt"));
      for (let i = 1; i < WORK_ELSEWHERE_SWEEPS; i++) yield* publisher.sweep;
      expect(yield* advised).toBe("feat");
      yield* publisher.sweep;
      expect(yield* advised).toBeUndefined();
    }).pipe(Effect.provide(publisherLayer())),
  );

  it.live("points at a tracked worktree's PR from the next sweep on, between scan passes too", () =>
    Effect.gen(function* () {
      const root = repo();
      run(root, "remote", "add", "origin", "https://github.com/acme/web.git");
      const trees = ["a", "b"].map((branch) => {
        const tree = nodePath.join(root, ".worktrees", branch);
        run(root, "worktree", "add", "-q", "-b", branch, tree);
        return tree;
      });
      const [a, b] = trees as [string, string];
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      // On every worktree, so the repo's open PRs needn't be listed for one no thread tracks.
      yield* runtimes.create({ projectRoot: root, checkout: { kind: "main", path: root } });
      yield* eventually("the first git.state", publisher.stateFor(root));
      for (const [index, tree] of trees.entries()) {
        const branch = index === 0 ? "a" : "b";
        yield* runtimes.create({
          projectRoot: root,
          checkout: { kind: "worktree", path: tree, branch, repoRoot: root },
        });
        yield* eventually("the first git.state", publisher.stateFor(tree));
      }
      const cue = publisher.stateFor(a).pipe(Effect.map((state) => state?.prElsewhere?.number));

      yield* publisher.sweep;
      expect(yield* cue).toBeUndefined();
      badgesAt.set(samePathKey(b), badge({ url: WEB_7 }));
      yield* publisher.sweep;
      expect(yield* cue).toBe(7);
      badgesAt.set(samePathKey(b), badge({ url: WEB_7, state: "MERGED" }));
      yield* publisher.sweep;
      expect(yield* cue).toBeUndefined();
    }).pipe(Effect.provide(publisherLayer({ pr: PerCheckoutPr }))),
  );

  it.live("badges, monitors and settles a PR bound from another repo", () =>
    Effect.gen(function* () {
      const root = repo();
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const events = yield* Queue.unbounded<ServerEvent>();
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/lib", number: 42, monitor: true },
      }));

      // The branch has no PR; the bound one lives in another repo.
      current.bound = badge({ number: 42, url: LIB_42, checks: "pending", headMatches: false });
      yield* publisher.refresh(root, { remote: true });
      const badged = yield* eventually(
        "the bound PR's badge",
        Queue.clear(events).pipe(
          Effect.map((drained) =>
            drained.some(
              (e) =>
                e.type === "git.state" && e.threadId === thread.id && e.state.pr?.number === 42,
            ),
          ),
        ),
      );
      expect(badged).toBe(true);
      // The checkout's own state never carries it, so a caller after this thread's PR asks by thread.
      expect((yield* publisher.stateFor(root))?.pr).toBeUndefined();
      const bound = yield* store.getThread(thread.id);
      expect(yield* publisher.badgeFor(bound)).toMatchObject({ number: 42, checks: "pending" });
      expect(yield* publisher.badgeFor(thread)).toBeUndefined();

      current.bound = badge({ number: 42, url: LIB_42, checks: "failing", headMatches: false });
      yield* publisher.refresh(root, { remote: true });
      const sent = yield* eventually(
        "the CI message",
        fake
          .latest(thread.id)
          .pipe(Effect.map((s) => s.sent.find((input) => input.text.startsWith("CI")))),
      );
      expect(sent.text).toBe("CI failed on #42: build");

      current.bound = badge({
        number: 42,
        url: LIB_42,
        state: "MERGED",
        checks: "passing",
        headMatches: false,
      });
      yield* publisher.refresh(root, { remote: true });
      yield* waitFor(
        "the settle",
        store.getCompletedReason(thread.id).pipe(Effect.map((r) => r === "prMerged")),
      );
    }).pipe(Effect.scoped, Effect.provide(publisherLayer())),
  );

  it.live("sends an orchestrator its checkout's state without the PR, and never settles it", () =>
    Effect.gen(function* () {
      const root = repo();
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const store = yield* ThreadStore;
      const events = yield* Queue.unbounded<ServerEvent>();
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const created = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      const thread = yield* runtimes.updateThread(created.id, (t) => ({
        ...t,
        role: "orchestrator",
      }));
      const sentTo = (drained: ReadonlyArray<ServerEvent>) =>
        drained.flatMap((e) =>
          e.type === "git.state" && e.threadId === thread.id ? [e.state] : [],
        );

      current.badge = badge({ url: WEB_7, checks: "failing" });
      yield* publisher.refresh(root, { remote: true });
      yield* eventually(
        "the checkout's PR",
        publisher.stateFor(root).pipe(Effect.map((state) => state?.pr)),
      );
      const seen = sentTo(yield* Queue.clear(events));
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((state) => state.pr === undefined)).toBe(true);
      expect(yield* publisher.badgeFor(thread)).toBeUndefined();

      current.badge = badge({ url: WEB_7, state: "MERGED", checks: "passing" });
      yield* publisher.refresh(root, { remote: true });
      yield* eventually(
        "the merged PR",
        publisher
          .stateFor(root)
          .pipe(Effect.map((state) => (state?.pr?.state === "MERGED" ? true : undefined))),
      );
      expect(yield* store.getCompletedReason(thread.id)).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(publisherLayer())),
  );

  it.live("badges and monitors an extra PR beside the thread's own, without settling on it", () =>
    Effect.gen(function* () {
      const root = repo();
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const events = yield* Queue.unbounded<ServerEvent>();
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: false },
        extraPrs: [{ repo: "acme/lib", number: 42, monitor: true }],
      }));

      current.badge = badge({ checks: "passing" });
      current.bound = badge({ number: 42, url: LIB_42, checks: "pending", headMatches: false });
      yield* publisher.refresh(root, { remote: true });
      const badged = yield* eventually(
        "both badges",
        Queue.clear(events).pipe(
          Effect.map((drained) =>
            drained.some(
              (e) =>
                e.type === "git.state" &&
                e.threadId === thread.id &&
                e.state.pr?.number === 7 &&
                e.state.extraPrs?.[0]?.number === 42,
            ),
          ),
        ),
      );
      expect(badged).toBe(true);
      // The extra's badge is the thread's own, which the checkout's state doesn't carry.
      const extras = yield* publisher.extraBadgesFor(yield* store.getThread(thread.id));
      expect(extras.map((each) => each.number)).toEqual([42]);

      current.bound = badge({ number: 42, url: LIB_42, checks: "failing", headMatches: false });
      yield* publisher.refresh(root, { remote: true });
      const sent = yield* eventually(
        "the extra PR's CI message",
        fake
          .latest(thread.id)
          .pipe(Effect.map((s) => s.sent.find((input) => input.text.startsWith("CI")))),
      );
      expect(sent.text).toBe("CI failed on #42: build");

      // Merging a PR the thread only follows isn't the thread's work being done.
      current.bound = badge({
        number: 42,
        url: LIB_42,
        state: "MERGED",
        checks: "passing",
        headMatches: false,
      });
      yield* publisher.refresh(root, { remote: true });
      expect(yield* store.getCompletedReason(thread.id)).toBeUndefined();

      // GitHub answering "no such PR" (deleted, or access lost) drops the badge; it isn't carried.
      current.bound = undefined;
      yield* publisher.refresh(root, { remote: true });
      const gone = yield* eventually(
        "the missing PR's badge to go",
        Queue.clear(events).pipe(
          Effect.map((drained) =>
            drained.some(
              (e) =>
                e.type === "git.state" &&
                e.threadId === thread.id &&
                e.state.extraPrs === undefined,
            ),
          ),
        ),
      );
      expect(gone).toBe(true);
      current.bound = badge({
        number: 42,
        url: LIB_42,
        state: "MERGED",
        checks: "passing",
        headMatches: false,
      });
      yield* publisher.refresh(root, { remote: true });

      // Unfollowing drops its badge on the next network pass.
      yield* runtimes.updateThread(thread.id, (t) => {
        const { extraPrs, ...rest } = t;
        void extraPrs;
        return rest;
      });
      yield* publisher.refresh(root, { remote: true });
      const dropped = yield* eventually(
        "the row to go",
        Queue.clear(events).pipe(
          Effect.map((drained) =>
            drained.some(
              (e) =>
                e.type === "git.state" &&
                e.threadId === thread.id &&
                e.state.extraPrs === undefined,
            ),
          ),
        ),
      );
      expect(dropped).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(publisherLayer())),
  );

  it.live("steers a CI message into a running turn whose agent can take it", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
        input: { text: "work" },
      });
      const session = yield* eventually(
        "the running turn",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: true },
      }));

      current.badge = badge({ checks: "pending" });
      yield* publisher.refresh(root, { remote: true });
      current.badge = badge({ checks: "failing" });
      yield* publisher.refresh(root, { remote: true });
      const steered = yield* eventually(
        "the steered CI message",
        Effect.sync(() => session.steered[0]),
      );
      expect(steered.text).toBe("CI failed on #7: build");
      expect(session.sent.map((i) => i.text)).toEqual(["work"]);
    }).pipe(Effect.scoped, Effect.provide(publisherLayer())),
  );

  it.live("replaces a queued CI message with the next settle, and leaves the user's be", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const fake = yield* FakeAgentControl;
      yield* fake.setSteerCapability(false);
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
        input: { text: "work" },
      });
      yield* eventually(
        "the running turn",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1)),
      );
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: true },
      }));
      const queue = runtimes.snapshot.pipe(
        Effect.map((all) =>
          (all.find((s) => s.thread.id === thread.id)?.queue ?? []).map((q) => q.input.text),
        ),
      );

      current.badge = badge({ checks: "pending" });
      yield* publisher.refresh(root, { remote: true });
      current.badge = badge({ checks: "failing" });
      yield* publisher.refresh(root, { remote: true });
      yield* eventually(
        "the queued CI message",
        queue.pipe(Effect.map((texts) => texts.length === 1)),
      );
      yield* runtimes.send(thread.id, { text: "mine" });

      current.badge = badge({ checks: "pending" });
      yield* publisher.refresh(root, { remote: true });
      current.badge = badge({ checks: "passing" });
      yield* publisher.refresh(root, { remote: true });
      const replaced = yield* eventually(
        "the newer CI message",
        queue.pipe(Effect.map((texts) => texts[0] === "CI passed on #7" && texts)),
      );
      expect(replaced).toEqual(["CI passed on #7", "mine"]);

      // Rebinding to another watched PR takes back what the old one queued.
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 8, monitor: true },
      }));
      const left = yield* eventually(
        "the CI message to go",
        queue.pipe(Effect.map((texts) => texts.length === 1 && texts)),
      );
      expect(left).toEqual(["mine"]);
    }).pipe(Effect.scoped, Effect.provide(publisherLayer())),
  );

  it.live("sends a CI message when monitored checks settle, and settles on a merged PR", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: true },
      }));

      current.badge = badge({ checks: "pending" });
      yield* publisher.refresh(root, { remote: true });
      current.badge = badge({ checks: "failing" });
      yield* publisher.refresh(root, { remote: true });
      const sent = yield* eventually(
        "the CI message",
        fake
          .latest(thread.id)
          .pipe(Effect.map((s) => s.sent.find((input) => input.text.startsWith("CI")))),
      );
      expect(sent.text).toBe("CI failed on #7: build");

      current.badge = badge({ state: "MERGED", checks: "passing" });
      yield* publisher.refresh(root, { remote: true });
      yield* waitFor(
        "the settle",
        store.getCompletedReason(thread.id).pipe(Effect.map((r) => r === "prMerged")),
      );
      expect((yield* publisher.stateFor(root))?.pr?.state).toBe("MERGED");
    }).pipe(Effect.provide(publisherLayer())),
  );

  it.live("keeps sweeping an archived thread's open PR until it merges, then stops", () =>
    Effect.gen(function* () {
      const root = repo();
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const fake = yield* FakeAgentControl;
      const states: Array<GitState> = [];
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: true },
      }));
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "git.state" && event.threadId === thread.id)
              states.push(event.state);
          }),
        ),
        Effect.forkScoped,
      );
      current.badge = badge({ checks: "pending", url: WEB_7 });
      yield* publisher.refresh(root, { remote: true });
      yield* eventually(
        "the open badge",
        Effect.sync(() => states.at(-1)?.pr?.state === "OPEN"),
      );

      // Archived before any sweep saw the checks settle, then the merge.
      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
      yield* publisher.sync;
      current.badge = badge({ checks: "failing", url: WEB_7 });
      gitRuns.cwds = [];
      for (let i = 1; i < PARKED_LOOKUP_EVERY; i++) yield* publisher.sweep;
      // Not due: nothing runs in the archived checkout between lookups.
      expect(gitRuns.cwds.filter((cwd) => cwd === root)).toEqual([]);
      yield* publisher.sweep;
      expect(gitRuns.cwds).toContain(root);
      expect(states.at(-1)?.pr?.checks).toBe("failing");
      // The badge moves, but the archived agent isn't woken over its CI.
      yield* Effect.sleep("200 millis");
      const sent = yield* fake.latest(thread.id).pipe(
        Effect.map((session) => session.sent.map((input) => input.text)),
        Effect.catchCause(() => Effect.succeed([])),
      );
      expect(sent.filter((text) => text.startsWith("CI"))).toEqual([]);

      current.badge = badge({ state: "MERGED", checks: "passing", url: WEB_7 });
      for (let i = 0; i < PARKED_LOOKUP_EVERY; i++) yield* publisher.sweep;
      expect(states.at(-1)?.pr?.state).toBe("MERGED");
      yield* waitFor(
        "the settle",
        (yield* ThreadStore)
          .getCompletedReason(thread.id)
          .pipe(Effect.map((r) => r === "prMerged")),
      );

      // Merged is final: the archived thread isn't asked about again.
      const before = branchLookups.count;
      for (let i = 0; i < 2 * PARKED_LOOKUP_EVERY; i++) yield* publisher.sweep;
      expect(branchLookups.count).toBe(before);

      // Binding another PR while it's archived is a new question.
      current.bound = badge({
        number: 42,
        url: "https://github.com/acme/lib/pull/42",
        headMatches: false,
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/lib", number: 42, monitor: false },
      }));
      yield* publisher.sync;
      for (let i = 0; i < PARKED_LOOKUP_EVERY; i++) yield* publisher.sweep;
      expect(states.at(-1)?.pr?.number).toBe(42);
    }).pipe(Effect.scoped, Effect.provide(publisherLayer({ proc: CountingProc }))),
  );

  it.live("sweeps an archived thread it has no badge for yet, as after a restart", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
      // Completed by hand while its bound PR is still under review: completion says nothing of it.
      const other = repo();
      const completed = yield* runtimes.create({
        projectRoot: other,
        checkout: { kind: "main", path: other },
      });
      yield* runtimes.updateThread(completed.id, (t) => ({
        ...t,
        parked: true,
        boundPr: { repo: "acme/lib", number: 42, monitor: false },
      }));
      yield* runtimes.markCompleted(completed.id, "user");
      current.badge = badge({ state: "MERGED", checks: "passing" });
      current.bound = badge({
        number: 42,
        state: "MERGED",
        url: "https://github.com/acme/lib/pull/42",
        headMatches: false,
      });
      const bound: Array<GitState> = [];
      yield* (yield* EventHub)
        .serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] }))
        .pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === "git.state" && event.threadId === completed.id)
                bound.push(event.state);
            }),
          ),
          Effect.forkScoped,
        );

      // The publisher starts with the threads already archived, and no badge in memory.
      const services = yield* Layer.build(GitStatePublisherLive);
      const publisher = Context.get(services, GitStatePublisher);
      for (let i = 0; i < PARKED_LOOKUP_EVERY; i++) yield* publisher.sweep;
      yield* waitFor(
        "the settle",
        (yield* ThreadStore)
          .getCompletedReason(thread.id)
          .pipe(Effect.map((r) => r === "prMerged")),
      );
      expect(bound.at(-1)?.pr?.state).toBe("MERGED");
    }).pipe(
      Effect.scoped,
      Effect.provide(RuntimeTestLayer.pipe(Layer.provideMerge(gitPlatformTest({ pr: MockPr })))),
    ),
  );

  it.live("stops sweeping an archived thread rebound to a PR GitHub says doesn't exist", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const states: Array<GitState> = [];
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* (yield* EventHub)
        .serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] }))
        .pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === "git.state" && event.threadId === thread.id)
                states.push(event.state);
            }),
          ),
          Effect.forkScoped,
        );
      // The checkout has an open PR of its own, and the thread follows another, also open.
      current.badge = badge({ checks: "passing", url: WEB_7 });
      current.bound = badge({
        number: 41,
        url: "https://github.com/acme/lib/pull/41",
        headMatches: false,
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/lib", number: 41, monitor: false },
      }));
      yield* publisher.refresh(root, { remote: true });
      yield* eventually(
        "the bound badge",
        Effect.sync(() => states.at(-1)?.pr?.number === 41),
      );

      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        parked: true,
        boundPr: { repo: "acme/lib", number: 42, monitor: false },
      }));
      yield* publisher.sync;
      current.bound = undefined;
      for (let i = 0; i < 2 * PARKED_LOOKUP_EVERY; i++) yield* publisher.sweep;
      // Neither #41's carried badge nor the checkout's own open #7 keeps it swept, or stands in for
      // #42 on its row.
      expect(states.at(-1)).toBeDefined();
      expect(states.at(-1)?.pr).toBeUndefined();
      const answered = boundLookups.count;
      for (let i = 0; i < 3 * PARKED_LOOKUP_EVERY; i++) yield* publisher.sweep;
      expect(boundLookups.count).toBe(answered);
    }).pipe(Effect.scoped, Effect.provide(publisherLayer())),
  );

  it.live("cancels a CI message still waiting out its delay when the thread is archived", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: true },
      }));
      current.badge = badge({ checks: "pending", url: WEB_7 });
      yield* publisher.refresh(root, { remote: true });
      current.badge = badge({ checks: "failing", url: WEB_7 });
      yield* publisher.refresh(root, { remote: true });

      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
      yield* publisher.sync;
      yield* Effect.sleep("600 millis");
      const sent = yield* fake.latest(thread.id).pipe(
        Effect.map((session) => session.sent.map((input) => input.text)),
        Effect.catchCause(() => Effect.succeed([])),
      );
      expect(sent.filter((text) => text.startsWith("CI"))).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(publisherLayer({ config: { monitorSettleDelay: Duration.millis(300) } })),
    ),
  );

  it.live("sweeps an archived thread's bound PR though the checkout's own PR merged", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/lib", number: 42, monitor: false },
      }));
      // Merged at the checkout's HEAD, which on its own is never asked about again.
      const head = run(root, "rev-parse", "HEAD").trim();
      current.badge = badge({ state: "MERGED", checks: "passing", headRefOid: head });
      current.bound = badge({ number: 42, url: LIB_42, checks: "passing", headMatches: false });
      yield* publisher.refresh(root, { remote: true });
      const bound = yield* store.getThread(thread.id);
      yield* eventually(
        "the bound badge",
        publisher.badgeFor(bound).pipe(Effect.map((pr) => pr?.number === 42)),
      );

      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, parked: true }));
      yield* publisher.sync;
      current.bound = badge({
        number: 42,
        url: LIB_42,
        state: "MERGED",
        checks: "passing",
        headMatches: false,
      });
      for (let i = 0; i < PARKED_LOOKUP_EVERY; i++) yield* publisher.sweep;
      yield* waitFor(
        "the settle",
        store.getCompletedReason(thread.id).pipe(Effect.map((r) => r === "prMerged")),
      );
    }).pipe(Effect.scoped, Effect.provide(publisherLayer())),
  );

  it.live("looks the badge up again when a fresher read of its PR says another state", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      current.badge = badge({ checks: "passing" });
      yield* publisher.refresh(root, { remote: true });
      const before = branchLookups.count;

      // The same state as the badge asks nothing, and neither does another PR's.
      yield* publisher.reconcile(thread, { number: 7, url: "u", state: "OPEN" });
      yield* publisher.reconcile(thread, { number: 8, url: "u", state: "MERGED" });
      yield* Effect.sleep("200 millis");
      expect(branchLookups.count).toBe(before);

      current.badge = badge({ state: "MERGED", checks: "passing" });
      yield* publisher.reconcile(thread, { number: 7, url: "u", state: "MERGED" });
      yield* eventually(
        "the merged badge",
        publisher.stateFor(root).pipe(Effect.map((state) => state?.pr?.state === "MERGED")),
      );
    }).pipe(Effect.scoped, Effect.provide(publisherLayer())),
  );

  it.effect("tells the user once when the thread's PR merges", () =>
    Effect.gen(function* () {
      const root = repo();
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const notices: Array<Extract<ServerEvent, { type: "notify" }>> = [];
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "notify") notices.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));

      current.badge = badge({ state: "MERGED", checks: "passing" });
      yield* publisher.refresh(root, { remote: true });
      yield* publisher.refresh(root, { remote: true });
      yield* waitFor(
        "the notice",
        Effect.sync(() => notices.length > 0),
      );
      expect(notices).toEqual([
        {
          type: "notify",
          kind: "done",
          title: "#7 merged",
          body: thread.title,
          threadId: thread.id,
        },
      ]);
    }).pipe(Effect.provide(publisherLayer())),
  );

  it.live("reopens a merged thread when work resumes, and settles again on its next PR", () =>
    Effect.gen(function* () {
      const root = repo();
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const store = yield* ThreadStore;
      const notices: Array<string> = [];
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "notify") notices.push(event.title);
          }),
        ),
        Effect.forkScoped,
      );
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      const reason = store.getCompletedReason(thread.id);

      current.badge = badge({ state: "MERGED", checks: "passing", url: WEB_7 });
      yield* publisher.refresh(root, { remote: true });
      yield* waitFor("the settle", reason.pipe(Effect.map((r) => r === "prMerged")));

      // Follow-up work: changes the merge didn't have. (This repo has no remote, so no base to
      // count a commit against.)
      write(nodePath.join(root, "follow-up.txt"), "more\n");
      yield* publisher.refresh(root, { remote: true });
      yield* waitFor("the reopen", reason.pipe(Effect.map((r) => r === undefined)));
      // The same merge doesn't settle it again, however often it is looked at.
      yield* publisher.refresh(root, { remote: false });
      yield* Effect.sleep("100 millis");
      expect(yield* reason).toBeUndefined();

      current.badge = badge({ number: 8, url: "https://github.com/acme/web/pull/8" });
      yield* publisher.refresh(root, { remote: true });
      current.badge = badge({
        number: 8,
        state: "MERGED",
        checks: "passing",
        url: "https://github.com/acme/web/pull/8",
      });
      yield* publisher.refresh(root, { remote: true });
      yield* waitFor("the second settle", reason.pipe(Effect.map((r) => r === "prMerged")));
      yield* waitFor(
        "both notices",
        Effect.sync(() => notices.length === 2),
      );
      expect(notices).toEqual(["#7 merged", "#8 merged"]);
      expect((yield* store.getThread(thread.id)).settledMerge?.merged).toEqual([
        { number: 7, url: WEB_7 },
        { number: 8, url: "https://github.com/acme/web/pull/8" },
      ]);
    }).pipe(Effect.provide(publisherLayer())),
  );

  it.live("settles on the branch's own PR merging while a merged PR from elsewhere is bound", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/lib", number: 42, monitor: false },
      }));
      const reason = store.getCompletedReason(thread.id);
      current.bound = badge({ number: 42, url: LIB_42, state: "MERGED", headMatches: false });
      current.badge = badge({ url: WEB_7 });
      yield* publisher.refresh(root, { remote: true });
      // The branch's PR is open: the bound one's merge leaves the thread unsettled.
      yield* Effect.sleep("200 millis");
      expect(yield* reason).toBeUndefined();

      // Only the branch's PR moves; what the thread is sent, the bound badge, stays as it was.
      const seen = { states: 0 };
      yield* publisher.observe({
        onState: (observed) =>
          Effect.sync(() => {
            if (observed.id === thread.id) seen.states++;
          }),
        onRound: () => Effect.void,
      });
      current.badge = badge({ url: WEB_7, state: "MERGED", checks: "passing" });
      yield* publisher.refresh(root, { remote: true });
      yield* waitFor("the settle", reason.pipe(Effect.map((r) => r === "prMerged")));
      // The ledger reads the branch's PR too, so its observers hear of the move.
      expect(seen.states).toBeGreaterThan(0);
    }).pipe(Effect.provide(publisherLayer())),
  );

  it.live("drops a completion queued before a rebind to the same number in another repo", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/old", number: 12, monitor: false },
      }));
      yield* publisher.sync;
      const gate = yield* makePublishGate;
      completionGate.current = gate;
      current.bound = badge({
        number: 12,
        url: "https://github.com/acme/old/pull/12",
        state: "MERGED",
        headMatches: false,
      });
      yield* publisher.refresh(root, { remote: true });
      yield* Deferred.await(gate.started);
      // Rebound while acme/old#12's merge waits to be written.
      yield* store.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/new", number: 12, monitor: false },
      }));
      yield* Deferred.succeed(gate.gate, undefined);
      yield* Effect.sleep("200 millis");
      const after = yield* store.getThread(thread.id);
      expect(after.completedReason).toBeUndefined();
      expect(after.settledMerge).toBeUndefined();
    }).pipe(
      Effect.ensuring(Effect.sync(() => (completionGate.current = undefined))),
      Effect.provide(gatedCompletionLayer),
    ),
  );

  it.live("drops a completion queued before the PRs it follows changed", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        extraPrs: [{ repo: "acme/lib", number: 42, monitor: false }],
      }));
      yield* publisher.sync;
      const gate = yield* makePublishGate;
      completionGate.current = gate;
      current.badge = badge({ state: "MERGED", checks: "passing", url: WEB_7 });
      current.bound = badge({ number: 42, url: LIB_42, state: "MERGED", headMatches: false });
      yield* publisher.refresh(root, { remote: true });
      yield* Deferred.await(gate.started);
      // Following #43 instead, whose badge hasn't come: it may be open, so nothing has merged.
      yield* store.updateThread(thread.id, (t) => ({
        ...t,
        extraPrs: [{ repo: "acme/lib", number: 43, monitor: false }],
      }));
      yield* Deferred.succeed(gate.gate, undefined);
      yield* Effect.sleep("200 millis");
      expect((yield* store.getThread(thread.id)).completedReason).toBeUndefined();
    }).pipe(
      Effect.ensuring(Effect.sync(() => (completionGate.current = undefined))),
      Effect.provide(gatedCompletionLayer),
    ),
  );

  it.live("settles once a followed PR GitHub couldn't be asked about turns out not to exist", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const store = yield* ThreadStore;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        extraPrs: [{ repo: "acme/lib", number: 42, monitor: false }],
      }));
      const reason = store.getCompletedReason(thread.id);
      current.badge = badge({ state: "MERGED", checks: "passing", url: WEB_7 });
      current.boundFails = true;
      yield* publisher.refresh(root, { remote: true });
      // #42 has no badge yet, so it may be open: the merge of #7 waits on it.
      yield* Effect.sleep("200 millis");
      expect(yield* reason).toBeUndefined();

      // Answered at last, with no such PR; nothing in the checkout's own state moves.
      current.boundFails = false;
      current.bound = undefined;
      yield* publisher.refresh(root, { remote: true });
      yield* waitFor("the settle", reason.pipe(Effect.map((r) => r === "prMerged")));
      // The thread's state says so, for the ledger and the sidebar, and keeps saying so after an edit.
      const shown = publisher.stateForThread(yield* store.getThread(thread.id));
      expect((yield* shown)?.missingPrs).toEqual([{ repo: "acme/lib", number: 42 }]);
      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, title: "renamed" }));
      yield* publisher.sync;
      expect((yield* shown)?.missingPrs).toEqual([{ repo: "acme/lib", number: 42 }]);
    }).pipe(
      Effect.ensuring(Effect.sync(() => delete current.boundFails)),
      Effect.provide(publisherLayer()),
    ),
  );

  it.effect("still settles a merged PR's thread when its refresh is interrupted", () =>
    Effect.gen(function* () {
      const root = repo();
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const notices: Array<Extract<ServerEvent, { type: "notify" }>> = [];
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "notify") notices.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
      mergedNoticeGate.current = yield* makePublishGate;

      // A newer refresh for the checkout replaces this one while the notice is being published.
      current.badge = badge({ state: "MERGED", checks: "passing" });
      const refresh = yield* publisher.refresh(root, { remote: true }).pipe(Effect.forkScoped);
      yield* Deferred.await(mergedNoticeGate.current.started);
      yield* Fiber.interrupt(refresh);
      yield* Deferred.succeed(mergedNoticeGate.current.gate, undefined);
      yield* waitFor(
        "the notice",
        Effect.sync(() => notices.length > 0),
      );
      mergedNoticeGate.current = undefined;

      expect(notices.map((n) => n.title)).toEqual(["#7 merged"]);
      const settled = yield* (yield* ThreadStore).getThread(thread.id);
      expect(settled.completedAt).toBeDefined();
    }).pipe(Effect.provide(gatedPublisherLayer)),
  );

  it.live("lets a queued refresh finish, then reruns once for the requests made during it", () =>
    Effect.gen(function* () {
      const root = repo();
      const publisher = yield* GitStatePublisher;
      const gate = yield* makePublishGate;
      const { held, lookupsBefore } = yield* heldRefresh(root, gate);

      current.badge = badge({ checks: "passing" });
      yield* requestMeanwhile(root, 3);
      expect(held).toEqual({ finished: false, interrupted: false });
      expect(branchLookups.count).toBe(lookupsBefore);

      yield* Deferred.succeed(gate.gate, undefined);
      yield* eventually(
        "the rerun's passing checks",
        publisher.stateFor(root).pipe(Effect.map((state) => state?.pr?.checks === "passing")),
      );
      yield* Effect.sleep("300 millis");
      expect(held).toEqual({ finished: true, interrupted: false });
      expect(branchLookups.count - lookupsBefore).toBe(1);
    }).pipe(Effect.provide(publisherLayer())),
  );

  it.live("stops a running queued refresh, owing no rerun, when its thread closes", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const gate = yield* makePublishGate;
      const { thread, held, lookupsBefore } = yield* heldRefresh(root, gate);
      yield* requestMeanwhile(root, 2);

      yield* runtimes.close(thread.id);
      // On real time, not yields: the sync that interrupts it first awaits the watcher's release.
      yield* eventually(
        "the refresh interrupted",
        Effect.sync(() => held.interrupted),
      );
      yield* Deferred.succeed(gate.gate, undefined);
      yield* Effect.sleep("300 millis");
      expect(held.finished).toBe(false);
      expect(branchLookups.count).toBe(lookupsBefore);
      expect(yield* publisher.stateFor(root)).toBeUndefined();
    }).pipe(Effect.provide(publisherLayer())),
  );

  it.live(
    "interrupts a running queued refresh, owing no rerun, when the publisher shuts down",
    () =>
      Effect.gen(function* () {
        const root = repo();
        const gate = yield* makePublishGate;
        const { held, lookupsBefore } = yield* Effect.gen(function* () {
          const running = yield* heldRefresh(root, gate);
          yield* requestMeanwhile(root, 2);
          return running;
        }).pipe(Effect.provide(publisherLayer()));

        expect(held.interrupted).toBe(true);
        yield* Deferred.succeed(gate.gate, undefined);
        yield* Effect.sleep("300 millis");
        expect(held.finished).toBe(false);
        expect(branchLookups.count).toBe(lookupsBefore);
      }),
  );

  it.live("takes no queued refresh for a held checkout, and refreshes it again on release", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      yield* runtimes.create({ projectRoot: root, checkout: { kind: "main", path: root } });
      yield* eventually("the first git.state", publisher.stateFor(root));

      const release = yield* publisher.hold(root);
      const before = branchLookups.count;
      // What a turn ending or its last edits ask for while the checkout is being deleted.
      yield* requestMeanwhile(root, 2);
      yield* Effect.sleep("300 millis");
      expect(branchLookups.count).toBe(before);

      yield* release;
      yield* requestMeanwhile(root, 1);
      yield* eventually(
        "a lookup once released",
        Effect.sync(() => branchLookups.count > before),
      );
    }).pipe(Effect.provide(publisherLayer())),
  );

  it.live("keeps a direct refresh from publishing a held checkout", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      yield* runtimes.create({ projectRoot: root, checkout: { kind: "main", path: root } });
      yield* eventually("the first git.state", publisher.stateFor(root));

      const release = yield* publisher.hold(root);
      expect(yield* publisher.stateFor(root)).toBeUndefined();
      // `git_state` refreshes directly.
      yield* publisher.refresh(root, { remote: false });
      expect(yield* publisher.stateFor(root)).toBeUndefined();

      yield* release;
      yield* eventually("the state once released", publisher.stateFor(root));
    }).pipe(Effect.provide(publisherLayer())),
  );

  it.live("replays each thread's last state to an observer that asks for it", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* eventually("the first git.state", publisher.stateFor(root));
      const seen: Array<string> = [];
      const record = (into: string) => ({
        onState: (observed: { readonly id: string }) =>
          Effect.sync(() => void seen.push(`${into}:${observed.id}`)),
        onRound: () => Effect.void,
      });
      yield* publisher.observe(record("late"));
      yield* publisher.observe(record("replayed"), { replay: true });
      expect(seen).toEqual([`replayed:${thread.id}`]);
    }).pipe(Effect.provide(publisherLayer())),
  );

  it.live("undoes a hold that's interrupted while it waits out a running refresh", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const gate = yield* makePublishGate;
      yield* runtimes.create({ projectRoot: root, checkout: { kind: "main", path: root } });
      yield* eventually("the first git.state", publisher.stateFor(root));
      yield* publisher.observe({
        onState: (_thread, state) =>
          state.pr?.checks !== "pending"
            ? Effect.void
            : Deferred.succeed(gate.started, undefined).pipe(
                Effect.andThen(Deferred.await(gate.gate)),
              ),
        onRound: () => Effect.void,
      });
      current.badge = badge({ checks: "pending" });
      // A direct refresh keeps the checkout's lock while its observer waits at the gate.
      yield* Effect.forkScoped(publisher.refresh(root, { remote: true }));
      yield* Deferred.await(gate.started);

      const holding = yield* Effect.forkScoped(publisher.hold(root));
      yield* eventually(
        "the watch dropped",
        publisher.stateFor(root).pipe(Effect.map((state) => state === undefined)),
      );
      yield* Fiber.interrupt(holding);
      yield* Deferred.succeed(gate.gate, undefined);

      // Undone and watched again: an edit publishes without anyone asking for a refresh.
      current.badge = undefined;
      write(nodePath.join(root, "after.txt"), "x\n");
      yield* eventually(
        "the edit published",
        publisher.stateFor(root).pipe(Effect.map((state) => state?.changedFiles === 1)),
      );
    }).pipe(Effect.scoped, Effect.provide(publisherLayer())),
  );

  it.live(
    "waits out a refresh already in git when a hold starts, which then publishes nothing",
    () =>
      Effect.gen(function* () {
        const root = repo();
        const runtimes = yield* ThreadRuntimes;
        const publisher = yield* GitStatePublisher;
        yield* runtimes.create({ projectRoot: root, checkout: { kind: "main", path: root } });
        yield* eventually("the first git.state", publisher.stateFor(root));

        const gate = yield* makePublishGate;
        lookupGate.current = gate;
        current.badge = badge({ checks: "pending" });
        yield* Effect.forkScoped(publisher.refresh(root, { remote: true }));
        yield* Deferred.await(gate.started);

        const hold = { returned: false };
        const holding = yield* Effect.forkScoped(
          publisher.hold(root).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                hold.returned = true;
              }),
            ),
          ),
        );
        // Past its `sync` (the watch and state are gone), so only the wait for the lock is left.
        yield* eventually(
          "the hold's sync done",
          publisher.stateFor(root).pipe(Effect.map((state) => state === undefined)),
        );
        yield* Effect.sleep("300 millis");
        expect(hold.returned).toBe(false);

        yield* Deferred.succeed(gate.gate, undefined);
        const release = yield* Fiber.join(holding);
        // The refresh finished under the hold, so it put no state back.
        expect(yield* publisher.stateFor(root)).toBeUndefined();
        yield* release;
      }).pipe(Effect.scoped, Effect.provide(publisherLayer({ pr: GatedPr }))),
  );

  it.effect("queues one CI message per settle, once the checks have stayed settled", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: true },
      }));
      const ciMessages = fake
        .latest(thread.id)
        .pipe(
          Effect.map((s) =>
            s.sent.map((input) => input.text).filter((text) => text.startsWith("CI")),
          ),
        );
      const checks = (value: PrStatus["checks"]) =>
        Effect.gen(function* () {
          current.badge = badge({ checks: value });
          yield* publisher.refresh(root, { remote: true });
        });

      // Refreshes are awaited, so only the notice delay runs on the test clock, not real git latency.
      // Settles, then flips back to pending within the delay: nothing is queued.
      yield* checks("pending");
      yield* checks("failing");
      yield* checks("pending");
      yield* TestClock.adjust("1 minute");
      expect(yield* ciMessages).toEqual([]);

      // Failing replaced by passing within the delay: one message, for where the checks ended up.
      yield* checks("failing");
      yield* checks("passing");
      yield* TestClock.adjust("10 seconds");
      yield* waitFor("the CI message", ciMessages.pipe(Effect.map((texts) => texts.length > 0)));
      yield* TestClock.adjust("1 minute");
      expect(yield* ciMessages).toEqual(["CI passed on #7"]);
    }).pipe(
      Effect.provide(publisherLayer({ config: { monitorSettleDelay: Duration.seconds(10) } })),
    ),
  );

  it.effect("tells a settle that happened while the app was down, from the mark it kept", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const publisher = yield* GitStatePublisher;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
      // As the last run left it: watching, and last seen pending on this head.
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: {
          repo: "acme/web",
          number: 7,
          monitor: true,
          seen: { head: "a1", ci: "pending" },
        },
      }));
      const ciMessages = fake
        .latest(thread.id)
        .pipe(
          Effect.map((s) =>
            s.sent.map((input) => input.text).filter((text) => text.startsWith("CI")),
          ),
        );
      current.badge = badge({ checks: "passing", headRefOid: "a1" });
      yield* publisher.refresh(root, { remote: true });
      // Owed a notice, the settle isn't kept as seen until it is sent: a restart now still tells it.
      expect((yield* store.getThread(thread.id)).boundPr?.seen).toEqual({
        head: "a1",
        ci: "pending",
      });
      yield* TestClock.adjust("10 seconds");
      yield* waitFor("the CI message", ciMessages.pipe(Effect.map((texts) => texts.length > 0)));
      expect(yield* ciMessages).toEqual(["CI passed on #7"]);
      expect((yield* store.getThread(thread.id)).boundPr?.seen).toEqual({
        head: "a1",
        ci: "passing",
      });

      // Turned off, the monitor forgets what it saw.
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { ...t.boundPr!, monitor: false },
      }));
      yield* waitFor(
        "the mark to go",
        store.getThread(thread.id).pipe(Effect.map((t) => t.boundPr?.seen === undefined)),
      );
    }).pipe(
      Effect.provide(publisherLayer({ config: { monitorSettleDelay: Duration.seconds(10) } })),
    ),
  );

  it.effect("names a failing badge's checks from a read made under its head and rollup", () =>
    Effect.gen(function* () {
      const root = repo();
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const states: Array<GitState> = [];
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "git.state") states.push(event.state);
          }),
        ),
        Effect.forkScoped,
      );
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
      const failing = badge({ checks: "failing", headRefOid: "a1", url: WEB_7 });
      current.seen = { checks: detail.checkRuns, stamp: prChecksStamp(failing), at: 0 };
      current.badge = failing;
      yield* publisher.refresh(root, { remote: true });
      yield* waitFor(
        "the named badge",
        Effect.sync(() => states.at(-1)?.pr?.failingChecks !== undefined),
      );
      expect(states.at(-1)?.pr?.failingChecks).toEqual({ names: ["build"], readAt: 0 });

      // A new head that fails too: what was read of the old one names nothing of it.
      current.badge = badge({ checks: "failing", headRefOid: "b2", url: WEB_7 });
      yield* publisher.refresh(root, { remote: true });
      yield* waitFor(
        "the new head",
        Effect.sync(() => states.at(-1)?.pr?.headRefOid === "b2"),
      );
      expect(states.at(-1)?.pr?.failingChecks).toBeUndefined();
    }).pipe(Effect.provide(publisherLayer())),
  );

  it.effect("notifies the user once per head commit when an open PR's checks settle", () =>
    Effect.gen(function* () {
      const root = repo();
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const notices: Array<Extract<ServerEvent, { type: "notify" }>> = [];
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "notify") notices.push(event);
          }),
        ),
        Effect.forkScoped,
      );
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
      const checks = (value: PrStatus["checks"], headRefOid = "a1") =>
        Effect.gen(function* () {
          current.badge = badge({ checks: value, headRefOid });
          yield* publisher.refresh(root, { remote: true });
        });

      // Settles, then flips back to pending within the delay: nothing.
      yield* checks("pending");
      yield* checks("failing");
      yield* checks("pending");
      yield* TestClock.adjust("1 minute");
      expect(notices).toEqual([]);

      yield* checks("failing");
      yield* TestClock.adjust("10 seconds");
      yield* waitFor(
        "the notice",
        Effect.sync(() => notices.length > 0),
      );
      expect(notices).toEqual([
        {
          type: "notify",
          kind: "error",
          title: "CI failed on #7",
          ciFailure: "u",
          body: `build · ${thread.title}`,
          threadId: thread.id,
        },
      ]);

      // A re-run on the same head failing again adds nothing; a new head that passes does.
      yield* checks("pending");
      yield* checks("failing");
      yield* TestClock.adjust("1 minute");
      yield* checks("pending", "b2");
      yield* checks("passing", "b2");
      yield* TestClock.adjust("10 seconds");
      yield* waitFor(
        "the second notice",
        Effect.sync(() => notices.length > 1),
      );
      yield* TestClock.adjust("1 minute");
      expect(notices.map((notice) => [notice.kind, notice.title])).toEqual([
        ["error", "CI failed on #7"],
        ["done", "CI passed on #7"],
      ]);
      expect(notices[1]?.ciFailure).toBeUndefined();
    }).pipe(
      Effect.provide(publisherLayer({ config: { monitorSettleDelay: Duration.seconds(10) } })),
    ),
  );

  it.effect("leaves CI settles to the review notice while the review monitor is on", () =>
    Effect.gen(function* () {
      const root = repo();
      const runtimes = yield* ThreadRuntimes;
      const publisher = yield* GitStatePublisher;
      const fake = yield* FakeAgentControl;
      const thread = yield* runtimes.create({
        projectRoot: root,
        checkout: { kind: "main", path: root },
      });
      yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 7, monitor: true, reviewMonitor: true },
      }));
      const checks = (value: PrStatus["checks"]) =>
        Effect.gen(function* () {
          current.badge = badge({ checks: value });
          yield* publisher.refresh(root, { remote: true });
        });

      yield* checks("pending");
      yield* checks("failing");
      yield* TestClock.adjust("1 minute");
      yield* waitFor(
        "the publisher to see the failing checks",
        publisher.stateFor(root).pipe(Effect.map((state) => state?.pr?.checks === "failing")),
      );
      for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
      expect(
        fake.sessions.filter((s) => s.options.threadId === thread.id).flatMap((s) => s.sent),
      ).toEqual([]);
    }).pipe(
      Effect.provide(publisherLayer({ config: { monitorSettleDelay: Duration.seconds(10) } })),
    ),
  );
});
