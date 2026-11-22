import {
  agentOwnsPrEvents,
  anyPrOpen,
  effectiveCheckout,
  isLocalHost,
  LOCAL_HOST_ID,
  MAX_FAILING_CHECK_NAMES,
  requiredChecksOf,
  reviewBotsOf,
  threadPrBadges,
  withoutCompletion,
  type BoundPr,
  type ChecksRollup,
  type GitState,
  type MonitorMark,
  type PrStatus,
  type ReviewRound,
  type Thread,
  type ThreadId,
  fenceNames,
} from "@gram/contracts";
import {
  invalidatePrBadges,
  notARepoState,
  Pr,
  prChecksStamp,
  Proc,
  repoFromPrUrl,
  ReviewBots,
  Tools,
  samePathKey,
  Worktrees,
} from "@gram/git";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { embeddingOption } from "../embedding/embedding.ts";
import { ghFolderOf } from "../fs/folders.ts";
import { forThread, threadCaller } from "../embedding/gh-thread.ts";
import {
  checkoutKey,
  checkoutReads,
  type Spot,
  spotKey,
  spotOf,
  thereHere,
} from "./checkout-spot.ts";
import { EventHub } from "../events/event-hub.ts";
import { besidesActivity, upsertsChanging } from "../events/upsert-changes.ts";
import { branchPrOf, completionStep, type CompletionStep } from "./completion.ts";
import { isBadgeOf, markOf, prunedMarks, withMonitorMark, type PrRef } from "./extra-prs.ts";
import { pushedEventTouches, type PushedRepoEvent } from "./pushed-event-touches.ts";
import { activityMultiplier, makePollBackoff } from "../github/poll-backoff.ts";
import { affordsExtras, asBackground, GhBudget, GhPriority } from "../github/budget.ts";
import { OpenPrs } from "../github/open-prs.ts";
import { RateLimitMonitor } from "../github/rate-limit-monitor.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { folderOwedResume } from "../host/stop-marks.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { AppActivity, onScreen, type ActivityLevel } from "./activity.ts";
import { GitRefresh, GitServerConfig } from "./platform.ts";
import { closestAttention, lookupEvery, type Attention } from "./poll-cadence.ts";
import { discoverPrsElsewhere, wantsPrElsewhere } from "./pr-elsewhere.ts";
import { ThreadVisibility } from "./visibility.ts";
import { makeKeyedLock } from "./keyed-lock.ts";
import { makePrWatches, type PrWatch } from "./pr-watches.ts";

export type { PrWatch } from "./pr-watches.ts";

export interface GitStatePublisherShape {
  /** The last published state for a checkout path. */
  readonly stateFor: (path: string) => Effect.Effect<GitState | undefined>;
  /**
   * The last badge of the PR a thread acts on: its checkout's, or its bound PR's when that one lives
   * elsewhere, which `stateFor` doesn't carry. It may still be the previous binding's right after a
   * rebind, so a caller that keys anything by it checks which PR it is. None for an orchestrator.
   */
  readonly badgeFor: (thread: Thread) => Effect.Effect<PrStatus | undefined>;
  /** The last badges of the extra PRs a thread follows (`extraPrs`), as its published state has them. */
  readonly extraBadgesFor: (thread: Thread) => Effect.Effect<ReadonlyArray<PrStatus>>;
  /**
   * Replaces the PRs `owner` waits on (a PR wake, a dependency). Each is looked up in its thread's
   * sweeps, in the document the sweep sends anyway, until the owner drops it; however many threads
   * wait on one PR, `Pr`'s cache answers them with one lookup.
   */
  readonly watchPrs: (owner: string, watches: ReadonlyArray<PrWatch>) => Effect.Effect<void>;
  /** The last badge of `ref` the publisher has, from a watch's lookup or any thread's state. */
  readonly watchedBadge: (ref: PrRef) => Effect.Effect<PrStatus | undefined>;
  /**
   * Looks `ref` up now, from `thread`'s checkout, as the user's request: `None` when GitHub couldn't
   * be asked, `Some(undefined)` when it has no such PR.
   */
  readonly lookupPr: (
    thread: Thread,
    ref: PrRef & { readonly reviews?: boolean | undefined },
  ) => Effect.Effect<Option.Option<PrStatus | undefined>>;
  /**
   * The state `thread` is shown: its checkout's, with the PR it acts on in place of the checkout's
   * when it's bound to one elsewhere, and none for an orchestrator. What `git.state` sends it.
   */
  readonly stateForThread: (thread: Thread) => Effect.Effect<GitState | undefined>;
  /**
   * Recompute a checkout's state and publish it to its threads when it changed. `rebase: false` keeps
   * the last rebase tier rather than measuring it. `scanElsewhere` (default `remote`) also looks for
   * uncommitted work in the repo's other worktrees.
   */
  readonly refresh: (
    path: string,
    options: {
      readonly remote: boolean;
      readonly rebase?: boolean;
      readonly scanElsewhere?: boolean;
    },
  ) => Effect.Effect<void>;
  /**
   * A read of one of `thread`'s PRs fresher than its badge, such as the PR panel's. When it has
   * the badge's open PR merged or closed, the badge is looked up again now, bypassing the lookup
   * cache, and asked about on every sweep for a while.
   */
  readonly reconcile: (
    thread: Thread,
    seen: { readonly number: number; readonly url: string; readonly state?: string | undefined },
  ) => Effect.Effect<void>;
  /**
   * A `Pr.checks` read of one of `thread`'s PRs just landed, such as the PR strip's: when it names
   * the failing checks of the badge's head and rollup, the state goes out again with them now,
   * since a state that didn't change otherwise isn't sent again until something does.
   */
  readonly checksRead: (thread: Thread) => Effect.Effect<void>;
  /** One network-tier pass over every open checkout, and archived ones with a PR still open. */
  readonly sweep: Effect.Effect<void>;
  /**
   * Aligns the watchers with the open threads now, completing once dropped watchers are released.
   * Parking and closing await it, so the thread's folder is free when they return: Windows won't
   * delete a watched directory, and a caller blocked in a synchronous delete can't let a pending
   * release run.
   */
  readonly sync: Effect.Effect<void>;
  /**
   * Stops watching and sweeping `path`, completing once its watcher is released, until the returned
   * effect runs. A checkout is held while it's deleted: on Windows the native watcher can crash the
   * process when its folder goes away under it. Holds nest.
   */
  readonly hold: (path: string) => Effect.Effect<Effect.Effect<void>>;
  /**
   * Late-bound: services above the publisher (the review monitor) see each publish. With `replay`,
   * the observer is first handed each open thread's last published state, which the publisher's
   * own start-up sync may have sent before anything above it could observe.
   */
  readonly observe: (
    observer: GitStateObserver,
    options?: { readonly replay?: boolean },
  ) => Effect.Effect<void>;
}

export { pushedEventTouches, type PushedRepoEvent };

const PUSHED_EVENT_SETTLE = Duration.seconds(1);

/**
 * How often a checkout is still asked about while its events are pushed: the fallback for an event
 * that never arrived, at a cadence that costs next to nothing.
 */
export const PUSHED_RECONCILE_EVERY = Duration.minutes(20);

/** The least time between two pushed reads of one checkout, however many events name it. */
export const PUSHED_READ_APART = Duration.seconds(5);

/**
 * Repository events told from outside (`embedding/inbound.ts`), which the publisher takes in place
 * of asking GitHub. A service of its own, beside the publisher that provides it.
 */
export class RepoEvents extends Context.Service<
  RepoEvents,
  {
    /**
     * The lookup caches are dropped and every checkout whose threads show, are bound to, follow or
     * wait on what `event` names is read from the network. Answers how many checkouts that was; a
     * burst of events for one checkout is one read, and reads of one checkout keep
     * `PUSHED_READ_APART`. Nothing, and 0, unless events are pushed (`GRAM_REPO_EVENTS=pushed`
     * with the hosted features on).
     */
    readonly pushed: (event: PushedRepoEvent) => Effect.Effect<number>;
  }
>()("@gram/server/RepoEvents") {}

export interface GitStateObserver {
  /** After a thread's new state is published. */
  readonly onState: (thread: Thread, state: GitState) => Effect.Effect<void>;
  /** After `pr.reviewRound` is published. */
  readonly onRound: (threadId: ThreadId, round: ReviewRound) => Effect.Effect<void>;
  /** A PR someone `watchPrs` has a new badge, whichever lookup or thread's state read it. */
  readonly onWatchedPr?: ((badge: PrStatus) => Effect.Effect<void>) | undefined;
}

export class GitStatePublisher extends Context.Service<GitStatePublisher, GitStatePublisherShape>()(
  "@gram/server/GitStatePublisher",
) {}

/**
 * The message sent into a monitored thread when its PR's checks settle, or `undefined` when they
 * didn't just settle. Only a pending → settled transition counts, so binding a PR whose checks are
 * already done doesn't wake the agent.
 */
export const ciMessage = (
  previous: ChecksRollup | undefined,
  next: ChecksRollup,
  failing: ReadonlyArray<string>,
  number: number,
): string | undefined => {
  if (previous !== "pending") return undefined;
  if (next === "passing") return `CI passed on #${number}`;
  if (next !== "failing") return undefined;
  return failing.length > 0
    ? `CI failed on #${number}. The failing checks:\n${fenceNames("the failing checks' names", failing)}`
    : `CI failed on #${number}`;
};

/**
 * The thread has a watch switched on (Watch CI, Watch reviews, Babysit), so its PR is worth asking
 * GitHub about even while no window is showing: the agent is waiting on the answer, not a badge.
 */
export const hasWatch = (thread: Thread): boolean =>
  thread.boundPr?.monitor === true ||
  thread.boundPr?.reviewMonitor === true ||
  thread.boundPr?.mergeWhenReady !== undefined ||
  thread.babysit?.phase === "watching" ||
  (thread.extraPrs ?? []).some((extra) => extra.monitor);

/**
 * What a sweep with a window showing does for one checkout. `full`: every tier. `watch`: the PR
 * lookup alone, as the hidden sweep does. `local`: nothing from the network.
 */
export type SweepTier = "full" | "watch" | "local";

/**
 * What this sweep does for a checkout that is asked about every `every` sweeps (`lookupEvery`) and
 * has been passed over `skipped` times in a row. Until it is due, nothing from the network. When it
 * is, every tier if one of its chips is on screen; the PR lookup alone if none is, which is only ever
 * a watched thread, whose agent is waiting on a notification no chip coming back would deliver.
 */
export const sweepTier = (checkout: {
  /** No chip of any of its threads is on screen. */
  readonly gated: boolean;
  /** Sweeps in a row that left its network tier alone. */
  readonly skipped: number;
  readonly every: number;
}): SweepTier => {
  if (checkout.skipped + 1 < checkout.every) return "local";
  return checkout.gated ? "watch" : "full";
};

const EXPECT_CHANGE_FOR = Duration.minutes(3);

const FOCUS_FRESH_FOR = Duration.seconds(10);

/**
 * Sweeps at least between lookups of a checkout only archived (parked) threads are left on. They
 * are asked about until their PR merges or closes, since nobody is looking at them.
 */
export const PARKED_LOOKUP_EVERY = 4;

/**
 * Sweeps per work-elsewhere scan. A scan runs `git status` in every other worktree of the repo,
 * 100–300 ms each on Windows, so the sweeps in between carry the last answer.
 */
export const WORK_ELSEWHERE_SWEEPS = 4;

/**
 * Sweeps between local reads of a checkout only its sidebar row shows. Its watcher reports each
 * change as it lands, so the sweep's read is the fallback for one it missed: an edit under a pruned
 * build dir, or a folder the OS wouldn't watch.
 */
export const LISTED_LOCAL_EVERY = 8;

/**
 * Sweeps between local reads of a checkout a pane shows while native watches cover it (its
 * watcher's change stream says `live`): those report each change as it lands, so this read is only
 * the fallback for an edit under a pruned build dir, as `LISTED_LOCAL_EVERY` is for a listed one.
 */
export const SHOWN_LIVE_LOCAL_EVERY = 4;

/**
 * Sweeps from one local read of a checkout to the next, by how closely it is looked at: every sweep
 * for one a pane shows that no native watch covers, every few for one that is (`live`), and never
 * for one nobody can see, whose watcher and coming back on screen (`ThreadVisibility.revealed`)
 * bring it up to date.
 */
export const localEvery = (attention: Attention, live = false): number => {
  if (attention === "focused" || attention === "shown") return live ? SHOWN_LIVE_LOCAL_EVERY : 1;
  return attention === "listed" ? LISTED_LOCAL_EVERY : Number.POSITIVE_INFINITY;
};

const refresherKey = (key: string, remote: boolean) => `${key}|${remote}`;

interface CompletionCheck {
  readonly threadId: ThreadId;
  readonly binding: string;
  readonly state: GitState;
  readonly prs: ReadonlyArray<PrStatus | undefined>;
}

const extraKey = (extra: Pick<BoundPr, "repo" | "number">) =>
  `${extra.repo.toLowerCase()}#${extra.number}`;

const targetsOf = (thread: Thread) => [
  ...(thread.boundPr === undefined ? [] : [thread.boundPr]),
  ...(thread.extraPrs ?? []),
];

const targetsKey = (thread: Thread) => targetsOf(thread).map(extraKey).toSorted().join(" ");

const bindingOf = (thread: Thread) => `${targetsKey(thread)}@${checkoutKey(thread)}`;

const extraWatchKey = (threadId: ThreadId, extra: Pick<BoundPr, "repo" | "number">) =>
  `${threadId}|${extraKey(extra)}`;

const CI_NOTICE = "ci:";

const markedCi = (
  mark: MonitorMark | undefined,
  head: string | undefined,
): ChecksRollup | undefined => {
  if (mark?.ci === undefined) return undefined;
  return head === undefined || mark.head === head ? mark.ci : "pending";
};

const ciNoticeKey = (pr: Pick<BoundPr, "repo" | "number">) => `${CI_NOTICE}${extraKey(pr)}`;

const boundElsewhere = (thread: Thread, state: GitState) => {
  const bound = thread.boundPr;
  if (bound === undefined) return undefined;
  const sameRepo =
    state.origin === undefined || state.origin.toLowerCase() === bound.repo.toLowerCase();
  return state.pr?.number === bound.number && sameRepo ? undefined : bound;
};

const wantsReviews = (thread: Thread) =>
  (thread.boundPr?.reviewMonitor === true || thread.boundPr?.mergeWhenReady !== undefined) &&
  !thread.parked;

const sweepCost = (checkouts: number, reviewed = 0) =>
  Math.max(1, Math.ceil((checkouts + reviewed) * 0.15));

export const GitStatePublisherLive = Layer.effectContext(
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const hub = yield* EventHub;
    const runtimes = yield* ThreadRuntimes;
    const machines = yield* WorkerHosts;
    const remoteHosts = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
    const gitOn = (spot: Spot) => machines.machine(spot.hostId).git;
    const worktrees = machines.machine(LOCAL_HOST_ID).worktrees;
    const pr = yield* Pr;
    const config = yield* GitServerConfig;
    const refreshes = yield* GitRefresh;
    const reviewBots = yield* ReviewBots;
    const proc = yield* Proc;
    const rateLimits = yield* RateLimitMonitor;
    const openPrs = yield* OpenPrs;
    const budget = yield* GhBudget;
    const tools = yield* Effect.serviceOption(Tools);
    const visibility = yield* Effect.serviceOption(ThreadVisibility);
    const activity = yield* Effect.serviceOption(AppActivity);
    const embedding = yield* embeddingOption;
    const eventsPushed =
      embedding === undefined || embedding.config.repoEvents !== "pushed"
        ? Effect.succeed(false)
        : embedding.on;

    const states = new Map<string, GitState>();
    const published = new Map<ThreadId, GitState>();
    const checks = new Map<string, ChecksRollup>();
    const rounds = new Map<ThreadId, { readonly url: string; readonly reviewId: string }>();
    const pendingRounds = new Map<ThreadId, string>();
    const roundTimers = yield* FiberMap.make<ThreadId>();
    const locks = makeKeyedLock<string>();
    const watched = new Set<string>();
    const sweptOnly = new Set<string>();
    const syncLock = yield* Semaphore.make(1);
    const watchers = yield* FiberMap.make<string>();
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...watched], (key) => FiberMap.remove(watchers, key), { discard: true }),
    );
    const refreshers = yield* FiberMap.make<string>();
    const ciNotices = yield* FiberMap.make<string>();
    const awaitingNotice = new Set<string>();
    const sendingNotice = new Set<string>();
    const extraBadges = new Map<ThreadId, Map<string, PrStatus>>();
    const boundPrs = new Map<ThreadId, PrStatus>();
    const prWatches = makePrWatches();
    const userNotices = yield* FiberMap.make<ThreadId>();
    const userChecks = new Map<ThreadId, ChecksRollup>();
    const awaitingUserNotice = new Set<ThreadId>();
    const notifiedSettles = new Set<string>();
    const observers: Array<GitStateObserver> = [];
    const held = new Map<string, number>();
    const skippedSweeps = new Map<string, number>();
    let sweeps = 0;
    const localReadAt = new Map<string, number>();
    const liveWatched = new Set<string>();
    let elsewhereRead: string | undefined;

    const waitsOnPr = (thread: Thread) =>
      !thread.parked && prWatches.forThread(thread.id).length > 0;

    const noteWatched = (badge: PrStatus) =>
      Effect.gen(function* () {
        const next = prWatches.note(badge);
        if (next === undefined) return;
        for (const observer of observers) {
          if (observer.onWatchedPr !== undefined) yield* observer.onWatchedPr(next);
        }
      });

    const lingers = (thread: Thread) => {
      if (!thread.parked || answered.get(thread.id) === targetsKey(thread)) return false;
      const state = published.get(thread.id);
      const badges = [state?.pr, ...(state?.extraPrs ?? [])].filter(
        (badge): badge is PrStatus => badge !== undefined,
      );
      const gone = missing.get(thread.id);
      const isGone = (target: Pick<BoundPr, "repo" | "number">) =>
        gone?.has(extraKey(target)) === true;
      const targets = targetsOf(thread);
      const open = badges.some(
        (badge) =>
          badge.state === "OPEN" &&
          (targets.length === 0 ||
            targets.some((target) => !isGone(target) && isBadgeOf(badge, target))),
      );
      if (open) return true;
      const unanswered = targets.some(
        (target) => !isGone(target) && !badges.some((badge) => isBadgeOf(badge, target)),
      );
      if (unanswered) return true;
      return state === undefined && thread.completedAt === undefined;
    };

    const answered = new Map<ThreadId, string>();
    const missing = new Map<ThreadId, Set<string>>();

    const noteMissing = (
      thread: Thread,
      target: Pick<BoundPr, "repo" | "number">,
      gone: boolean,
    ): boolean => {
      const keys = missing.get(thread.id) ?? new Set<string>();
      const was = keys.has(extraKey(target));
      if (gone) keys.add(extraKey(target));
      else keys.delete(extraKey(target));
      if (keys.size === 0) missing.delete(thread.id);
      else missing.set(thread.id, keys);
      return was !== gone;
    };

    const openThreads = store.listThreads.pipe(
      Effect.map((threads) => threads.filter((t) => !t.parked || lingers(t))),
    );

    const threadState = (thread: Thread, state: GitState): GitState => {
      if (thread.role === "orchestrator") {
        const { pr: _pr, extraPrs: _extras, prElsewhere: _elsewhere, ...rest } = state;
        return rest;
      }
      let next = state;
      const boundTo = boundElsewhere(thread, state);
      if (boundTo !== undefined) {
        const bound = boundPrs.get(thread.id);
        if (bound !== undefined && isBadgeOf(bound, boundTo)) next = { ...next, pr: bound };
        else {
          const { pr: _checkouts, ...rest } = next;
          next = rest;
        }
      }
      const badges = extraBadges.get(thread.id);
      const extras = (thread.extraPrs ?? []).flatMap((extra) => {
        const badge = badges?.get(extraKey(extra));
        return badge === undefined ? [] : [badge];
      });
      if (extras.length > 0) next = { ...next, extraPrs: extras };
      const gone = missing.get(thread.id);
      const missingPrs = targetsOf(thread)
        .filter((target) => gone?.has(extraKey(target)) === true)
        .map(({ repo, number }) => ({ repo, number }));
      if (missingPrs.length > 0) next = { ...next, missingPrs };
      const elsewhere = next.workElsewhere;
      const following =
        elsewhere !== undefined &&
        thread.currentCheckout !== undefined &&
        samePathKey(thread.currentCheckout.path) === samePathKey(elsewhere.path);
      if (following) {
        const { workElsewhere, ...followed } = next;
        void workElsewhere;
        next = followed;
      }
      if (next.prElsewhere !== undefined && !wantsPrElsewhere(thread, next)) {
        const { prElsewhere, ...rest } = next;
        void prElsewhere;
        next = rest;
      }
      return next;
    };

    const refreshBound = (
      path: string,
      key: string,
      state: GitState,
      inventory?: ReadonlyArray<Thread>,
      cwd: string = path,
    ) =>
      Effect.gen(function* () {
        const mine =
          inventory ?? (yield* openThreads).filter((thread) => checkoutKey(thread) === key);
        const extras = affordsExtras(yield* budget.window("graphql"));
        let changed = false;
        yield* Effect.forEach(
          mine,
          (thread) =>
            Effect.gen(function* () {
              const bound = boundElsewhere(thread, state);
              if (bound === undefined) {
                changed = boundPrs.delete(thread.id) || changed;
                return;
              }
              const next = yield* pr
                .status(cwd, {
                  repo: bound.repo,
                  number: bound.number,
                  reviews: extras && wantsReviews(thread),
                })
                .pipe(forThread(thread.id), Effect.option);
              if (Option.isNone(next)) return;
              changed = noteMissing(thread, bound, next.value === undefined) || changed;
              if (next.value === undefined) {
                changed = boundPrs.delete(thread.id) || changed;
                return;
              }
              if (JSON.stringify(boundPrs.get(thread.id)) === JSON.stringify(next.value)) return;
              boundPrs.set(thread.id, next.value);
              changed = true;
            }),
          { concurrency: "unbounded", discard: true },
        );
        yield* Effect.forEach(
          mine.flatMap((thread) => (thread.extraPrs ?? []).map((extra) => ({ thread, extra }))),
          ({ thread, extra }) =>
            Effect.gen(function* () {
              const next = yield* pr
                .status(cwd, { repo: extra.repo, number: extra.number })
                .pipe(forThread(thread.id), Effect.option);
              if (Option.isNone(next)) return;
              changed = noteMissing(thread, extra, next.value === undefined) || changed;
              if (next.value === undefined) {
                changed = extraBadges.get(thread.id)?.delete(extraKey(extra)) === true || changed;
                return;
              }
              const badges = extraBadges.get(thread.id) ?? new Map<string, PrStatus>();
              if (JSON.stringify(badges.get(extraKey(extra))) === JSON.stringify(next.value))
                return;
              badges.set(extraKey(extra), next.value);
              extraBadges.set(thread.id, badges);
              changed = true;
            }),
          { concurrency: "unbounded", discard: true },
        );
        const waited = mine
          .filter((thread) => !thread.parked)
          .flatMap((thread) => prWatches.forThread(thread.id));
        yield* Effect.forEach(
          waited,
          (watch) =>
            pr
              .status(cwd, {
                repo: watch.repo,
                number: watch.number,
                reviews: extras && watch.reviews === true,
              })
              .pipe(
                forThread(watch.threadId),
                Effect.option,
                Effect.flatMap((next) =>
                  Option.isSome(next) && next.value !== undefined
                    ? noteWatched(next.value)
                    : Effect.void,
                ),
              ),
          { concurrency: "unbounded", discard: true },
        );
        for (const thread of mine) {
          const badges = extraBadges.get(thread.id);
          if (badges === undefined) continue;
          const kept = new Set((thread.extraPrs ?? []).map(extraKey));
          for (const followed of badges.keys()) {
            if (kept.has(followed)) continue;
            badges.delete(followed);
            changed = true;
          }
          if (badges.size === 0) extraBadges.delete(thread.id);
        }
        return changed;
      });

    const withCheckNames = (badge: PrStatus) =>
      Effect.gen(function* () {
        const unnamed = () => {
          if (badge.failingChecks === undefined) return badge;
          const { failingChecks: _stale, ...rest } = badge;
          return rest;
        };
        if (requiredChecksOf(badge) !== "failing") return unnamed();
        const repo = repoFromPrUrl(badge.url);
        const seen = repo === undefined ? undefined : yield* pr.seenChecks(repo, badge.number);
        if (seen === undefined || seen.stamp !== prChecksStamp(badge)) return unnamed();
        const marked = seen.checks.some((check) => check.required === true);
        const names = seen.checks
          .filter(
            (c) => c.status === "failing" && c.name !== "" && (!marked || c.required === true),
          )
          .map((c) => c.name)
          .slice(0, MAX_FAILING_CHECK_NAMES);
        return names.length === 0
          ? unnamed()
          : { ...badge, failingChecks: { names, readAt: seen.at } };
      });

    const namedChecks = (state: GitState) =>
      Effect.gen(function* () {
        if (state.pr === undefined && state.extraPrs === undefined) return state;
        const named = state.pr === undefined ? undefined : yield* withCheckNames(state.pr);
        const extras =
          state.extraPrs === undefined
            ? undefined
            : yield* Effect.forEach(state.extraPrs, withCheckNames);
        return {
          ...state,
          ...(named === undefined ? {} : { pr: named }),
          ...(extras === undefined ? {} : { extraPrs: extras }),
        };
      });

    const publishCheckNames = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const last = published.get(threadId);
        if (last === undefined) return;
        const named = yield* namedChecks(last);
        if (JSON.stringify(named) === JSON.stringify(last)) return;
        yield* Effect.uninterruptible(
          Effect.suspend(() => {
            if (published.get(threadId) !== last) return Effect.void;
            published.set(threadId, named);
            return hub.publish({ type: "git.state", threadId, state: named });
          }),
        );
      });

    const failingRuns = (thread: Thread, badge: PrStatus, repo?: string) =>
      pr
        .checks(effectiveCheckout(thread).path, badge.number, repo, { stamp: prChecksStamp(badge) })
        .pipe(
          Effect.map((runs) =>
            runs
              .filter((run) => run.status === "failing" && run.name !== "")
              .map((run) => run.name),
          ),
          Effect.tap(() => publishCheckNames(thread.id)),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );

    const notifyCi = (thread: Thread, state: GitState) =>
      Effect.gen(function* () {
        const badge = state.pr;
        if (badge === undefined || badge.state !== "OPEN") {
          userChecks.delete(thread.id);
          awaitingUserNotice.delete(thread.id);
          return yield* FiberMap.remove(userNotices, thread.id);
        }
        const previous = userChecks.get(thread.id);
        userChecks.set(thread.id, badge.checks);
        if (badge.checks === "pending") {
          awaitingUserNotice.delete(thread.id);
          return yield* FiberMap.remove(userNotices, thread.id);
        }
        const from = awaitingUserNotice.has(thread.id) ? "pending" : previous;
        if (ciMessage(from, badge.checks, [], badge.number) === undefined) return;
        const key = `${thread.id}:${badge.number}:${badge.headRefOid ?? ""}:${badge.checks}`;
        if (notifiedSettles.has(key)) return;
        awaitingUserNotice.add(thread.id);
        yield* FiberMap.run(
          userNotices,
          thread.id,
          Effect.gen(function* () {
            yield* Effect.sleep(config.monitorSettleDelay);
            awaitingUserNotice.delete(thread.id);
            notifiedSettles.add(key);
            const failed = badge.checks === "failing";
            const failing = failed
              ? yield* failingRuns(thread, badge, boundElsewhere(thread, state)?.repo)
              : [];
            if (agentOwnsPrEvents(thread)) {
              if (!failed || hasWatch(thread)) return;
              return yield* runtimes
                .sendNotice(thread.id, `${CI_NOTICE}worker:${badge.url}`, {
                  text: ciMessage("pending", badge.checks, failing, badge.number) ?? "CI failed",
                })
                .pipe(Effect.ignore);
            }
            yield* hub.publish({
              type: "notify",
              kind: failed ? "error" : "done",
              title: `CI ${failed ? "failed" : "passed"} on #${badge.number}`,
              ...(failed ? { ciFailure: badge.url } : {}),
              body: failing.length > 0 ? `${failing.join(", ")} · ${thread.title}` : thread.title,
              threadId: thread.id,
            });
          }),
        );
      });

    const stopWatching = (key: string) => {
      checks.delete(key);
      awaitingNotice.delete(key);
      return FiberMap.remove(ciNotices, key);
    };

    const rememberMark = (
      threadId: ThreadId,
      ref: PrRef,
      next: (mark: MonitorMark | undefined) => MonitorMark,
    ) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        if (Option.isNone(thread)) return;
        if (withMonitorMark(thread.value, ref, next(markOf(thread.value, ref))) === thread.value)
          return;
        yield* runtimes
          .updateThread(threadId, (t) => withMonitorMark(t, ref, next(markOf(t, ref))))
          .pipe(Effect.ignore);
      });

    const watchChecks = (
      key: string,
      thread: Thread,
      target: BoundPr,
      badge: PrStatus,
      repo: string | undefined,
    ) =>
      Effect.gen(function* () {
        const previous = checks.get(key) ?? markedCi(target.seen, badge.headRefOid);
        checks.set(key, badge.checks);
        const head = badge.headRefOid;
        const mark = rememberMark(thread.id, target, (kept) => ({
          ...kept,
          ...(head === undefined ? {} : { head }),
          ci: badge.checks,
        }));
        if (badge.checks === "pending") {
          awaitingNotice.delete(key);
          yield* mark;
          return yield* FiberMap.remove(ciNotices, key);
        }
        const from = awaitingNotice.has(key) ? "pending" : previous;
        if (ciMessage(from, badge.checks, [], badge.number) === undefined) {
          return sendingNotice.has(key) ? undefined : yield* mark;
        }
        awaitingNotice.add(key);
        yield* FiberMap.run(
          ciNotices,
          key,
          Effect.gen(function* () {
            yield* Effect.sleep(config.monitorSettleDelay);
            awaitingNotice.delete(key);
            sendingNotice.add(key);
            yield* Effect.gen(function* () {
              const latest = yield* store.getThread(thread.id).pipe(Effect.option);
              if (Option.isSome(latest) && latest.value.parked) return;
              const failing =
                badge.checks === "failing" ? yield* failingRuns(thread, badge, repo) : [];
              const text =
                ciMessage("pending", badge.checks, failing, badge.number) ?? "CI settled";
              yield* runtimes
                .sendNotice(thread.id, ciNoticeKey(target), { text })
                .pipe(Effect.ignore);
              yield* mark;
            }).pipe(Effect.ensuring(Effect.sync(() => sendingNotice.delete(key))));
          }),
        );
      });

    const monitor = (thread: Thread, state: GitState) =>
      Effect.gen(function* () {
        const bound = thread.boundPr;
        const badge = state.pr;
        if (
          bound === undefined ||
          !bound.monitor ||
          bound.reviewMonitor === true ||
          badge === undefined ||
          badge.number !== bound.number
        ) {
          yield* stopWatching(thread.id);
        } else {
          yield* watchChecks(thread.id, thread, bound, badge, boundElsewhere(thread, state)?.repo);
        }

        const watching = new Set<string>();
        for (const extra of thread.extraPrs ?? []) {
          const extraBadge = extraBadges.get(thread.id)?.get(extraKey(extra));
          if (!extra.monitor || extraBadge === undefined) continue;
          const key = extraWatchKey(thread.id, extra);
          watching.add(key);
          yield* watchChecks(key, thread, extra, extraBadge, extra.repo);
        }
        for (const key of checks.keys()) {
          if (key.startsWith(`${thread.id}|`) && !watching.has(key)) yield* stopWatching(key);
        }
      });

    const completionPrs = (thread: Thread, state: GitState) => {
      const branchPr = branchPrOf(thread, states.get(checkoutKey(thread)));
      return [...threadPrBadges(thread, state), ...(branchPr === undefined ? [] : [branchPr])];
    };

    const applyCompletion = ({ threadId, binding, state, prs }: CompletionCheck) =>
      Effect.gen(function* () {
        const decided: { step: CompletionStep } = { step: { kind: "none" } };
        const now = yield* Clock.currentTimeMillis;
        const { thread, changed } = yield* runtimes.updateCompletion(threadId, (current) => {
          if (bindingOf(current) !== binding) return undefined;
          const step = completionStep(current, state, prs);
          decided.step = step;
          switch (step.kind) {
            case "none":
              return undefined;
            case "reopen":
              return withoutCompletion(current);
            case "record":
              return { ...current, settledMerge: step.merge };
            case "settle":
              return {
                ...current,
                completedAt: now,
                completedReason: "prMerged",
                settledMerge: step.merge,
              };
          }
        });
        const applied = decided.step;
        if (!changed || applied.kind !== "settle" || agentOwnsPrEvents(thread)) return;
        yield* hub.publish({
          type: "notify",
          kind: "done",
          title: `${applied.prs.map((mark) => `#${mark.number}`).join(" and ")} merged`,
          body: thread.title,
          threadId,
        });
      }).pipe(Effect.ignore);

    const completions = yield* Queue.unbounded<CompletionCheck>();
    const checkedPrs = new Map<ThreadId, string>();
    yield* Queue.take(completions).pipe(
      Effect.flatMap(applyCompletion),
      Effect.forever,
      Effect.forkScoped,
    );

    const publishRound = (threadId: ThreadId, reviewId: string) =>
      Effect.gen(function* () {
        const badge = published.get(threadId)?.pr;
        const review = badge?.review;
        if (badge === undefined || review === undefined) return;
        if (review.roundInFlight || review.latestReviewId !== reviewId) return;
        pendingRounds.delete(threadId);
        const round: ReviewRound = {
          number: badge.number,
          reviewId,
          ...(review.latestVerdict === undefined ? {} : { verdict: review.latestVerdict }),
          ...(review.verdictOnHead === undefined ? {} : { verdictOnHead: review.verdictOnHead }),
          counts: review.threads,
        };
        yield* hub.publish({ type: "pr.reviewRound", threadId, round });
        for (const observer of observers) yield* observer.onRound(threadId, round);
      });

    const detectRound = (thread: Thread, state: GitState) =>
      Effect.gen(function* () {
        const badge = state.pr;
        const review = badge?.review;
        const reviewId = review?.latestReviewId;
        if (badge === undefined || review === undefined || reviewId === undefined) return;
        if (review.roundInFlight) return;
        const url = badge.url.toLowerCase();
        const seen = thread.boundPr?.seen;
        const kept =
          seen !== undefined &&
          (seen.reviewId !== undefined || seen.reviewsRead === true) &&
          thread.boundPr !== undefined &&
          isBadgeOf(badge, thread.boundPr)
            ? { url, reviewId: seen.reviewId ?? "" }
            : undefined;
        const previous = rounds.get(thread.id) ?? kept;
        rounds.set(thread.id, { url, reviewId });
        const isNew =
          previous !== undefined && previous.url === url && previous.reviewId !== reviewId;
        if (!isNew && pendingRounds.get(thread.id) !== reviewId) return;
        pendingRounds.set(thread.id, reviewId);
        yield* FiberMap.run(
          roundTimers,
          thread.id,
          Effect.sleep(config.reviewRoundDebounce).pipe(
            Effect.andThen(publishRound(thread.id, reviewId)),
          ),
        );
      });

    const publishTo = (thread: Thread, read: GitState) =>
      Effect.gen(function* () {
        const state = yield* namedChecks(read);
        const last = published.get(thread.id);
        const check: CompletionCheck = {
          threadId: thread.id,
          binding: bindingOf(thread),
          state,
          prs: completionPrs(thread, state),
        };
        const checkKey = JSON.stringify([check.binding, check.prs]);
        if (
          checkedPrs.get(thread.id) === checkKey &&
          (last === state || (last !== undefined && JSON.stringify(last) === JSON.stringify(state)))
        )
          return;
        checkedPrs.set(thread.id, checkKey);
        yield* Effect.uninterruptible(
          Effect.suspend(() => {
            published.set(thread.id, state);
            return hub
              .publish({ type: "git.state", threadId: thread.id, state })
              .pipe(Effect.andThen(Queue.offer(completions, check)));
          }),
        );
        if (thread.parked && !lingers(thread)) answered.set(thread.id, targetsKey(thread));
        if (
          state.missing === true &&
          last?.missing !== true &&
          !(remoteHosts !== undefined && folderOwedResume(remoteHosts.stops, thread))
        )
          yield* runtimes.stopInMissingFolder(thread.id);
        if (!thread.parked) {
          yield* Effect.all([
            monitor(thread, state),
            notifyCi(thread, state),
            detectRound(thread, state),
          ]).pipe(forThread(thread.id));
        }
        for (const observer of observers) yield* observer.onState(thread, state);
        for (const badge of [state.pr, ...(state.extraPrs ?? [])]) {
          if (badge !== undefined) yield* noteWatched(badge);
        }
      });

    const missingState = (
      previous: GitState | undefined,
      recorded: { readonly root?: string | undefined; readonly branch?: string | undefined },
      remote: boolean,
    ) =>
      Effect.gen(function* () {
        const last =
          previous ??
          (recorded.branch === undefined
            ? notARepoState
            : { ...notARepoState, branch: recorded.branch });
        const root = recorded.root;
        const { pr: carried, ...rest } = last;
        let badge = carried;
        if (remote && root !== undefined && carried !== undefined && last.origin !== undefined) {
          const next = yield* pr
            .status(root, { repo: last.origin, number: carried.number, reviews: true })
            .pipe(Effect.option);
          if (Option.isSome(next) && next.value !== undefined) {
            const same = next.value.headRefOid === carried.headRefOid;
            badge = {
              ...next.value,
              headMatches: same
                ? carried.headMatches
                : last.head !== "" && next.value.headRefOid === last.head,
              aheadOfPr: same ? carried.aheadOfPr : false,
            };
          } else if (Option.isSome(next)) badge = undefined;
        }
        return { ...rest, ...(badge === undefined ? {} : { pr: badge }), missing: true } as const;
      });

    const recordedOf = (key: string, inventory: ReadonlyArray<Thread> | undefined) =>
      Effect.gen(function* () {
        for (const thread of inventory ?? (yield* store.listThreads)) {
          const checkout = effectiveCheckout(thread);
          if (checkout.repoRoot !== undefined && checkoutKey(thread) === key)
            return { root: checkout.repoRoot, branch: checkout.branch };
        }
        return {};
      });

    const refreshIn = (
      spot: Spot,
      options: Parameters<GitStatePublisherShape["refresh"]>[1] & {
        readonly reuseLocal?: boolean;
      },
      inventory?: ReadonlyArray<Thread>,
    ) => {
      const { path } = spot;
      const key = spotKey(spot);
      const gitState = gitOn(spot);
      return locks.withLock(
        key,
        Effect.gen(function* () {
          if (held.has(key)) return;
          const previous = states.get(key);
          if (options.remote) {
            lastRemoteAt.set(key, yield* Clock.currentTimeMillis);
            yield* reviewBots.set(reviewBotsOf(yield* store.getSettings));
          }
          const present = yield* gitState.present(path);
          const recorded = present ? {} : yield* recordedOf(key, inventory);
          const root = recorded.root;
          const open = inventory ?? (yield* openThreads);
          const reads = checkoutReads(
            open.filter((t) => checkoutKey(t) === key),
            options.remote,
          );
          const next = present
            ? yield* gitState
                .snapshot(path, {
                  remote: reads.remote,
                  previous,
                  scanConcurrency: config.sweepConcurrency,
                  ...(options.rebase === undefined ? {} : { rebase: options.rebase }),
                  ...(options.scanElsewhere === undefined
                    ? {}
                    : { scanElsewhere: options.scanElsewhere }),
                  ...(options.reuseLocal === undefined ? {} : { reuseLocal: options.reuseLocal }),
                })
                .pipe(reads.as, Effect.option)
            : Option.some<GitState>(
                yield* reads.as(missingState(previous, recorded, reads.remote)),
              );
          if (Option.isNone(next)) return;
          if (options.remote) reconciledAt.set(key, yield* Clock.currentTimeMillis);
          if (options.reuseLocal !== true) localReadAt.set(key, sweeps);
          const tracked = new Set(open.map((t) => t.id));
          const boundChanged =
            options.remote && (present || root !== undefined)
              ? yield* refreshBound(
                  path,
                  key,
                  next.value,
                  inventory,
                  spot.hostId !== LOCAL_HOST_ID ? tmpdir() : (root ?? path),
                )
              : false;
          if (
            !boundChanged &&
            previous !== undefined &&
            JSON.stringify(previous) === JSON.stringify(next.value)
          )
            return;
          if (held.has(key)) return;
          states.set(key, next.value);
          const threads = (yield* store.listThreads).filter(
            (t) => !t.parked || lingers(t) || tracked.has(t.id),
          );
          for (const thread of threads) {
            if (checkoutKey(thread) === key)
              yield* publishTo(thread, threadState(thread, next.value));
          }
        }),
      );
    };

    const spotsAt = (path: string) =>
      Effect.map(store.listThreads, (threads): ReadonlyArray<Spot> => {
        const lexical = nodePath.resolve(path);
        const elsewhere = new Map<string, Spot>();
        let localKey: string | undefined;
        let heldHere = false;
        for (const thread of threads) {
          const checkout = effectiveCheckout(thread);
          if (isLocalHost(checkout)) {
            if (heldHere) continue;
            localKey ??= samePathKey(path);
            heldHere = checkoutKey(thread) === localKey;
          } else if (nodePath.resolve(checkout.path) === lexical) {
            const spot = spotOf(checkout);
            elsewhere.set(spotKey(spot), spot);
          }
        }
        const here: Spot = { hostId: LOCAL_HOST_ID, path };
        return elsewhere.size === 0 || heldHere
          ? [here, ...elsewhere.values()]
          : [...elsewhere.values()];
      });

    const refresh: GitStatePublisherShape["refresh"] = (path, options) =>
      Effect.flatMap(spotsAt(path), (spots) =>
        Effect.forEach(spots, (spot) => refreshIn(spot, options), { discard: true }),
      );

    const lastRemoteAt = new Map<string, number>();
    const reconciledAt = new Map<string, number>();
    const expectingUntil = new Map<string, number>();

    const queuedRuns = new Map<string, { dirty: boolean; priority: GhPriority }>();

    const requestRefresh = (spot: Spot, remote: boolean, priority: GhPriority = "interactive") =>
      Effect.suspend(() => {
        const checkout = spotKey(spot);
        if (held.has(checkout)) return Effect.void;
        const key = refresherKey(checkout, remote);
        const running = queuedRuns.get(key);
        if (running !== undefined) {
          running.dirty = true;
          if (priority === "interactive") running.priority = priority;
          return Effect.void;
        }
        const run = { dirty: false, priority };
        queuedRuns.set(key, run);
        const loop: Effect.Effect<void> = Effect.suspend(() =>
          refreshIn(spot, { remote }).pipe(Effect.provideService(GhPriority, run.priority)),
        ).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (!run.dirty) {
                queuedRuns.delete(key);
                return Effect.void;
              }
              run.dirty = false;
              return loop;
            }),
          ),
        );
        return FiberMap.run(
          refreshers,
          key,
          loop.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (queuedRuns.get(key) === run) queuedRuns.delete(key);
              }),
            ),
          ),
        ).pipe(Effect.asVoid);
      });

    const silence = (id: ThreadId) =>
      Effect.gen(function* () {
        rounds.delete(id);
        pendingRounds.delete(id);
        yield* FiberMap.remove(roundTimers, id);
        for (const key of [...checks.keys(), ...awaitingNotice]) {
          if (key === id || key.startsWith(`${id}|`)) yield* stopWatching(key);
        }
        userChecks.delete(id);
        awaitingUserNotice.delete(id);
        yield* FiberMap.remove(userNotices, id);
      });

    const forget = (key: string) =>
      Effect.gen(function* () {
        states.delete(key);
        skippedSweeps.delete(key);
        localReadAt.delete(key);
        lastRemoteAt.delete(key);
        reconciledAt.delete(key);
        pushedReadAt.delete(key);
        expectingUntil.delete(key);
        yield* FiberMap.remove(pushedReads, key);
        yield* FiberMap.remove(refreshers, refresherKey(key, true));
        yield* FiberMap.remove(refreshers, refresherKey(key, false));
      });

    const sync = syncLock.withPermits(1)(
      Effect.gen(function* () {
        const allThreads = yield* store.listThreads;
        const parked = new Set(allThreads.filter((t) => t.parked).map((t) => t.id));
        for (const id of answered.keys()) if (!parked.has(id)) answered.delete(id);
        const live = new Map(allThreads.map((t) => [t.id, new Set(targetsOf(t).map(extraKey))]));
        for (const [id, keys] of missing) {
          const targets = live.get(id);
          for (const key of keys) if (targets?.has(key) !== true) keys.delete(key);
          if (keys.size === 0) missing.delete(id);
        }
        const threads = yield* openThreads;
        const wanted = new Map(
          threads
            .filter((t) => !t.parked)
            .map((t) => [checkoutKey(t), spotOf(effectiveCheckout(t))]),
        );
        const kept = new Set(threads.map((t) => checkoutKey(t)));
        for (const key of held.keys()) {
          wanted.delete(key);
          kept.delete(key);
        }
        for (const key of watched) {
          if (wanted.has(key)) continue;
          watched.delete(key);
          yield* FiberMap.remove(watchers, key);
          liveWatched.delete(key);
          if (!kept.has(key)) yield* forget(key);
        }
        for (const key of sweptOnly) {
          if (!kept.has(key)) yield* forget(key);
        }
        sweptOnly.clear();
        for (const key of kept) if (!wanted.has(key)) sweptOnly.add(key);
        for (const [key, spot] of wanted) {
          if (watched.has(key)) continue;
          watched.add(key);
          yield* FiberMap.run(
            watchers,
            key,
            refreshIn(spot, { remote: config.sweepInterval !== undefined }).pipe(
              Effect.andThen(
                Stream.runForEach(gitOn(spot).watch([spot.path]), (change) =>
                  Effect.suspend(() => {
                    if (change.live) liveWatched.add(key);
                    else liveWatched.delete(key);
                    localReadAt.set(key, sweeps);
                    return refreshIn(spot, { remote: false, reuseLocal: true });
                  }),
                ),
              ),
              Effect.ensuring(Effect.sync(() => liveWatched.delete(key))),
            ),
          );
        }
        const open = new Set(threads.map((t) => t.id));
        for (const id of published.keys()) {
          if (open.has(id)) continue;
          published.delete(id);
          checkedPrs.delete(id);
          boundPrs.delete(id);
          extraBadges.delete(id);
          yield* silence(id);
        }
        for (const thread of threads) if (thread.parked) yield* silence(thread.id);
        for (const thread of threads) {
          const state = states.get(checkoutKey(thread));
          if (state !== undefined) yield* publishTo(thread, threadState(thread, state));
        }
      }),
    );

    const unwatched = (threads: ReadonlyArray<Thread>) =>
      Option.isNone(visibility)
        ? Effect.succeed(false)
        : Effect.forEach(threads, (t) => visibility.value.rebaseGated(t.id)).pipe(
            Effect.map((gated) => gated.length > 0 && gated.every(Boolean)),
          );

    const publishElsewhere = (threads: ReadonlyArray<Thread>) =>
      Effect.gen(function* () {
        const found = yield* discoverPrsElsewhere(
          threads.filter((thread) => isLocalHost(effectiveCheckout(thread))),
          (key) => states.get(key),
          () => {
            elsewhereRead = undefined;
          },
        ).pipe(
          Effect.provideService(OpenPrs, openPrs),
          Effect.provideService(Proc, proc),
          Effect.provideService(Worktrees, worktrees),
        );
        for (const [key, elsewhere] of found) {
          yield* locks.withLock(
            key,
            Effect.gen(function* () {
              if (held.has(key)) return;
              const state = states.get(key);
              if (state === undefined || state.pr !== undefined) return;
              if (JSON.stringify(state.prElsewhere) === JSON.stringify(elsewhere)) return;
              const { prElsewhere: _previous, ...rest } = state;
              const next: GitState =
                elsewhere === undefined ? rest : { ...rest, prElsewhere: elsewhere };
              states.set(key, next);
              for (const thread of threads) {
                if (checkoutKey(thread) === key)
                  yield* publishTo(thread, threadState(thread, next));
              }
            }),
          );
        }
      });

    const elsewhereInputs = (threads: ReadonlyArray<Thread>) =>
      JSON.stringify(
        threads.map((thread) => {
          const key = checkoutKey(thread);
          const state = states.get(key);
          const own = state?.pr;
          return [
            thread.id,
            key,
            held.has(key),
            thread.boundPr !== undefined,
            thread.role,
            thread.workspaceId,
            thread.spawnedBy,
            thread.checkout,
            state?.repo,
            state?.branch,
            own === undefined ? undefined : [own.number, own.state, own.title, own.url],
          ];
        }),
      );

    const unhold = (key: string) => {
      const left = (held.get(key) ?? 1) - 1;
      if (left > 0) held.set(key, left);
      else held.delete(key);
    };

    const holdKey = (key: string) =>
      Effect.gen(function* () {
        held.set(key, (held.get(key) ?? 0) + 1);
        yield* sync.pipe(
          Effect.andThen(locks.withLock(key, Effect.void)),
          Effect.onInterrupt(() => Effect.sync(() => unhold(key)).pipe(Effect.andThen(sync))),
        );
        let released = false;
        return Effect.suspend(() => {
          if (released) return Effect.void;
          released = true;
          unhold(key);
          return sync;
        });
      });

    const hold = (path: string) =>
      Effect.gen(function* () {
        const keys = [...new Set((yield* spotsAt(path)).map(spotKey))];
        const releases = yield* Effect.forEach(keys, holdKey);
        return Effect.forEach(releases, (release) => release, { discard: true });
      });

    const checkoutsOf = (threads: ReadonlyArray<Thread>) => {
      const byPath = new Map<string, { spot: Spot; threads: Array<Thread> }>();
      for (const thread of threads) {
        const key = checkoutKey(thread);
        if (held.has(key)) continue;
        const entry = byPath.get(key) ?? { spot: spotOf(effectiveCheckout(thread)), threads: [] };
        entry.threads.push(thread);
        byPath.set(key, entry);
      }
      return byPath;
    };

    const attentionOf = (threads: ReadonlyArray<Thread>) =>
      Option.isNone(visibility)
        ? Effect.succeed("listed" as const)
        : Effect.forEach(threads, (t) => visibility.value.attention(t.id)).pipe(
            Effect.map(closestAttention),
          );

    const lastTouched = (threads: ReadonlyArray<Thread>) =>
      Effect.forEach(threads, (t) =>
        Option.isNone(visibility)
          ? Effect.succeed(t.lastActivityAt)
          : visibility.value
              .lastFocusedAt(t.id)
              .pipe(Effect.map((focusedAt) => Math.max(t.lastActivityAt, focusedAt ?? 0))),
      ).pipe(Effect.map((each) => Math.max(0, ...each)));

    const primeBadges = (entries: Iterable<{ spot: Spot; threads: ReadonlyArray<Thread> }>) =>
      Effect.gen(function* () {
        const extras = affordsExtras(yield* budget.window("graphql"));
        yield* pr.prime(
          [...entries].flatMap(({ spot, threads }) => {
            const state = states.get(spotKey(spot));
            const reads = checkoutReads(threads, true);
            const here = spot.hostId === LOCAL_HOST_ID && reads.remote;
            const path = spot.hostId === LOCAL_HOST_ID ? spot.path : tmpdir();
            const numbered = threads.flatMap((thread) => {
              const bound = state === undefined ? undefined : boundElsewhere(thread, state);
              return [
                ...(bound === undefined
                  ? []
                  : [
                      {
                        repo: bound.repo,
                        number: bound.number,
                        reviews: extras && wantsReviews(thread),
                      },
                    ]),
                ...(thread.extraPrs ?? []).map(({ repo, number }) => ({ repo, number })),
                ...(thread.parked ? [] : prWatches.forThread(thread.id)).map((watch) => ({
                  repo: watch.repo,
                  number: watch.number,
                  reviews: extras && watch.reviews === true,
                })),
              ].map((ref) => ({ ref, caller: threadCaller(thread.id) }));
            });
            return [
              ...(here ? [{ cwd: path, caller: threadCaller(reads.owner ?? "") }] : []),
              ...numbered.map(({ ref, caller }) => ({ cwd: path, bound: ref, caller })),
            ];
          }),
        );
      });

    const reconcileDue = (key: string, now: number) =>
      now - (reconciledAt.get(key) ?? -Infinity) >= Duration.toMillis(PUSHED_RECONCILE_EVERY);

    const pushedReads = yield* FiberMap.make<string>();
    const pushedReadAt = new Map<string, number>();

    const pushed: RepoEvents["Service"]["pushed"] = (event) =>
      Effect.gen(function* () {
        if (!(yield* eventsPushed)) return 0;
        const touched = [...checkoutsOf(yield* openThreads)].filter(([key, entry]) =>
          pushedEventTouches(
            event,
            states.get(key),
            entry.threads,
            prWatches.forThreads(entry.threads.map((thread) => thread.id)),
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        for (const [key, entry] of touched) {
          const wait = Math.max(
            Duration.toMillis(PUSHED_EVENT_SETTLE),
            (pushedReadAt.get(key) ?? -Infinity) + Duration.toMillis(PUSHED_READ_APART) - now,
          );
          yield* FiberMap.run(
            pushedReads,
            key,
            Effect.sleep(Duration.millis(wait)).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  if ((yield* backoff.consecutive) > 0) {
                    reconciledAt.delete(key);
                    return;
                  }
                  pushedReadAt.set(key, yield* Clock.currentTimeMillis);
                  invalidatePrBadges();
                  yield* requestRefresh(entry.spot, true, "background");
                }),
              ),
            ),
            { onlyIfMissing: true },
          );
        }
        return touched.length;
      });

    const sweepAt = (level: ActivityLevel, catchUp = false) =>
      Effect.gen(function* () {
        const threads = yield* openThreads;
        const byPath = checkoutsOf(threads);
        const pass = sweeps++;
        const scanElsewhere = pass % WORK_ELSEWHERE_SWEEPS === 0;
        const quotaHeld = !(yield* budget.admit("graphql", "background")).allowed;
        const now = yield* Clock.currentTimeMillis;
        const pushedNow = yield* eventsPushed;
        const tiered = yield* Effect.forEach(byPath, ([key, entry]) =>
          Effect.gen(function* () {
            const parked = entry.threads.every((t) => t.parked);
            const attention = parked ? "listed" : yield* attentionOf(entry.threads);
            const live = liveWatched.has(key);
            const localDue =
              catchUp ||
              sweeps - (localReadAt.get(key) ?? -Infinity) >= localEvery(attention, live) ||
              (live && !(yield* thereHere(entry.spot)));
            if (quotaHeld) return { entry, parked, localDue, tier: "local" as const };
            if (pushedNow && !reconcileDue(key, now)) {
              return { entry, parked, localDue, tier: "local" as const };
            }
            const state = states.get(key);
            const burst = now < (expectingUntil.get(key) ?? 0);
            const cadence = lookupEvery({
              attention,
              followsOpen: entry.threads.some((t) => {
                if (waitsOnPr(t)) return true;
                const shown = published.get(t.id);
                return shown !== undefined && anyPrOpen(completionPrs(t, shown));
              }),
              watched: entry.threads.some((t) => hasWatch(t) || waitsOnPr(t)),
              idleMs: now - (yield* lastTouched(entry.threads)),
              burst,
              ...(parked ? {} : { pr: state?.pr, head: state?.head }),
              level,
            });
            const every = parked && !burst ? Math.max(cadence, PARKED_LOOKUP_EVERY) : cadence;
            const tier = sweepTier({
              gated: parked || (yield* unwatched(entry.threads)),
              skipped: skippedSweeps.get(key) ?? 0,
              every: catchUp && Number.isFinite(every) ? 1 : every,
            });
            if (tier === "local") skippedSweeps.set(key, (skippedSweeps.get(key) ?? 0) + 1);
            else skippedSweeps.delete(key);
            return { entry, parked, localDue, tier };
          }),
        );
        const swept = yield* Effect.filter(tiered, ({ entry, parked, localDue, tier }) =>
          !parked
            ? Effect.succeed(tier !== "local" || localDue)
            : tier === "local"
              ? Effect.succeed(false)
              : thereHere(entry.spot),
        );
        yield* primeBadges(swept.filter(({ tier }) => tier !== "local").map(({ entry }) => entry));
        yield* Effect.forEach(
          swept,
          ({ entry, parked, localDue, tier }) =>
            refreshIn(
              entry.spot,
              {
                remote: tier !== "local",
                rebase: tier === "full",
                scanElsewhere: scanElsewhere && tier === "full",
                reuseLocal: !parked && !localDue,
              },
              entry.threads,
            ),
          { concurrency: config.sweepConcurrency, discard: true },
        );
        const inputs = elsewhereInputs(threads);
        if (catchUp || scanElsewhere || inputs !== elsewhereRead) {
          elsewhereRead = inputs;
          yield* publishElsewhere(threads);
        }
      });

    const sweep = sweepAt("active");

    const sweepWatched = Effect.gen(function* () {
      if (!(yield* budget.admit("graphql", "background")).allowed) return;
      const watchedThreads = (yield* openThreads).filter(
        (t) => !t.parked && (hasWatch(t) || waitsOnPr(t)),
      );
      const all = [...checkoutsOf(watchedThreads).values()];
      const now = yield* Clock.currentTimeMillis;
      const entries = (yield* eventsPushed)
        ? all.filter((entry) => reconcileDue(spotKey(entry.spot), now))
        : all;
      yield* primeBadges(entries);
      yield* Effect.forEach(
        entries,
        (entry) =>
          refreshIn(
            entry.spot,
            { remote: true, rebase: false, scanElsewhere: false, reuseLocal: true },
            entry.threads,
          ),
        { concurrency: config.sweepConcurrency, discard: true },
      );
    });

    yield* sync;
    const syncChanges = upsertsChanging(besidesActivity);
    yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
      Stream.filter(
        (event) =>
          (event.type === "thread.upsert" || event.type === "thread.removed") && syncChanges(event),
      ),
      Stream.runForEach(() => sync),
      Effect.forkScoped,
    );
    yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
      Stream.filter(
        upsertsChanging((t) => JSON.stringify([t.parked, t.boundPr ?? null, t.extraPrs ?? null])),
      ),
      Stream.runForEach((event) =>
        event.type !== "thread.upsert"
          ? Effect.void
          : Effect.gen(function* () {
              const thread = yield* store.getThread(event.thread.id);
              if (prunedMarks(thread) !== thread) {
                yield* runtimes.updateThread(thread.id, prunedMarks);
              }
              const monitored = new Set(
                thread.parked
                  ? []
                  : [
                      ...(thread.boundPr?.monitor === true ? [ciNoticeKey(thread.boundPr)] : []),
                      ...(thread.extraPrs ?? []).flatMap((extra) =>
                        extra.monitor ? [ciNoticeKey(extra)] : [],
                      ),
                    ],
              );
              yield* runtimes.dropNotices(
                thread.id,
                (key) => key.startsWith(CI_NOTICE) && !monitored.has(key),
              );
            }).pipe(Effect.ignore),
      ),
      Effect.forkScoped,
    );
    yield* Queue.take(refreshes.requests).pipe(
      Effect.flatMap(({ cwd, remote, expectChange, priority }) =>
        Effect.gen(function* () {
          const spots = yield* spotsAt(cwd);
          if (expectChange === true) {
            const until = (yield* Clock.currentTimeMillis) + Duration.toMillis(EXPECT_CHANGE_FOR);
            for (const spot of spots) expectingUntil.set(spotKey(spot), until);
          }
          yield* Effect.forEach(spots, (spot) => requestRefresh(spot, remote, priority), {
            discard: true,
          });
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    const backoff = yield* makePollBackoff("gitstate", config.sweepInterval ?? Duration.zero);
    let announced = false;

    const nextSweepDelay = (
      level: ActivityLevel,
      refusedBefore: number,
      checkouts: number,
      reviewed: number,
    ) =>
      Effect.gen(function* () {
        const observation = yield* rateLimits.observed("core");
        if (observation.count > refusedBefore) {
          const delay = yield* budget.paceBackground(
            "graphql",
            yield* backoff.limited(observation.signal),
            sweepCost(checkouts, reviewed),
          );
          if (!announced) {
            announced = true;
            yield* hub.publish({
              type: "notify",
              kind: "info",
              title: "GitHub rate limit reached",
              body: `PR badges pause for about ${Math.max(1, Math.round(Duration.toMillis(delay) / 60_000))} min`,
            });
          }
          return delay;
        }
        announced = false;
        return yield* budget.paceBackground(
          "graphql",
          yield* backoff.recovered(activityMultiplier(level)),
          sweepCost(checkouts, reviewed),
        );
      });

    let away = false;
    if (config.sweepInterval !== undefined) {
      yield* Effect.gen(function* () {
        if (Option.isSome(activity) && !onScreen(yield* activity.value.level)) away = true;
        const level = Option.isNone(activity)
          ? "active"
          : yield* activity.value.awaitLevel((next) => next !== "paused");
        const refusedBefore = (yield* rateLimits.observed("core")).count;
        yield* onScreen(level) ? sweepAt(level, away) : sweepWatched;
        const after = Option.isNone(activity) ? "active" : yield* activity.value.level;
        away = !onScreen(after);
        const open = yield* openThreads;
        const reviewed = open.filter((t) => boundPrs.has(t.id) && wantsReviews(t)).length;
        const wait = Effect.sleep(
          yield* nextSweepDelay(after, refusedBefore, checkoutsOf(open).size, reviewed),
        );
        const healthy = (yield* backoff.consecutive) === 0;
        yield* Option.isSome(activity) && healthy && !onScreen(after)
          ? Effect.raceFirst(wait, activity.value.awaitActive)
          : wait;
      }).pipe(asBackground, Effect.forever, Effect.forkScoped);
    }
    if (Option.isSome(visibility) && config.sweepInterval !== undefined) {
      yield* visibility.value.focusChanges.pipe(
        Stream.runForEach((threadId) =>
          Effect.gen(function* () {
            const thread = (yield* openThreads).find((t) => t.id === threadId);
            if (thread === undefined) return;
            const key = checkoutKey(thread);
            const age = (yield* Clock.currentTimeMillis) - (lastRemoteAt.get(key) ?? 0);
            if (age < Duration.toMillis(FOCUS_FRESH_FOR)) return;
            skippedSweeps.delete(key);
            yield* requestRefresh(spotOf(effectiveCheckout(thread)), true);
          }),
        ),
        Effect.forkScoped,
      );
    }
    if (Option.isSome(visibility)) {
      yield* visibility.value.revealed.pipe(
        Stream.runForEach((revealed) =>
          Effect.gen(function* () {
            const threads = yield* openThreads;
            const paths = new Map(
              threads
                .filter((t) => revealed === "all" || revealed.includes(t.id))
                .map((t) => [checkoutKey(t), spotOf(effectiveCheckout(t))]),
            );
            const remote = config.sweepInterval !== undefined && (yield* backoff.consecutive) === 0;
            yield* Effect.forEach(paths.values(), (spot) => refreshIn(spot, { remote }), {
              concurrency: config.sweepConcurrency,
              discard: true,
            });
          }),
        ),
        Effect.forkScoped,
      );
    }

    const badgeFor: GitStatePublisherShape["badgeFor"] = (thread) =>
      Effect.sync(() => {
        if (thread.role === "orchestrator") return undefined;
        const state = states.get(checkoutKey(thread));
        const elsewhere =
          thread.boundPr !== undefined &&
          (state === undefined || boundElsewhere(thread, state) !== undefined);
        return elsewhere ? boundPrs.get(thread.id) : state?.pr;
      });

    const stateForThread: GitStatePublisherShape["stateForThread"] = (thread) =>
      Effect.suspend(() => {
        const state = states.get(checkoutKey(thread));
        return state === undefined
          ? Effect.succeed(undefined)
          : namedChecks(threadState(thread, state));
      });

    const reconcile: GitStatePublisherShape["reconcile"] = (thread, seen) =>
      Effect.gen(function* () {
        const badge = yield* badgeFor(thread);
        if (badge?.state !== "OPEN" || seen.state === undefined || seen.state === "OPEN") return;
        if (badge.number !== seen.number || badge.url.toLowerCase() !== seen.url.toLowerCase())
          return;
        const key = checkoutKey(thread);
        const until = (yield* Clock.currentTimeMillis) + Duration.toMillis(EXPECT_CHANGE_FOR);
        expectingUntil.set(key, until);
        skippedSweeps.delete(key);
        invalidatePrBadges();
        yield* requestRefresh(spotOf(effectiveCheckout(thread)), true);
      });

    const watchPrs: GitStatePublisherShape["watchPrs"] = (owner, watches) =>
      Effect.sync(() => prWatches.replace(owner, watches));

    const watchedBadge: GitStatePublisherShape["watchedBadge"] = (ref) =>
      Effect.sync(() => {
        const kept = prWatches.badge(ref);
        if (kept !== undefined) return kept;
        for (const state of published.values()) {
          for (const badge of [state.pr, ...(state.extraPrs ?? [])]) {
            if (badge !== undefined && badge.stale === undefined && isBadgeOf(badge, ref))
              return badge;
          }
        }
        return undefined;
      });

    const lookupPr: GitStatePublisherShape["lookupPr"] = (thread, ref) =>
      Effect.gen(function* () {
        const cwd = yield* ghFolderOf(effectiveCheckout(thread));
        if (Option.isSome(tools) && !(yield* tools.value.ghReady)) return Option.none();
        const found = yield* pr
          .status(cwd, { repo: ref.repo, number: ref.number, reviews: ref.reviews === true })
          .pipe(forThread(thread.id), Effect.option);
        if (Option.isSome(found) && found.value !== undefined) {
          if (prWatches.has(ref)) yield* noteWatched(found.value);
          else prWatches.remember(ref, found.value);
        }
        return found;
      });

    const service: GitStatePublisherShape = {
      stateFor: (path) =>
        Effect.map(spotsAt(path), (spots) =>
          spots.length === 1 ? states.get(spotKey(spots[0]!)) : undefined,
        ),
      badgeFor,
      watchPrs,
      watchedBadge,
      lookupPr,
      extraBadgesFor: (thread) =>
        Effect.sync(() => [...(extraBadges.get(thread.id)?.values() ?? [])]),
      stateForThread,
      reconcile,
      checksRead: (thread) => publishCheckNames(thread.id),
      refresh,
      sweep,
      sync,
      hold,
      observe: (observer, options) =>
        Effect.gen(function* () {
          observers.push(observer);
          if (options?.replay !== true) return;
          for (const { thread } of yield* runtimes.snapshot) {
            const state = published.get(thread.id);
            if (state !== undefined) yield* observer.onState(thread, state);
          }
        }),
    };
    return Context.make(GitStatePublisher, service).pipe(Context.add(RepoEvents, { pushed }));
  }),
);
