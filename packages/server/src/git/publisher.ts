// Push-based git state for every open thread's checkout: a watcher per checkout (local tier), network
// sweeps (PR badge, throttled fetch), `git.state` events, auto-settle, and the PR check monitor.

import {
  anyPrOpen,
  effectiveCheckout,
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
} from "@gram/contracts";
import {
  GitStateRuntime,
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
import { EventHub } from "../events/event-hub.ts";
import { besidesActivity, upsertsChanging } from "../events/upsert-changes.ts";
import { branchPrOf, completionStep, type CompletionStep } from "./completion.ts";
import { folderExists } from "../fs/folders.ts";
import { isBadgeOf, markOf, prunedMarks, withMonitorMark, type PrRef } from "./extra-prs.ts";
import { activityMultiplier, makePollBackoff } from "../github/poll-backoff.ts";
import { affordsExtras, asBackground, GhBudget, GhPriority } from "../github/budget.ts";
import { OpenPrs } from "../github/open-prs.ts";
import { RateLimitMonitor } from "../github/rate-limit-monitor.ts";
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
    ? `CI failed on #${number}: ${failing.join(", ")}`
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

/** How long a checkout is asked about on every sweep after something GitHub will react to. */
const EXPECT_CHANGE_FOR = Duration.minutes(3);

/**
 * How fresh a thread's GitHub state has to be for moving into it not to refresh it: the sweep's own
 * answer from a moment ago is as good as a new one.
 */
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
 * Sweeps from one local read of a checkout to the next, by how closely it is looked at: every sweep
 * for one a pane shows, and never for one nobody can see, whose watcher and coming back on screen
 * (`ThreadVisibility.revealed`) bring it up to date.
 */
export const localEvery = (attention: Attention): number => {
  if (attention === "focused" || attention === "shown") return 1;
  return attention === "listed" ? LISTED_LOCAL_EVERY : Number.POSITIVE_INFINITY;
};

/** The refreshers key for a checkout's queued local or remote refresh. */
const refresherKey = (key: string, remote: boolean) => `${key}|${remote}`;

/** A state a thread was sent, to decide its completion on (`completionStep`). */
interface CompletionCheck {
  readonly threadId: ThreadId;
  /** The bindings and checkout `state` was for (`bindingOf`): one queued before a rebind is stale. */
  readonly binding: string;
  readonly state: GitState;
  readonly prs: ReadonlyArray<PrStatus | undefined>;
}

/** An extra PR within its thread; GitHub treats `owner/repo` case-insensitively. */
const extraKey = (extra: Pick<BoundPr, "repo" | "number">) =>
  `${extra.repo.toLowerCase()}#${extra.number}`;

/** The PRs a thread is bound to: its main one, then the ones it follows beside it. */
const targetsOf = (thread: Thread) => [
  ...(thread.boundPr === undefined ? [] : [thread.boundPr]),
  ...(thread.extraPrs ?? []),
];

/** A thread's bound PRs as one comparable string. */
const targetsKey = (thread: Thread) => targetsOf(thread).map(extraKey).toSorted().join(" ");

/** What a thread's completion facts are about: its bound PRs and the checkout it works in. */
const bindingOf = (thread: Thread) =>
  `${targetsKey(thread)}@${samePathKey(effectiveCheckout(thread).path)}`;

/** The CI watcher's key for one of a thread's extra PRs; a bare thread id is its `boundPr`. */
const extraWatchKey = (threadId: ThreadId, extra: Pick<BoundPr, "repo" | "number">) =>
  `${threadId}|${extraKey(extra)}`;

const CI_NOTICE = "ci:";

/**
 * The CI rollup a monitor last saw of `head`, from the mark kept with its binding: a head it never
 * saw started out pending. `undefined` without a mark, when the first look is only a baseline.
 */
const markedCi = (
  mark: MonitorMark | undefined,
  head: string | undefined,
): ChecksRollup | undefined => {
  if (mark?.ci === undefined) return undefined;
  return head === undefined || mark.head === head ? mark.ci : "pending";
};

/** The `sendNotice` key of the CI message for `pr`, so a rebound thread drops the old PR's. */
const ciNoticeKey = (pr: Pick<BoundPr, "repo" | "number">) => `${CI_NOTICE}${extraKey(pr)}`;

/** A bound PR the branch lookup can't see: another number, or a repo other than `origin`. */
const boundElsewhere = (thread: Thread, state: GitState) => {
  const bound = thread.boundPr;
  if (bound === undefined) return undefined;
  const sameRepo =
    state.origin === undefined || state.origin.toLowerCase() === bound.repo.toLowerCase();
  return state.pr?.number === bound.number && sameRepo ? undefined : bound;
};

/**
 * Whether the thread's bound PR is looked up with its reviews: its review monitor and a merge
 * waiting on the bot's approval need them, and a branch's PR has them anyway.
 */
const wantsReviews = (thread: Thread) =>
  (thread.boundPr?.reviewMonitor === true || thread.boundPr?.mergeWhenReady !== undefined) &&
  !thread.parked;

/**
 * About what a sweep of `checkouts` spends: a point a document, and review threads now and then. A
 * bound PR read with its reviews (`reviewed`) costs about what a checkout does, measured: its
 * reviews a twentieth of a point, its threads half a point every couple of minutes.
 */
const sweepCost = (checkouts: number, reviewed = 0) =>
  Math.max(1, Math.ceil((checkouts + reviewed) * 0.15));

export const GitStatePublisherLive = Layer.effect(
  GitStatePublisher,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const hub = yield* EventHub;
    const runtimes = yield* ThreadRuntimes;
    const gitState = yield* GitStateRuntime;
    const pr = yield* Pr;
    const config = yield* GitServerConfig;
    const refreshes = yield* GitRefresh;
    const reviewBots = yield* ReviewBots;
    const proc = yield* Proc;
    const worktrees = yield* Worktrees;
    const rateLimits = yield* RateLimitMonitor;
    const openPrs = yield* OpenPrs;
    const budget = yield* GhBudget;
    const tools = yield* Effect.serviceOption(Tools);
    const visibility = yield* Effect.serviceOption(ThreadVisibility);
    const activity = yield* Effect.serviceOption(AppActivity);

    const states = new Map<string, GitState>();
    const published = new Map<ThreadId, GitState>();
    /** Keyed by thread for its `boundPr`, and by `extraWatchKey` for each extra PR it watches. */
    const checks = new Map<string, ChecksRollup>();
    /**
     * The latest completed bot review id seen per thread, and on which PR's badge: another PR's is
     * a baseline, not a round.
     */
    const rounds = new Map<ThreadId, { readonly url: string; readonly reviewId: string }>();
    /** Rounds waiting out their quiet window, per thread. */
    const pendingRounds = new Map<ThreadId, string>();
    const roundTimers = yield* FiberMap.make<ThreadId>();
    const locks = makeKeyedLock<string>();
    const watched = new Set<string>();
    /** Checkouts only lingering parked threads are on: their state is kept and swept, not watched. */
    const sweptOnly = new Set<string>();
    const syncLock = yield* Semaphore.make(1);
    const watchers = yield* FiberMap.make<string>();
    // Runs before the map's own finalizer, which would interrupt every watch at once: releases them
    // one at a time, each unsubscribe awaited. A Windows worker crashed with an access violation
    // after tearing down five checkouts' @parcel/watcher subscriptions together.
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...watched], (key) => FiberMap.remove(watchers, key), { discard: true }),
    );
    const refreshers = yield* FiberMap.make<string>();
    const ciNotices = yield* FiberMap.make<string>();
    const awaitingNotice = new Set<string>();
    /** CI notices past their delay and on their way, whose settle isn't the mark's until sent. */
    const sendingNotice = new Set<string>();
    /** Per thread: the badges of its `extraPrs`, by `extraKey`. */
    const extraBadges = new Map<ThreadId, Map<string, PrStatus>>();
    /** Per thread: its bound PR when that isn't the checkout's own PR (another repo or number). */
    const boundPrs = new Map<ThreadId, PrStatus>();
    const prWatches = makePrWatches();
    /** The user's CI notices: every open PR thread, once per head commit and outcome. */
    const userNotices = yield* FiberMap.make<ThreadId>();
    const userChecks = new Map<ThreadId, ChecksRollup>();
    const awaitingUserNotice = new Set<ThreadId>();
    const notifiedSettles = new Set<string>();
    const observers: Array<GitStateObserver> = [];
    /** Checkouts held out of watching, sweeps and refreshes, with how many holds each has. */
    const held = new Map<string, number>();
    /** Per checkout: sweeps in a row that left its network tier alone, for `sweepTier`. */
    const skippedSweeps = new Map<string, number>();
    /** Sweeps started so far. */
    let sweeps = 0;
    /** Per checkout: the sweep count at its last local read of its own, or by its watcher. */
    const localReadAt = new Map<string, number>();
    /** What `publishElsewhere` last read of the open checkouts, from `elsewhereInputs`. */
    let elsewhereRead: string | undefined;

    /** An open thread whose sweeps look up a PR it waits on. */
    const waitsOnPr = (thread: Thread) =>
      !thread.parked && prWatches.forThread(thread.id).length > 0;

    /** Records the watched badge before telling observers, so a reentrant read sees it. */
    const noteWatched = (badge: PrStatus) =>
      Effect.gen(function* () {
        const next = prWatches.note(badge);
        if (next === undefined) return;
        for (const observer of observers) {
          if (observer.onWatchedPr !== undefined) yield* observer.onWatchedPr(next);
        }
      });

    /**
     * A parked (archived) thread whose last badge still has a PR open. It is swept until the PR
     * merges or closes, or the badge it was archived with would never move: a thread is often
     * archived the moment its PR merges, before any sweep has seen it. A PR it's bound to with no
     * badge yet (every parked thread's after a restart, or one whose lookup failed) is swept until
     * GitHub answers, completed or not: completing a thread says nothing about its PR. With nothing
     * bound, one that has no state yet is swept for its branch's PR unless it's completed, since a
     * merge settles its thread and idle ones are completed within days.
     */
    const lingers = (thread: Thread) => {
      if (!thread.parked || answered.get(thread.id) === targetsKey(thread)) return false;
      const state = published.get(thread.id);
      const badges = [state?.pr, ...(state?.extraPrs ?? [])].filter(
        (badge): badge is PrStatus => badge !== undefined,
      );
      const gone = missing.get(thread.id);
      const isGone = (target: Pick<BoundPr, "repo" | "number">) =>
        gone?.has(extraKey(target)) === true;
      // Bound, only its PRs' badges count: the checkout's own PR, or a previous binding's, isn't it.
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

    /**
     * Parked threads a lookup has answered with nothing left open, with the PRs they were bound to
     * then. Their state is then dropped like any parked thread's, and without this they would read
     * as never answered and linger again; binding another PR while parked is a new question.
     */
    const answered = new Map<ThreadId, string>();
    /**
     * Per thread: the bound PRs, by `extraKey`, that GitHub answered it has no such PR for. Kept for
     * as long as the thread exists and is bound to them.
     */
    const missing = new Map<ThreadId, Set<string>>();

    /**
     * Records whether GitHub has `target` for `thread`, from a lookup that succeeded; true when that
     * changed what is known.
     */
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

    /** The threads whose state is kept and published: the open ones, and the lingering parked ones. */
    const openThreads = store.listThreads.pipe(
      Effect.map((threads) => threads.filter((t) => !t.parked || lingers(t))),
    );

    /**
     * What a thread sees: its checkout's state, with a bound PR from elsewhere as the badge, and no
     * work-elsewhere advisory for a worktree the thread follows. An orchestrator sees no PR at all:
     * its checkout's branch PR is none of the ones it drives, and published, a merge would complete
     * the orchestrator and a red build would wake it.
     */
    const threadState = (thread: Thread, state: GitState): GitState => {
      if (thread.role === "orchestrator") {
        const { pr: _pr, extraPrs: _extras, prElsewhere: _elsewhere, ...rest } = state;
        return rest;
      }
      let next = state;
      const boundTo = boundElsewhere(thread, state);
      if (boundTo !== undefined) {
        // Until the bound PR's own badge is in, or once GitHub says it has none, the checkout's PR
        // (or a previous binding's badge) isn't the thread's and mustn't stand in for it.
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
      // The cue is kept per checkout, and an ordinary thread may share one with the orchestrator.
      if (next.prElsewhere !== undefined && !wantsPrElsewhere(thread, next)) {
        const { prElsewhere, ...rest } = next;
        void prElsewhere;
        next = rest;
      }
      return next;
    };

    /**
     * Looks up the bound PRs from elsewhere for the threads on `key`, `inventory` when the sweep has
     * them already; true when any changed.
     */
    const refreshBound = (
      path: string,
      key: string,
      state: GitState,
      inventory?: ReadonlyArray<Thread>,
      cwd: string = path,
    ) =>
      Effect.gen(function* () {
        const mine =
          inventory ??
          (yield* openThreads).filter(
            (thread) => samePathKey(effectiveCheckout(thread).path) === key,
          );
        const extras = affordsExtras(yield* budget.window("graphql"));
        let changed = false;
        // Concurrent, so `Pr.status`'s resolver collapses these lookups into one `gh` document.
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
                .pipe(Effect.option);
              if (Option.isNone(next)) return;
              changed = noteMissing(thread, bound, next.value === undefined) || changed;
              // GitHub has no such PR: its last badge goes, as an extra PR's does.
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
        // The extras ride the same pass, so they join that document instead of adding `gh` runs.
        yield* Effect.forEach(
          mine.flatMap((thread) => (thread.extraPrs ?? []).map((extra) => ({ thread, extra }))),
          ({ thread, extra }) =>
            Effect.gen(function* () {
              const next = yield* pr
                .status(cwd, { repo: extra.repo, number: extra.number })
                .pipe(Effect.option);
              // A failed lookup carries the last badge, as the branch badge does; a lookup that
              // succeeds with no PR means GitHub no longer has it, and its badge goes.
              if (Option.isNone(next)) return;
              // A PR GitHub turns out not to have stops holding the thread's completion open.
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
        // The PRs these threads wait on ride the same document. A failed lookup, or one finding
        // no such PR, leaves the last badge: the wait times out by its own fallback.
        // One lookup per PR across these threads, with the reviews if any of them wants them.
        const waited = prWatches.forThreads(
          mine.filter((thread) => !thread.parked).map((thread) => thread.id),
        );
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

    /**
     * `badge` with the names of its failing gating checks and when they were read, from the last
     * checks read made under its head and rollup (`Pr.seenChecks`, no request), and without names
     * when there is none. A reader ages them out: the state isn't sent again while nothing moves.
     */
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

    /** `state` with `withCheckNames` applied to each of its badges. */
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

    /**
     * Sends `threadId`'s last state again once a checks read has named what failed, so the UI has
     * the names before the next sweep. Nothing else moved, so the observers aren't told again.
     */
    const publishCheckNames = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const last = published.get(threadId);
        if (last === undefined) return;
        const named = yield* namedChecks(last);
        if (JSON.stringify(named) === JSON.stringify(last)) return;
        yield* Effect.uninterruptible(
          Effect.suspend(() => {
            // A newer state went out while the names were looked up: it has its own.
            if (published.get(threadId) !== last) return Effect.void;
            published.set(threadId, named);
            return hub.publish({ type: "git.state", threadId, state: named });
          }),
        );
      });

    /** Names of the failing check runs of `badge`'s PR; `repo` for a PR bound from another repo. */
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
          // The notice still goes out, without the names, when GitHub won't say just now.
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );

    /**
     * Tells the user when an open PR's checks settle: a toast, and a native notification while the
     * window is in the background. Once per head commit and outcome, and a flip back to pending
     * within the delay cancels it, as for the agent's notice.
     */
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

    /** Keeps what a monitor of `ref` saw with the binding, when that isn't what is kept already. */
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

    /** Sends one message into `thread` when `badge`'s checks settle; `repo` for a PR from elsewhere. */
    const watchChecks = (
      key: string,
      thread: Thread,
      target: BoundPr,
      badge: PrStatus,
      repo: string | undefined,
    ) =>
      Effect.gen(function* () {
        // The first look since a restart compares against what the monitor saw before it, so a
        // settle while the app was down is still told.
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
        // A settle that replaces a notice still waiting out its delay counts as settling from pending.
        const from = awaitingNotice.has(key) ? "pending" : previous;
        // A settle owed a notice is kept as seen only once the notice is sent: a restart during
        // the delay still finds it pending, and tells it.
        if (ciMessage(from, badge.checks, [], badge.number) === undefined) {
          return sendingNotice.has(key) ? undefined : yield* mark;
        }
        awaitingNotice.add(key);
        // Checks that flip back to pending within the delay cancel the notice, so one settle sends
        // one message.
        yield* FiberMap.run(
          ciNotices,
          key,
          Effect.gen(function* () {
            yield* Effect.sleep(config.monitorSettleDelay);
            awaitingNotice.delete(key);
            sendingNotice.add(key);
            yield* Effect.gen(function* () {
              // Archived during the delay: `sync` cancels this, but may not have run yet.
              const latest = yield* store.getThread(thread.id).pipe(Effect.option);
              if (Option.isSome(latest) && latest.value.parked) return;
              const failing =
                badge.checks === "failing" ? yield* failingRuns(thread, badge, repo) : [];
              const text =
                ciMessage("pending", badge.checks, failing, badge.number) ?? "CI settled";
              yield* runtimes
                .sendNotice(thread.id, ciNoticeKey(target), { text })
                .pipe(Effect.ignore);
              // The settle this notice told, not whatever was seen while it went.
              yield* mark;
            }).pipe(Effect.ensuring(Effect.sync(() => sendingNotice.delete(key))));
          }),
        );
      });

    const monitor = (thread: Thread, state: GitState) =>
      Effect.gen(function* () {
        const bound = thread.boundPr;
        const badge = state.pr;
        // With the review monitor on, a CI settle joins its review notice instead.
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

    /**
     * The thread's PRs as `completionStep` reads them: what it was sent (`threadPrBadges`), then its
     * branch's own PR when the badge is one bound from elsewhere.
     */
    const completionPrs = (thread: Thread, state: GitState) => {
      const branchPr = branchPrOf(thread, states.get(samePathKey(effectiveCheckout(thread).path)));
      return [...threadPrBadges(thread, state), ...(branchPr === undefined ? [] : [branchPr])];
    };

    /**
     * Settles a thread on a merge and reopens it when work resumes (`completionStep`). The step is
     * decided inside the store's transaction, on the thread as it is then, so a completion the user
     * set meanwhile is judged too.
     */
    const applyCompletion = ({ threadId, binding, state, prs }: CompletionCheck) =>
      Effect.gen(function* () {
        const decided: { step: CompletionStep } = { step: { kind: "none" } };
        const now = yield* Clock.currentTimeMillis;
        const { thread, changed } = yield* runtimes.updateCompletion(threadId, (current) => {
          // Rebound or moved since it was queued: these facts were another binding's, and a PR of
          // the same number elsewhere would settle on them. The rebind publishes its own.
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
        if (!changed || applied.kind !== "settle") return;
        yield* hub.publish({
          type: "notify",
          kind: "done",
          title: `${applied.prs.map((mark) => `#${mark.number}`).join(" and ")} merged`,
          body: thread.title,
          threadId,
        });
      }).pipe(Effect.ignore);

    /**
     * Completion is decided off the refresh, one state at a time in the order they were published: a
     * refresh is interrupted by releasing its checkout or shutting down, and a state is never
     * published to the thread twice.
     */
    const completions = yield* Queue.unbounded<CompletionCheck>();
    /** Per thread: the PRs its last completion check was queued with, as `JSON.stringify`ed. */
    const checkedPrs = new Map<ThreadId, string>();
    yield* Queue.take(completions).pipe(
      Effect.flatMap(applyCompletion),
      Effect.forever,
      Effect.forkScoped,
    );

    /** Publishes the round if, after the quiet window, it's still the latest and nothing is running. */
    const publishRound = (threadId: ThreadId, reviewId: string) =>
      Effect.gen(function* () {
        // The thread's own badge: a PR bound from elsewhere isn't the checkout's.
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

    /**
     * A completed round is a new latest bot summary review with no round running. The first review a
     * thread sees of a PR is only a baseline, so a restart or a rebind doesn't replay old rounds.
     * Every state change while a round is pending restarts its quiet window, so the event carries
     * the settled counts.
     */
    const detectRound = (thread: Thread, state: GitState) =>
      Effect.gen(function* () {
        const badge = state.pr;
        const review = badge?.review;
        const reviewId = review?.latestReviewId;
        if (badge === undefined || review === undefined || reviewId === undefined) return;
        if (review.roundInFlight) return;
        const url = badge.url.toLowerCase();
        // The first look since a restart has the review monitor's mark to go on, if it kept one.
        // A mark that read the reviews and found none is a baseline too: the first round is new.
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
        // The branch's own PR isn't in what a thread bound elsewhere is sent, and can move alone:
        // the ledger reads it, so that is news to the hub and the observers as well.
        if (
          checkedPrs.get(thread.id) === checkKey &&
          (last === state || (last !== undefined && JSON.stringify(last) === JSON.stringify(state)))
        )
          return;
        checkedPrs.set(thread.id, checkKey);
        // Recorded, sent and queued for its completion together: an interrupt between them would
        // drop this state for the UI, or for the settle.
        yield* Effect.uninterruptible(
          Effect.suspend(() => {
            published.set(thread.id, state);
            return hub
              .publish({ type: "git.state", threadId: thread.id, state })
              .pipe(Effect.andThen(Queue.offer(completions, check)));
          }),
        );
        if (thread.parked && !lingers(thread)) answered.set(thread.id, targetsKey(thread));
        // The folder just went: an agent still running there fails every tool it calls.
        if (state.missing === true && last?.missing !== true)
          yield* runtimes.stopInMissingFolder(thread.id);
        // An archived thread's badge is kept true for the user; nobody is told what its CI or
        // review did, and its agent isn't woken over them.
        if (!thread.parked) {
          yield* monitor(thread, state);
          yield* notifyCi(thread, state);
          yield* detectRound(thread, state);
        }
        for (const observer of observers) yield* observer.onState(thread, state);
        // A PR some other thread waits on may be this one's: its badge serves them too.
        for (const badge of [state.pr, ...(state.extraPrs ?? [])]) {
          if (badge !== undefined) yield* noteWatched(badge);
        }
      });

    /**
     * The state of a checkout whose folder is gone: the last one read, marked `missing`, with its PR
     * looked up again by number from `root`, the repo's main checkout, on a network tier. A branch
     * lookup needs the folder; the number is what the last read found.
     */
    const missingState = (
      previous: GitState | undefined,
      recorded: { readonly root?: string | undefined; readonly branch?: string | undefined },
      remote: boolean,
    ) =>
      Effect.gen(function* () {
        // With nothing read since the app started, the branch is the one the thread recorded.
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
          // A lookup by number isn't anchored to the branch. The folder can't move any more, so
          // the anchoring the branch lookup verified stands while the PR's head is the one it saw,
          // and otherwise it is the last HEAD read that the PR's head must equal.
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

    /** The repo's main checkout and the branch the threads on `key` recorded for their checkout. */
    const recordedOf = (key: string, inventory: ReadonlyArray<Thread> | undefined) =>
      Effect.gen(function* () {
        for (const thread of inventory ?? (yield* store.listThreads)) {
          const checkout = effectiveCheckout(thread);
          if (samePathKey(checkout.path) === key && checkout.repoRoot !== undefined)
            return { root: checkout.repoRoot, branch: checkout.branch };
        }
        return {};
      });

    /**
     * `refresh`, with `reuseLocal` for a checkout nothing has changed since its last local read, and
     * the open threads on it when the caller has them, so a sweep reads the thread list once rather
     * than for every checkout it refreshes.
     */
    const refreshIn = (
      path: string,
      options: Parameters<GitStatePublisherShape["refresh"]>[1] & {
        readonly reuseLocal?: boolean;
      },
      inventory?: ReadonlyArray<Thread>,
    ) => {
      const key = samePathKey(path);
      return locks.withLock(
        key,
        Effect.gen(function* () {
          // A held checkout may be being deleted: no git runs in it and no state is put back.
          if (held.has(key)) return;
          const previous = states.get(key);
          if (options.remote) {
            lastRemoteAt.set(key, yield* Clock.currentTimeMillis);
            yield* reviewBots.set(reviewBotsOf(yield* store.getSettings));
          }
          // Deleted outside Gram: no git runs in it, and the state says so.
          const present = yield* gitState.present(path);
          const recorded = present ? {} : yield* recordedOf(key, inventory);
          const root = recorded.root;
          const next = present
            ? yield* gitState
                .snapshot(path, {
                  remote: options.remote,
                  previous,
                  scanConcurrency: config.sweepConcurrency,
                  ...(options.rebase === undefined ? {} : { rebase: options.rebase }),
                  ...(options.scanElsewhere === undefined
                    ? {}
                    : { scanElsewhere: options.scanElsewhere }),
                  ...(options.reuseLocal === undefined ? {} : { reuseLocal: options.reuseLocal }),
                })
                .pipe(Effect.option)
            : Option.some<GitState>(yield* missingState(previous, recorded, options.remote));
          if (Option.isNone(next)) return;
          if (options.reuseLocal !== true) localReadAt.set(key, sweeps);
          // The lookup below can settle an archived thread, which still has to be sent its answer.
          const tracked = new Set((inventory ?? (yield* openThreads)).map((t) => t.id));
          const boundChanged =
            options.remote && (present || root !== undefined)
              ? yield* refreshBound(path, key, next.value, inventory, root ?? path)
              : false;
          if (
            !boundChanged &&
            previous !== undefined &&
            JSON.stringify(previous) === JSON.stringify(next.value)
          )
            return;
          // The hold may have started while git ran.
          if (held.has(key)) return;
          states.set(key, next.value);
          const threads = (yield* store.listThreads).filter(
            (t) => !t.parked || lingers(t) || tracked.has(t.id),
          );
          for (const thread of threads) {
            if (samePathKey(effectiveCheckout(thread).path) === key)
              yield* publishTo(thread, threadState(thread, next.value));
          }
        }),
      );
    };

    const refresh: GitStatePublisherShape["refresh"] = (path, options) => refreshIn(path, options);

    /** When each checkout's network tier last ran, for a focus that needn't refresh what is fresh. */
    const lastRemoteAt = new Map<string, number>();
    /** Until when each checkout is asked about on every sweep, because GitHub is about to react. */
    const expectingUntil = new Map<string, number>();

    /**
     * The running queued refresh per refresher key, whether a request came in during it, and who
     * for: the user's if any of the requests it answers was.
     */
    const queuedRuns = new Map<string, { dirty: boolean; priority: GhPriority }>();

    /**
     * Runs a queued refresh, never replacing one that's running: that would kill its observers mid-
     * flight. Requests during a run coalesce into a single rerun after it, which reads the latest state.
     */
    const requestRefresh = (cwd: string, remote: boolean, priority: GhPriority = "interactive") =>
      Effect.suspend(() => {
        // A held checkout may be being deleted: git mustn't run in it. Its watch refreshes on release.
        if (held.has(samePathKey(cwd))) return Effect.void;
        const key = refresherKey(samePathKey(cwd), remote);
        const running = queuedRuns.get(key);
        if (running !== undefined) {
          running.dirty = true;
          if (priority === "interactive") running.priority = priority;
          return Effect.void;
        }
        const run = { dirty: false, priority };
        queuedRuns.set(key, run);
        // The priority is put back on the refresh itself: it runs in a fiber of the map's, which
        // inherits nothing from whoever asked. Read per pass, so a rerun the user joined is theirs.
        const loop: Effect.Effect<void> = Effect.suspend(() =>
          refresh(cwd, { remote }).pipe(Effect.provideService(GhPriority, run.priority)),
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
          // Interrupted by a release or shutdown: no rerun is owed. A newer run may own the key already.
          loop.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (queuedRuns.get(key) === run) queuedRuns.delete(key);
              }),
            ),
          ),
        ).pipe(Effect.asVoid);
      });

    /** Drops what the thread's CI, round and user notices remember, and cancels any still pending. */
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

    /** Drops everything remembered about a checkout, and cancels its queued refreshes. */
    const forget = (key: string) =>
      Effect.gen(function* () {
        states.delete(key);
        skippedSweeps.delete(key);
        localReadAt.delete(key);
        lastRemoteAt.delete(key);
        expectingUntil.delete(key);
        // A queued refresh left running, or its rerun, would put the dropped state back.
        yield* FiberMap.remove(refreshers, refresherKey(key, true));
        yield* FiberMap.remove(refreshers, refresherKey(key, false));
      });

    /** Align the watchers with the open threads, and hand known states to newly opened threads. */
    const sync = syncLock.withPermits(1)(
      Effect.gen(function* () {
        const allThreads = yield* store.listThreads;
        const parked = new Set(allThreads.filter((t) => t.parked).map((t) => t.id));
        for (const id of answered.keys()) if (!parked.has(id)) answered.delete(id);
        // An open thread keeps them too: its state says which PRs GitHub doesn't have
        // (`missingPrs`), and dropping them would hold its completion open again.
        const live = new Map(allThreads.map((t) => [t.id, new Set(targetsOf(t).map(extraKey))]));
        for (const [id, keys] of missing) {
          const targets = live.get(id);
          for (const key of keys) if (targets?.has(key) !== true) keys.delete(key);
          if (keys.size === 0) missing.delete(id);
        }
        const threads = yield* openThreads;
        // Parking frees the thread's folder: a lingering parked thread's checkout is swept, never
        // watched.
        const wanted = new Map(
          threads
            .filter((t) => !t.parked)
            .map((t) => [samePathKey(effectiveCheckout(t).path), effectiveCheckout(t).path]),
        );
        const kept = new Set(threads.map((t) => samePathKey(effectiveCheckout(t).path)));
        for (const key of held.keys()) {
          wanted.delete(key);
          kept.delete(key);
        }
        for (const key of watched) {
          if (wanted.has(key)) continue;
          watched.delete(key);
          yield* FiberMap.remove(watchers, key);
          if (!kept.has(key)) yield* forget(key);
        }
        for (const key of sweptOnly) {
          if (!kept.has(key)) yield* forget(key);
        }
        sweptOnly.clear();
        for (const key of kept) if (!wanted.has(key)) sweptOnly.add(key);
        for (const [key, path] of wanted) {
          if (watched.has(key)) continue;
          watched.add(key);
          yield* FiberMap.run(
            watchers,
            key,
            refresh(path, { remote: config.sweepInterval !== undefined }).pipe(
              // The watcher has just read the checkout, so the refresh takes that read.
              Effect.andThen(
                Stream.runForEach(gitState.watch([path]), () =>
                  Effect.suspend(() => {
                    localReadAt.set(key, sweeps);
                    return refreshIn(path, { remote: false, reuseLocal: true });
                  }),
                ),
              ),
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
        // A notice already waiting out its delay when the thread was archived would wake its agent.
        for (const thread of threads) if (thread.parked) yield* silence(thread.id);
        for (const thread of threads) {
          const state = states.get(samePathKey(effectiveCheckout(thread).path));
          if (state !== undefined) yield* publishTo(thread, threadState(thread, state));
        }
      }),
    );

    /**
     * No one can see this checkout's badge or sync chip, so the sweep leaves its rebase tier alone
     * until something puts the chips back on screen, and its network tier too but for a watch.
     */
    const unwatched = (threads: ReadonlyArray<Thread>) =>
      Option.isNone(visibility)
        ? Effect.succeed(false)
        : Effect.forEach(threads, (t) => visibility.value.rebaseGated(t.id)).pipe(
            Effect.map((gated) => gated.length > 0 && gated.every(Boolean)),
          );

    /**
     * Points checkouts without a PR at an open PR on another worktree of their repo. A read that
     * failed forgets `elsewhereRead`, so the next sweep asks again.
     */
    const publishElsewhere = (threads: ReadonlyArray<Thread>) =>
      Effect.gen(function* () {
        const found = yield* discoverPrsElsewhere(
          threads,
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
                if (samePathKey(effectiveCheckout(thread).path) === key)
                  yield* publishTo(thread, threadState(thread, next));
              }
            }),
          );
        }
      });

    /**
     * What the PR-elsewhere cue reads of the open checkouts: which want one, and the PRs the tracked
     * ones show. While it holds still, the cue can only move with a worktree no thread is on, or the
     * repo's list of open PRs, and the work-elsewhere passes look at those.
     */
    const elsewhereInputs = (threads: ReadonlyArray<Thread>) =>
      JSON.stringify(
        threads.map((thread) => {
          const key = samePathKey(effectiveCheckout(thread).path);
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

    /** Takes one hold off `key`. */
    const unhold = (key: string) => {
      const left = (held.get(key) ?? 1) - 1;
      if (left > 0) held.set(key, left);
      else held.delete(key);
    };

    const hold = (path: string) =>
      Effect.gen(function* () {
        const key = samePathKey(path);
        held.set(key, (held.get(key) ?? 0) + 1);
        // Then waits out a refresh already running git there; its checks keep it from publishing.
        yield* sync.pipe(
          Effect.andThen(locks.withLock(key, Effect.void)),
          // An interrupted hold is undone and the checkout watched again.
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

    /** Open checkouts by path key, less the held ones. */
    const checkoutsOf = (threads: ReadonlyArray<Thread>) => {
      const byPath = new Map<string, { path: string; threads: Array<Thread> }>();
      for (const thread of threads) {
        const path = effectiveCheckout(thread).path;
        if (held.has(samePathKey(path))) continue;
        const entry = byPath.get(samePathKey(path)) ?? { path, threads: [] };
        entry.threads.push(thread);
        byPath.set(samePathKey(path), entry);
      }
      return byPath;
    };

    /** How closely the most-watched of `threads` is being looked at; listed, with no windows known. */
    const attentionOf = (threads: ReadonlyArray<Thread>) =>
      Option.isNone(visibility)
        ? Effect.succeed("listed" as const)
        : Effect.forEach(threads, (t) => visibility.value.attention(t.id)).pipe(
            Effect.map(closestAttention),
          );

    /** When the user was last in one of `threads`, or one last saw activity: whichever is latest. */
    const lastTouched = (threads: ReadonlyArray<Thread>) =>
      Effect.forEach(threads, (t) =>
        Option.isNone(visibility)
          ? Effect.succeed(t.lastActivityAt)
          : visibility.value
              .lastFocusedAt(t.id)
              .pipe(Effect.map((focusedAt) => Math.max(t.lastActivityAt, focusedAt ?? 0))),
      ).pipe(Effect.map((each) => Math.max(0, ...each)));

    /**
     * Asks GitHub about every PR the checkouts in `entries` are about to look up, in one document.
     * The refreshes that follow reach `Pr.status` one checkout at a time, which asked that way is a
     * document each, and GitHub charges a point a document however little it carries.
     */
    const primeBadges = (entries: Iterable<{ path: string; threads: ReadonlyArray<Thread> }>) =>
      Effect.gen(function* () {
        // As `refreshBound` will ask, or what is primed isn't what it reads.
        const extras = affordsExtras(yield* budget.window("graphql"));
        yield* pr.prime(
          [...entries].flatMap(({ path, threads }) => {
            const state = states.get(samePathKey(path));
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
              ];
            });
            return [{ cwd: path }, ...numbered.map((bound) => ({ cwd: path, bound }))];
          }),
        );
      });

    /**
     * `catchUp`: the app is back on screen after being hidden or asleep. However cool a thread had
     * gone, its badge is about to be looked at, so everything that is ever asked about is asked now.
     */
    const sweepAt = (level: ActivityLevel, catchUp = false) =>
      Effect.gen(function* () {
        const threads = yield* openThreads;
        const byPath = checkoutsOf(threads);
        const pass = sweeps++;
        const scanElsewhere = pass % WORK_ELSEWHERE_SWEEPS === 0;
        // Refused, or down to the share kept for other tools: the local tier still runs, and the
        // badges keep what they show until the allowance resets.
        const quotaHeld = !(yield* budget.admit("graphql", "background")).allowed;
        const now = yield* Clock.currentTimeMillis;
        const tiered = yield* Effect.forEach(byPath, ([key, entry]) =>
          Effect.gen(function* () {
            // Nobody may be looking at an archived thread's row, and it's asked about anyway.
            const parked = entry.threads.every((t) => t.parked);
            const attention = parked ? "listed" : yield* attentionOf(entry.threads);
            // Its last read is due again, or it has none: what that read showed may have changed.
            const localDue =
              catchUp || sweeps - (localReadAt.get(key) ?? -Infinity) >= localEvery(attention);
            if (quotaHeld) return { entry, parked, localDue, tier: "local" as const };
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
              // A lingering thread's PR is open whatever the checkout's own badge says, and that one
              // merged at HEAD would never be asked about again: an archived checkout goes by idleness.
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
        // Nothing but its PR changes an archived checkout's badge: no local tier between lookups,
        // and none at all once its folder is gone. An open one's waits until its read is due.
        const swept = yield* Effect.filter(tiered, ({ entry, parked, localDue, tier }) =>
          !parked
            ? Effect.succeed(tier !== "local" || localDue)
            : tier === "local"
              ? Effect.succeed(false)
              : folderExists(entry.path),
        );
        yield* primeBadges(swept.filter(({ tier }) => tier !== "local").map(({ entry }) => entry));
        yield* Effect.forEach(
          swept,
          ({ entry, parked, localDue, tier }) =>
            refreshIn(
              entry.path,
              {
                remote: tier !== "local",
                rebase: tier === "full",
                scanElsewhere: scanElsewhere && tier === "full",
                // A checkout only archived threads are on has no watcher to keep its read current.
                reuseLocal: !parked && !localDue,
              },
              entry.threads,
            ),
          { concurrency: config.sweepConcurrency, discard: true },
        );
        // A worktree list per repo and its commit times: on the scan passes, back on screen, when a
        // tracked checkout's branch or PR moved and the cue may with it, or after a failed read.
        const inputs = elsewhereInputs(threads);
        if (catchUp || scanElsewhere || inputs !== elsewhereRead) {
          elsewhereRead = inputs;
          yield* publishElsewhere(threads);
        }
      });

    const sweep = sweepAt("active");

    /**
     * The sweep while no window is showing: the PR lookup alone, and only for checkouts a watch is
     * on. Whether a chip is on screen doesn't gate it, since a notification is what it is for.
     */
    const sweepWatched = Effect.gen(function* () {
      if (!(yield* budget.admit("graphql", "background")).allowed) return;
      const watchedThreads = (yield* openThreads).filter(
        (t) => !t.parked && (hasWatch(t) || waitsOnPr(t)),
      );
      const entries = [...checkoutsOf(watchedThreads).values()];
      yield* primeBadges(entries);
      // Their watchers keep the local reads current, and the first sweep back on screen reads anew.
      yield* Effect.forEach(
        entries,
        (entry) =>
          refreshIn(
            entry.path,
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
    // A CI message still queued when its monitor is turned off is for work the user turned off. The
    // thread is read again rather than taken from the event, which may be older than the message.
    // Only an upsert that moved what it reads: the archive and the PRs with their monitors.
    yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
      Stream.filter(
        upsertsChanging((t) => JSON.stringify([t.parked, t.boundPr ?? null, t.extraPrs ?? null])),
      ),
      Stream.runForEach((event) =>
        event.type !== "thread.upsert"
          ? Effect.void
          : Effect.gen(function* () {
              const thread = yield* store.getThread(event.thread.id);
              // A monitor turned off forgets what it saw, so turned on again it starts afresh.
              if (prunedMarks(thread) !== thread) {
                yield* runtimes.updateThread(thread.id, prunedMarks);
              }
              // Nor is one queued for a thread that's been archived since.
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
          if (expectChange === true) {
            const until = (yield* Clock.currentTimeMillis) + Duration.toMillis(EXPECT_CHANGE_FOR);
            expectingUntil.set(samePathKey(cwd), until);
          }
          yield* requestRefresh(cwd, remote, priority);
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    const backoff = yield* makePollBackoff("gitstate", config.sweepInterval ?? Duration.zero);
    let announced = false;

    /**
     * How long until the next sweep. A pass GitHub refused waits out the backoff, or the reset time
     * when GitHub gave one; a clean pass waits the base cadence, stretched for an app at `level` that
     * nobody is looking at and again for an allowance running low. `refusedBefore` is the refusal
     * count as the pass began: a click refused while the loop slept raised the count as well, and
     * counted against the pass that followed it, that backed a sweep off which GitHub had answered.
     */
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

    /** The last pass left the app hidden or asleep, so the next one on screen catches up. */
    let away = false;
    if (config.sweepInterval !== undefined) {
      yield* Effect.gen(function* () {
        // Asleep as this pass comes due: the wait above ended in the suspension, not before it.
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
        // A window coming back cuts the long wait short, so its badges are fresh when it's looked at.
        // Not a backoff, though: that wait is GitHub's, and a sweep into a live 403 extends it.
        const healthy = (yield* backoff.consecutive) === 0;
        yield* Option.isSome(activity) && healthy && !onScreen(after)
          ? Effect.raceFirst(wait, activity.value.awaitActive)
          : wait;
      }).pipe(asBackground, Effect.forever, Effect.forkScoped);
    }
    // Moving into a thread is the moment its state matters most, and a thread gone cool may not have
    // been asked about for minutes. Not as background work: the user is waiting on this one.
    if (Option.isSome(visibility) && config.sweepInterval !== undefined) {
      yield* visibility.value.focusChanges.pipe(
        Stream.runForEach((threadId) =>
          Effect.gen(function* () {
            const thread = (yield* openThreads).find((t) => t.id === threadId);
            if (thread === undefined) return;
            const path = effectiveCheckout(thread).path;
            const key = samePathKey(path);
            const age = (yield* Clock.currentTimeMillis) - (lastRemoteAt.get(key) ?? 0);
            if (age < Duration.toMillis(FOCUS_FRESH_FOR)) return;
            skippedSweeps.delete(key);
            yield* requestRefresh(path, true);
          }),
        ),
        Effect.forkScoped,
      );
    }
    // A sidebar expanding or a pane showing a thread brings the skipped tiers up to date now. The
    // network tier waits when we're backed off: an expand mustn't fire a burst into a live 403.
    if (Option.isSome(visibility)) {
      yield* visibility.value.revealed.pipe(
        Stream.runForEach((revealed) =>
          Effect.gen(function* () {
            const threads = yield* openThreads;
            const paths = new Map(
              threads
                .filter((t) => revealed === "all" || revealed.includes(t.id))
                .map((t) => [samePathKey(effectiveCheckout(t).path), effectiveCheckout(t).path]),
            );
            const remote = config.sweepInterval !== undefined && (yield* backoff.consecutive) === 0;
            yield* Effect.forEach(paths.values(), (path) => refresh(path, { remote }), {
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
        const state = states.get(samePathKey(effectiveCheckout(thread).path));
        const elsewhere =
          thread.boundPr !== undefined &&
          (state === undefined || boundElsewhere(thread, state) !== undefined);
        return elsewhere ? boundPrs.get(thread.id) : state?.pr;
      });

    // Named as `git.state` sends it, so a snapshot or a reload has the names the stream had.
    const stateForThread: GitStatePublisherShape["stateForThread"] = (thread) =>
      Effect.suspend(() => {
        const state = states.get(samePathKey(effectiveCheckout(thread).path));
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
        const path = effectiveCheckout(thread).path;
        const key = samePathKey(path);
        const until = (yield* Clock.currentTimeMillis) + Duration.toMillis(EXPECT_CHANGE_FOR);
        expectingUntil.set(key, until);
        skippedSweeps.delete(key);
        // The lookup cache would answer with the badge being corrected for up to its TTL.
        invalidatePrBadges();
        yield* requestRefresh(path, true);
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
        const checkout = effectiveCheckout(thread);
        // `--repo` names the repo, so gh only needs a folder that exists to start in.
        const cwd =
          (yield* folderExists(checkout.path)) || checkout.repoRoot === undefined
            ? checkout.path
            : checkout.repoRoot;
        // `Pr.status` answers no PR, not a failure, while gh isn't signed in: that says nothing.
        if (Option.isSome(tools) && !(yield* tools.value.ghReady)) return Option.none();
        const found = yield* pr
          .status(cwd, { repo: ref.repo, number: ref.number, reviews: ref.reviews === true })
          .pipe(Effect.option);
        // Through the watchers' own door when it is watched already: an answer cached here unheard
        // would make the sweep's same answer no news, and those waiting on it would never be told.
        if (Option.isSome(found) && found.value !== undefined) {
          if (prWatches.has(ref)) yield* noteWatched(found.value);
          else prWatches.remember(ref, found.value);
        }
        return found;
      });

    return {
      stateFor: (path) => Effect.sync(() => states.get(samePathKey(path))),
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
  }),
);
