// The review monitor and babysit mode. It observes the git state publisher:
// a bot round, a verdict or merge-state change and a CI settle are debounced into one structured
// notice per thread, and a babysitting thread's counters, reruns, re-review, finish and stops follow.
// A person approving or requesting changes is a notice of its own, which babysitting never counts.

import {
  DEFAULT_BABYSIT_ROUNDS,
  effectiveCheckout,
  initialBabysitState,
  InvalidState,
  MONITOR_MARK_REVIEWS_MAX,
  ORCHESTRATOR_HAS_NO_PR,
  requiredChecksOf,
  reviewBotsOf,
  serializeHumanReviewNotice,
  serializeReviewNotice,
  type BabysitBudget,
  type BabysitState,
  type BoundPr,
  type GitState,
  type HumanReviewNotice,
  type MonitorMark,
  type PrReview,
  type PrStatus,
  type ReviewNotice,
  type ReviewRound,
  type Thread,
  type ThreadId,
  type ThreadNotFound,
} from "@gram/contracts";
import { Pr, prChecksStamp, repoFromPrUrl } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import { EventHub } from "../events/event-hub.ts";
import { upsertsChanging } from "../events/upsert-changes.ts";
import { asBackground } from "../github/budget.ts";
import { bindMainPr, isBadgeOf, markOf, unmarked, withMonitorMark } from "../git/extra-prs.ts";
import { GitRefresh, GitServerConfig } from "../git/platform.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { PrReviews } from "../git/review.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  buildReport,
  alreadyReported,
  checkDecision,
  citedShas,
  countRound,
  failingCheck,
  isCiOnly,
  isReadyToMerge,
  kickoffText,
  leavesWork,
  markDeclined,
  markedSnapshot,
  markHandled,
  noticeReasons,
  openFindings,
  pickBot,
  short,
  stopReasonOf,
  uncountedReview,
  unresolvedBotThreads,
  type FailingCheck,
  type Halt,
  type MonitorSnapshot,
  type NoticeReason,
} from "./rules.ts";

/** A thread's pull request: the bound one, else the branch's badge. */
export interface PrTarget {
  readonly thread: Thread;
  readonly bound: BoundPr;
  readonly cwd: string;
  /** The published badge, when it is this PR's. */
  readonly badge: PrStatus | undefined;
}

export interface BabysitShape {
  /** Turns babysitting on, binding the branch's PR with its review monitor, or off. Never on an orchestrator. */
  setEnabled(
    threadId: ThreadId,
    enabled: boolean,
    budget?: BabysitBudget,
  ): Effect.Effect<Thread, ThreadNotFound | InvalidState>;
  /** Turns the review monitor on or off, binding the branch's PR when none is bound; not on for an orchestrator. */
  setReviewMonitor(
    threadId: ThreadId,
    enabled: boolean,
  ): Effect.Effect<BoundPr | undefined, ThreadNotFound | InvalidState>;
  /** The PR the thread's review work is on; none for an orchestrator. */
  target(threadId: ThreadId): Effect.Effect<PrTarget | undefined, ThreadNotFound>;
  /** The first SHA `body` cites as a fix ("Fixed in <sha>") that `head` contains. */
  pushedFix(cwd: string, body: string, head: string | undefined): Effect.Effect<string | undefined>;
  /**
   * Counts the agent's reply while babysitting: a reply citing a pushed fix resolves the thread,
   * any other reply is a decline.
   */
  recordReply(
    threadId: ThreadId,
    reviewThreadId: string,
    fix: string | undefined,
  ): Effect.Effect<{ readonly resolved: boolean }>;
  recordResolved(threadId: ThreadId, reviewThreadId: string): Effect.Effect<void>;
  recordRereview(threadId: ThreadId, head: string): Effect.Effect<void>;
}

const BABYSIT_KEYS = ["review:", "babysit:", "human-review:"];

/** The `sendNotice` key of the review monitor's notices for `pr`. */
const reviewNoticeKey = (pr: { readonly repo: string; readonly number: number }) =>
  `review:${pr.repo}#${pr.number}`;

/**
 * The `sendNotice` key of the monitor's notices of people's reviews on `pr`. Not the bot notice's
 * key: each is the whole of its own picture and none of the other's, so one replacing the other
 * would lose a person's verdict to a CI settle, or a round's findings to an approval.
 */
const humanReviewKey = (pr: { readonly repo: string; readonly number: number }) =>
  `human-review:${pr.repo}#${pr.number}`;

/** The `sendNotice` key of babysitting's kickoff message for `pr`. */
const kickoffKey = (pr: { readonly repo: string; readonly number: number }) =>
  `babysit:${pr.repo}#${pr.number}`;

/** A notice that was due and didn't go out; silence here is otherwise indistinguishable from a bug. */
const dropped = (threadId: ThreadId, why: string, taken: ReadonlySet<NoticeReason>) =>
  Effect.logDebug("review notice dropped").pipe(
    Effect.annotateLogs({ threadId, why, reasons: [...taken].join(",") }),
  );

export class Babysit extends Context.Service<Babysit, BabysitShape>()("@gram/server/Babysit") {}

export const BabysitLive = Layer.effect(
  Babysit,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const hub = yield* EventHub;
    const runtimes = yield* ThreadRuntimes;
    const publisher = yield* GitStatePublisher;
    const reviews = yield* PrReviews;
    const pr = yield* Pr;
    const config = yield* GitServerConfig;
    const refreshes = yield* GitRefresh;

    const seen = new Map<ThreadId, MonitorSnapshot>();
    /** Why each thread's pending notice is due; cleared when it's delivered. */
    const reasons = new Map<ThreadId, Set<NoticeReason>>();
    /** Bot rounds per PR, for notices outside babysit mode. */
    const roundCounts = new Map<string, number>();
    /** The review id each thread's pending round event announced. */
    const announced = new Map<ThreadId, string>();
    const noticeTimers = yield* FiberMap.make<ThreadId>();
    const rereviewTimers = yield* FiberMap.make<ThreadId>();
    /**
     * Finishing and stopping run in babysit's own fiber: `watch` runs inside a publisher refresh, and a newer
     * refresh for the same checkout interrupts that one, which left a ready PR watching forever.
     */
    const finishers = yield* FiberMap.make<ThreadId>();
    const rereviewHeads = new Map<ThreadId, string>();
    /** Notices are delivered one at a time, so a new trigger never interrupts a send. */
    const due = yield* Queue.unbounded<ThreadId>();
    /** The people's reviews each monitor has seen, by id; absent until its first look, a baseline. */
    const humanSeen = new Map<ThreadId, ReadonlySet<string>>();
    /** The new reviews each thread's next person-review notice is for, until it goes out. */
    const humanPending = new Map<ThreadId, Set<string>>();
    /** Threads with a person-review delivery in `humanDue`. */
    const humanScheduled = new Set<ThreadId>();
    /**
     * The reviews a notice still waiting in the queue was for. Its replacement names them new too,
     * or they'd go unflagged; one the agent took in the meantime is flagged twice, which is harmless.
     */
    const humanQueued = new Map<ThreadId, ReadonlySet<string>>();
    const humanDue = yield* Queue.unbounded<ThreadId>();
    /** The PR each monitor's baselines are of, by `repo#number`: another PR's are no baseline. */
    const watchedPrs = new Map<ThreadId, string>();
    /** Threads whose notice waits for a badge that read the reviews, to carry its round or verdict. */
    const heldForReviews = new Set<ThreadId>();
    /** Threads with a notice being put together or sent, whose snapshot isn't the mark's yet. */
    const delivering = new Set<ThreadId>();

    const target: BabysitShape["target"] = (threadId) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        if (thread.role === "orchestrator") return undefined;
        const cwd = effectiveCheckout(thread).path;
        // Not the checkout's state: a PR bound from another repository or branch has its own badge.
        const published = yield* publisher.badgeFor(thread);
        const repo =
          thread.boundPr?.repo ??
          (published === undefined ? undefined : repoFromPrUrl(published.url));
        const number = thread.boundPr?.number ?? published?.number;
        if (repo === undefined || number === undefined) return undefined;
        return {
          thread,
          bound: thread.boundPr ?? { repo, number, monitor: false },
          cwd,
          badge:
            published !== undefined && isBadgeOf(published, { repo, number })
              ? published
              : undefined,
        };
      });

    /** `found`'s badge read with its reviews, or its unread one when GitHub won't say just now. */
    const readReviews = (found: PrTarget) =>
      pr
        .status(found.cwd, { repo: found.bound.repo, number: found.bound.number, reviews: true })
        .pipe(
          Effect.map((badge) =>
            badge !== undefined && isBadgeOf(badge, found.bound) ? badge : found.badge,
          ),
          Effect.orElseSucceed(() => found.badge),
        );

    const fetchReview = (cwd: string, bound: BoundPr) =>
      Effect.gen(function* () {
        const bots = reviewBotsOf(yield* store.getSettings);
        const review = yield* reviews.fetch(cwd, bound.repo, bound.number, bots);
        return review.available ? review : undefined;
      }).pipe(
        Effect.orElseSucceed((): PrReview | undefined => undefined),
        asBackground,
      );

    /** Applies `f` to a watching babysit state and returns its value; `undefined` when not watching. */
    const updateWatching = <A>(
      threadId: ThreadId,
      f: (state: BabysitState) => readonly [BabysitState, A],
    ) =>
      Effect.gen(function* () {
        let result: A | undefined;
        yield* runtimes
          .updateThread(threadId, (thread) => {
            if (thread.babysit?.phase !== "watching") return thread;
            const [next, value] = f(thread.babysit);
            result = value;
            return { ...thread, babysit: next };
          })
          .pipe(Effect.ignore);
        return result;
      });

    const forgetTimers = (threadId: ThreadId) =>
      Effect.gen(function* () {
        reasons.delete(threadId);
        announced.delete(threadId);
        rereviewHeads.delete(threadId);
        heldForReviews.delete(threadId);
        yield* FiberMap.remove(noticeTimers, threadId);
        yield* FiberMap.remove(rereviewTimers, threadId);
      });

    const stop = (threadId: ThreadId, number: number, halt: Halt) =>
      Effect.gen(function* () {
        const stopped = yield* updateWatching(threadId, (state) => [
          { ...state, phase: "stopped", stopReason: halt.reason, stopDetail: halt.detail },
          true,
        ]);
        yield* forgetTimers(threadId);
        yield* Effect.logDebug("babysit stopped").pipe(
          Effect.annotateLogs({ threadId, reason: halt.reason, detail: halt.detail }),
        );
        if (stopped === true) {
          yield* hub.publish({
            type: "notify",
            kind: "needsInput",
            title: `Babysit stopped on #${number}`,
            body: halt.detail,
            threadId,
          });
        }
      });

    const finish = (found: PrTarget, badge: PrStatus) =>
      Effect.gen(function* () {
        const review = yield* fetchReview(found.cwd, found.bound);
        const report = yield* updateWatching(found.thread.id, (state) => {
          const value = buildReport(state, badge, review);
          return [{ ...state, phase: "done", report: value }, value];
        });
        yield* forgetTimers(found.thread.id);
        if (report === undefined) return;
        yield* runtimes
          .emitChunk(found.thread.id, {
            type: "data-babysit-report",
            id: randomUUID(),
            data: report,
          })
          .pipe(Effect.ignore);
        yield* runtimes.markCompleted(found.thread.id, "agent").pipe(Effect.ignore);
        yield* hub.publish({
          type: "notify",
          kind: "done",
          title: `#${badge.number} is ready to merge`,
          body: "Approved on head, checks green, merge state clean. Not merged.",
          threadId: found.thread.id,
        });
      });

    const requestRereview = (threadId: ThreadId, head: string) =>
      Effect.gen(function* () {
        rereviewHeads.delete(threadId);
        const found = yield* target(threadId).pipe(Effect.orElseSucceed(() => undefined));
        const badge = found?.badge;
        const state = found?.thread.babysit;
        if (found === undefined || badge === undefined || state?.phase !== "watching") return;
        if (
          found.thread.parked ||
          badge.headRefOid !== head ||
          badge.reviewUnread === true ||
          badge.review?.verdictOnHead !== undefined ||
          badge.review?.roundInFlight === true ||
          state.rereviewRequestedOn === head
        )
          return;
        const bot = pickBot(reviewBotsOf(yield* store.getSettings), badge.review?.bots ?? []);
        if (bot === undefined) return;
        const posted = yield* reviews
          .comment(found.cwd, found.bound.repo, found.bound.number, bot.rereviewCommand)
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
            // Nobody is waiting on this comment, so it is held to the reserve like any other poll.
            asBackground,
          );
        if (!posted) return;
        yield* updateWatching(threadId, (s) => [{ ...s, rereviewRequestedOn: head }, true]);
        // Babysit's own doing, so the refresh it asks for is background work like the comment was.
        yield* asBackground(refreshes.request(found.cwd, true, { expectChange: true }));
      });

    /** Arms the quiet-window re-review while head has no verdict and nothing is running. */
    const armRereview = (thread: Thread, badge: PrStatus, state: BabysitState) =>
      Effect.gen(function* () {
        const head = badge.headRefOid;
        // A badge that didn't read the reviews can't say the head has no verdict.
        const quiet =
          head !== undefined &&
          badge.reviewUnread !== true &&
          badge.review?.verdictOnHead === undefined &&
          badge.review?.roundInFlight !== true &&
          requiredChecksOf(badge) !== "pending" &&
          state.rereviewRequestedOn !== head;
        if (!quiet) {
          rereviewHeads.delete(thread.id);
          return yield* FiberMap.remove(rereviewTimers, thread.id);
        }
        if (rereviewHeads.get(thread.id) === head) return;
        rereviewHeads.set(thread.id, head);
        yield* FiberMap.run(
          rereviewTimers,
          thread.id,
          Effect.sleep(config.babysitQuietWindow).pipe(
            Effect.andThen(requestRereview(thread.id, head)),
          ),
        );
      });

    const watch = (found: PrTarget, badge: PrStatus) =>
      Effect.gen(function* () {
        const { thread } = found;
        const state = thread.babysit;
        if (state?.phase !== "watching") return;
        if (badge.state !== "OPEN") {
          const halt = stopReasonOf(state, badge);
          if (halt !== undefined) {
            return yield* FiberMap.run(finishers, thread.id, stop(thread.id, badge.number, halt), {
              onlyIfMissing: true,
            }).pipe(Effect.asVoid);
          }
        }
        const head = badge.headRefOid;
        if (head !== undefined && head !== state.lastHead) {
          if (
            state.lastHead !== undefined &&
            (yield* reviews.isPushed(found.cwd, state.lastHead, head)) === false
          ) {
            const halt: Halt = {
              reason: "forcePush",
              detail: `${short(head)} doesn't contain the previous head ${short(state.lastHead)}`,
            };
            return yield* FiberMap.run(finishers, thread.id, stop(thread.id, badge.number, halt), {
              onlyIfMissing: true,
            }).pipe(Effect.asVoid);
          }
          yield* updateWatching(thread.id, (s) => [{ ...s, lastHead: head }, true]);
        }
        if (isReadyToMerge(badge)) {
          return yield* FiberMap.run(finishers, thread.id, finish(found, badge), {
            onlyIfMissing: true,
          }).pipe(Effect.asVoid);
        }
        yield* armRereview(thread, badge, state);
      });

    const schedule = (threadId: ThreadId, added: ReadonlyArray<NoticeReason>) =>
      Effect.gen(function* () {
        const pending = reasons.get(threadId) ?? new Set<NoticeReason>();
        for (const reason of added) pending.add(reason);
        reasons.set(threadId, pending);
        yield* Effect.logDebug("review notice scheduled").pipe(
          Effect.annotateLogs({ threadId, reasons: [...pending].join(",") }),
        );
        // Restarts the window, so a round and the CI settle it causes land in one notice.
        yield* FiberMap.run(
          noticeTimers,
          threadId,
          Effect.sleep(config.monitorSettleDelay).pipe(Effect.andThen(Queue.offer(due, threadId))),
        );
      });

    /** Drops the monitor's baselines for the thread and whatever it has pending. */
    const forgetMonitor = (threadId: ThreadId) =>
      Effect.gen(function* () {
        seen.delete(threadId);
        humanSeen.delete(threadId);
        humanPending.delete(threadId);
        humanQueued.delete(threadId);
        humanScheduled.delete(threadId);
        yield* forgetTimers(threadId);
      });

    const onState = (thread: Thread, state: GitState) =>
      Effect.gen(function* () {
        const bound = thread.boundPr;
        const badge = state.pr;
        // An archived thread's badge is still published, but its agent isn't woken over it.
        if (
          thread.parked ||
          bound?.reviewMonitor !== true ||
          badge === undefined ||
          !isBadgeOf(badge, bound)
        ) {
          watchedPrs.delete(thread.id);
          return yield* forgetMonitor(thread.id);
        }
        // Rebound straight from one PR's badge to another's: what was seen is the other PR's.
        const watchedPr = `${bound.repo.toLowerCase()}#${bound.number}`;
        const before = watchedPrs.get(thread.id);
        watchedPrs.set(thread.id, watchedPr);
        if (before !== undefined && before !== watchedPr) yield* forgetMonitor(thread.id);
        yield* onHumanReviews(thread.id, badge, bound);
        // The first look since a restart compares against what the monitor saw before it, so a CI
        // settle, a verdict or a merge-state change while the app was down is still told.
        const previous = seen.get(thread.id) ?? markedSnapshot(bound.seen, badge.headRefOid);
        const current: MonitorSnapshot = {
          checks: requiredChecksOf(badge),
          // A badge that didn't read the reviews says nothing of the verdict: the last read stands,
          // for as long as the head it was on does.
          ...(badge.reviewUnread === true
            ? {
                verdict: previous?.head === badge.headRefOid ? previous?.verdict : undefined,
                reviewed: previous?.reviewed ?? false,
              }
            : { verdict: badge.review?.verdictOnHead, reviewed: true }),
          head: badge.headRefOid,
          mergeState: badge.mergeState,
        };
        seen.set(thread.id, current);
        const remember = Effect.suspend(() =>
          (reasons.get(thread.id)?.size ?? 0) === 0 && !delivering.has(thread.id)
            ? writeMark(thread.id, bound, snapshotMark(thread.id, badge, current, false))
            : Effect.void,
        );
        if (badge.reviewUnread !== true && heldForReviews.delete(thread.id))
          yield* schedule(thread.id, []);
        yield* watch({ thread, bound, cwd: effectiveCheckout(thread).path, badge }, badge);
        // The first state seen is only a baseline for the diff below, but babysitting may be turned on
        // after the bot finished, or see a round land as its first state: a review it hasn't counted
        // is owed whatever the diff says. Asked once per pending notice, so later states don't keep
        // restarting the window.
        const babysitting = thread.babysit?.phase === "watching" ? thread.babysit : undefined;
        if (
          babysitting !== undefined &&
          uncountedReview(babysitting, badge.review) !== undefined &&
          reasons.get(thread.id)?.has("round") !== true
        )
          yield* schedule(thread.id, ["round"]);
        if (previous === undefined) {
          // Which checks fail isn't on the badge; delivery drops the ones already reported.
          if (babysitting !== undefined && current.checks === "failing")
            yield* schedule(thread.id, ["ciCatchUp"]);
          return yield* remember;
        }
        if (current.checks === "pending") {
          // Checks restarting cancel a CI-only notice; a round's notice still goes out.
          const pending = reasons.get(thread.id);
          pending?.delete("ci");
          pending?.delete("ciCatchUp");
          if (pending?.size === 0) {
            reasons.delete(thread.id);
            yield* FiberMap.remove(noticeTimers, thread.id);
          }
        }
        const added = noticeReasons(previous, current);
        if (added.length > 0) yield* schedule(thread.id, added);
        yield* remember;
      });

    /** Keeps `next` of what the monitor saw of `bound` with the binding, when it isn't kept already. */
    const writeMark = (
      threadId: ThreadId,
      bound: BoundPr,
      next: (mark: MonitorMark | undefined) => MonitorMark,
    ) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        if (Option.isNone(thread)) return;
        if (
          withMonitorMark(thread.value, bound, next(markOf(thread.value, bound))) === thread.value
        )
          return;
        yield* runtimes
          .updateThread(threadId, (t) => withMonitorMark(t, bound, next(markOf(t, bound))))
          .pipe(Effect.ignore);
      });

    /** People's reviews the monitor has seen and told, or has no notice pending for. */
    const toldPeople = (threadId: ThreadId, kept: ReadonlyArray<string> | undefined) => {
      const people = humanSeen.get(threadId);
      if (people === undefined) return kept;
      const pending = humanPending.get(threadId);
      return [...people].filter((id) => pending?.has(id) !== true).slice(-MONITOR_MARK_REVIEWS_MAX);
    };

    /**
     * The mark for the monitor's first look after a restart (`markedSnapshot`): what it saw, kept
     * only while no notice of it is pending, since one lost with the process must still be owed.
     * The bot's latest review moves on with a notice sent (`told`), or as the first baseline.
     */
    const snapshotMark =
      (threadId: ThreadId, badge: PrStatus, current: MonitorSnapshot, told: boolean) =>
      (mark: MonitorMark | undefined): MonitorMark => {
        const read = badge.reviewUnread !== true;
        const reviewId =
          (told || mark?.reviewsRead !== true) && read && badge.review?.roundInFlight !== true
            ? badge.review?.latestReviewId
            : mark?.reviewId;
        const humanReviews = toldPeople(threadId, mark?.humanReviews);
        return {
          ...(mark?.ci === undefined ? {} : { ci: mark.ci }),
          ...(current.head === undefined ? {} : { head: current.head }),
          checks: current.checks,
          // Already tied to the head: a badge on a new head that didn't read the reviews has none.
          ...(current.verdict === undefined ? {} : { verdict: current.verdict }),
          ...(current.mergeState === undefined ? {} : { mergeState: current.mergeState }),
          ...(reviewId === undefined ? {} : { reviewId }),
          // An id not taken because a round was running isn't an absence seen.
          ...(mark?.reviewsRead === true || (read && badge.review?.roundInFlight !== true)
            ? { reviewsRead: true }
            : {}),
          ...(humanReviews === undefined ? {} : { humanReviews }),
        };
      };

    /**
     * Queues a notice for each person's review the monitor hadn't seen. Its first look at a badge
     * that read the reviews is a baseline; one that didn't (the REST fallback, a PR bound from
     * elsewhere before its monitor's lookup lands, or with the allowance short) is no look at all.
     */
    const onHumanReviews = (threadId: ThreadId, badge: PrStatus, bound: BoundPr) =>
      Effect.gen(function* () {
        if (badge.reviewUnread === true) return;
        const people = badge.review?.humanReviews ?? [];
        const kept = bound.seen?.humanReviews;
        const known = humanSeen.get(threadId) ?? (kept === undefined ? undefined : new Set(kept));
        // Grown, never replaced, so a review that leaves the badge's list and comes back isn't new.
        humanSeen.set(threadId, new Set([...(known ?? []), ...people.map((review) => review.id)]));
        if (known === undefined) return;
        const pending = humanPending.get(threadId) ?? new Set<string>();
        for (const review of people) if (!known.has(review.id)) pending.add(review.id);
        if (pending.size === 0) return;
        humanPending.set(threadId, pending);
        if (humanScheduled.has(threadId)) return;
        humanScheduled.add(threadId);
        yield* Queue.offer(humanDue, threadId);
      });

    const deliverHuman = (threadId: ThreadId) =>
      Effect.gen(function* () {
        humanScheduled.delete(threadId);
        const found = yield* target(threadId).pipe(Effect.orElseSucceed(() => undefined));
        const bound = found?.thread.boundPr;
        if (found?.badge === undefined || bound?.reviewMonitor !== true) return;
        // Archived since it was scheduled: its agent isn't woken.
        if (found.thread.parked) return;
        // A badge that read no reviews can't tell a dismissed review from one it didn't see: the
        // pending ones stay for the next badge that did.
        if (found.badge.reviewUnread === true) return;
        const fresh = new Set([
          ...(humanPending.get(threadId) ?? []),
          ...(humanQueued.get(threadId) ?? []),
        ]);
        humanPending.delete(threadId);
        humanQueued.delete(threadId);
        // Unlike the bot's, this goes out after babysitting has finished or stopped: a person asking
        // for changes on a PR handed back as ready is exactly what the agent should hear, and it can't
        // loop, since nothing the agent does makes a person review again.
        const standing = (found.badge.review?.humanReviews ?? []).toReversed();
        const newReviewIds = standing.filter((review) => fresh.has(review.id)).map((r) => r.id);
        // Dismissed before it could be sent.
        if (newReviewIds.length === 0) return;
        const notice: HumanReviewNotice = {
          kind: "humanReview",
          number: bound.number,
          ...(found.badge.headRefOid === undefined ? {} : { headRefOid: found.badge.headRefOid }),
          reviews: standing,
          newReviewIds,
        };
        // Review bodies are the reviewer's words and stay out of the log.
        yield* Effect.logDebug("person review notice sent").pipe(
          Effect.annotateLogs({ threadId, pr: bound.number, reviews: newReviewIds.length }),
        );
        const sent = yield* runtimes
          .sendNotice(threadId, humanReviewKey(bound), {
            text: serializeHumanReviewNotice(notice),
            notice,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("person review notice not sent").pipe(
                Effect.annotateLogs({ threadId, error: String(error) }),
                Effect.as(undefined),
              ),
            ),
          );
        if (sent?.queued === true) humanQueued.set(threadId, new Set(newReviewIds));
        if (sent !== undefined) {
          yield* writeMark(threadId, bound, (mark) => {
            const humanReviews = toldPeople(threadId, mark?.humanReviews);
            return { ...mark, ...(humanReviews === undefined ? {} : { humanReviews }) };
          });
        }
      });

    const onRound = (threadId: ThreadId, round: ReviewRound) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        if (Option.isNone(thread)) return;
        const bound = thread.value.boundPr;
        if (bound?.reviewMonitor !== true || bound.number !== round.number) return;
        announced.set(threadId, round.reviewId);
        yield* schedule(threadId, ["round"]);
      });

    const failingChecks = (
      cwd: string,
      bound: { readonly repo: string; readonly number: number },
      badge: PrStatus,
    ) =>
      pr.checks(cwd, bound.number, bound.repo, { stamp: prChecksStamp(badge) }).pipe(
        // A check nobody requires is neither rerun nor the agent's to fix: it can't block the merge.
        Effect.map((runs) =>
          runs
            .filter((run) => run.status === "failing" && run.name !== "" && run.required !== false)
            .map((run) => failingCheck(run.name, run.link)),
        ),
        Effect.orElseSucceed((): ReadonlyArray<FailingCheck> => []),
        asBackground,
      );

    const deliver = (threadId: ThreadId) =>
      Effect.suspend(() => {
        delivering.add(threadId);
        return deliverNow(threadId).pipe(
          Effect.ensuring(Effect.sync(() => delivering.delete(threadId))),
        );
      });

    const deliverNow = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const taken = reasons.get(threadId);
        const roundId = announced.get(threadId);
        reasons.delete(threadId);
        announced.delete(threadId);
        if (taken === undefined || taken.size === 0) return;
        const found = yield* target(threadId).pipe(Effect.orElseSucceed(() => undefined));
        if (found?.badge === undefined)
          return yield* dropped(threadId, "no badge for the PR", taken);
        if (found.thread.boundPr?.reviewMonitor !== true)
          return yield* dropped(threadId, "review monitor off", taken);
        if (found.thread.parked) return yield* dropped(threadId, "thread archived", taken);
        const { thread, bound, cwd, badge } = found;
        // What this notice tells, taken with the badge it is built from, before any lookup: a look
        // that lands meanwhile is owed its own notice.
        const told = seen.get(threadId);
        const phase = thread.babysit?.phase;
        // A finished or stopped babysit waits for the user; waking the agent would loop.
        if (phase === "done" || phase === "stopped")
          return yield* dropped(threadId, `babysit ${phase}`, taken);
        // A badge that didn't read the reviews can't carry a round or a verdict, and the next that
        // does may add no reason of its own: the notice waits for it.
        if (badge.reviewUnread === true && (taken.has("round") || taken.has("verdict"))) {
          const pending = reasons.get(threadId) ?? new Set<NoticeReason>();
          for (const reason of taken) pending.add(reason);
          reasons.set(threadId, pending);
          if (roundId !== undefined && !announced.has(threadId)) announced.set(threadId, roundId);
          heldForReviews.add(threadId);
          return yield* dropped(threadId, "held for a badge that read the reviews", taken);
        }
        const review = yield* fetchReview(cwd, bound);
        const { blockers, suggestions } =
          review === undefined ? { blockers: [], suggestions: [] } : openFindings(review);
        const failing =
          requiredChecksOf(badge) === "failing" ? yield* failingChecks(cwd, bound, badge) : [];
        const key = `${bound.repo}#${bound.number}`;
        let round = taken.has("round") ? (roundCounts.get(key) ?? 0) + 1 : roundCounts.get(key);
        if (round !== undefined) roundCounts.set(key, round);
        let ciFailed: ReadonlyArray<string> = failing.map((check) => check.name);
        const head = badge.headRefOid ?? "";
        const decide = (state: BabysitState) => {
          const reviewId = uncountedReview(state, badge.review, roundId);
          const isRound =
            reviewId !== undefined ||
            (taken.has("round") &&
              roundId === undefined &&
              badge.review?.latestReviewId === undefined);
          const counted =
            isRound && review !== undefined
              ? {
                  ...(reviewId !== undefined && reviewId === state.existingReviewId
                    ? state
                    : countRound(state, unresolvedBotThreads(review))),
                  ...(reviewId === undefined ? {} : { countedReviewId: reviewId }),
                }
              : state;
          const checks = checkDecision(counted, failing, head);
          return {
            state: checks.state,
            rerun: checks.rerun,
            real: checks.real,
            halt: checks.stop ?? stopReasonOf(checks.state, badge),
            rounds: checks.state.rounds,
            // The publisher's round event and the uncounted review are the same round seen twice.
            stale:
              (!isRound && taken.size === 1 && taken.has("round")) ||
              (taken.size === 1 && taken.has("ciCatchUp") && alreadyReported(state, failing, head)),
          };
        };
        /** Persists the decision, against the state as it is by then. */
        const commit = updateWatching(threadId, (state) => {
          const decided = decide(state);
          return [decided.stale ? state : decided.state, decided];
        });
        const rerunFlakes = (checks: ReadonlyArray<{ readonly runId: string }>) =>
          Effect.forEach(
            checks,
            (check) => reviews.rerun(cwd, bound.repo, check.runId).pipe(Effect.ignore),
            { discard: true },
          );
        const watching = phase === "watching" ? thread.babysit : undefined;
        if (watching !== undefined) {
          const plan = decide(watching);
          if (plan.stale) return yield* dropped(threadId, "already counted or reported", taken);
          if (plan.halt !== undefined) {
            const halted = yield* commit;
            yield* rerunFlakes(halted?.rerun ?? []);
            return yield* stop(threadId, bound.number, plan.halt);
          }
          ciFailed = plan.real;
          round = plan.rounds;
          // Every failing check was rerun as a possible flake; the rerun's own settle notifies.
          if (isCiOnly(taken) && failing.length > 0 && ciFailed.length === 0) {
            yield* rerunFlakes((yield* commit)?.rerun ?? []);
            return yield* dropped(threadId, "failing checks rerun as flakes", taken);
          }
        }
        // A CI notice over a badge that didn't read the reviews carries the verdict last read.
        const verdict =
          badge.reviewUnread === true ? seen.get(threadId)?.verdict : badge.review?.verdictOnHead;
        const notice: ReviewNotice = {
          kind: "review",
          number: bound.number,
          ...(badge.headRefOid === undefined ? {} : { headRefOid: badge.headRefOid }),
          ...(verdict === undefined ? {} : { verdict }),
          ...(badge.mergeState === undefined ? {} : { mergeState: badge.mergeState }),
          ...(round === undefined ? {} : { round }),
          blockers,
          suggestions,
          ciFailed,
        };
        yield* Effect.logDebug("review notice sent").pipe(
          Effect.annotateLogs({
            threadId,
            pr: bound.number,
            reasons: [...taken].join(","),
            reviewFetched: review !== undefined,
            ...(round === undefined ? {} : { round }),
          }),
        );
        // An agent that can't start fails the send with the notice already in the thread's queue,
        // which is delivered; sending it again would say it twice. Any other failure is a thread that
        // has ended or gone, with no one to tell.
        // Each notice is the PR's whole state, every open finding included, so a newer one leaves
        // nothing of a queued older one worth keeping.
        const delivered = yield* runtimes
          .sendNotice(threadId, reviewNoticeKey(bound), {
            text: serializeReviewNotice(notice),
            notice,
          })
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("review notice not sent").pipe(
                Effect.annotateLogs({ threadId, error: String(error) }),
                Effect.as(error._tag === "AgentUnavailable"),
              ),
            ),
          );
        if (!delivered) return;
        if (told !== undefined) {
          yield* writeMark(threadId, bound, snapshotMark(threadId, badge, told, true));
        }
        // Counted only once the notice is the agent's: a round counted for a notice that never went
        // out is never offered again.
        if (watching !== undefined) yield* rerunFlakes((yield* commit)?.rerun ?? []);
      });

    /** Fails for an orchestrator, which follows no PR of its own to babysit or watch. */
    const refuseOrchestrator = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        if (thread.role === "orchestrator") {
          return yield* new InvalidState({ message: ORCHESTRATOR_HAS_NO_PR, threadId });
        }
      });

    const setEnabled: BabysitShape["setEnabled"] = (threadId, enabled, budget) =>
      Effect.gen(function* () {
        if (!enabled) {
          yield* forgetTimers(threadId);
          return yield* runtimes.updateThread(threadId, (thread) => {
            const { babysit, ...rest } = thread;
            void babysit;
            return rest.boundPr === undefined
              ? rest
              : { ...rest, boundPr: { ...unmarked(rest.boundPr), reviewMonitor: false } };
          });
        }
        yield* refuseOrchestrator(threadId);
        const found = yield* target(threadId);
        if (found === undefined) {
          return yield* new InvalidState({
            message: "No pull request found for this thread's branch.",
            threadId,
          });
        }
        const startedAt = yield* Clock.currentTimeMillis;
        // A PR bound from elsewhere was looked up without its reviews while no monitor was on it, or
        // not at all yet, and what is already on it has to be read to be told apart from what comes
        // after. A read GitHub won't answer now leaves it as before: a review seen first is a round.
        const read =
          found.badge === undefined || found.badge.reviewUnread === true
            ? yield* readReviews(found)
            : found.badge;
        // A review that leaves nothing to do is history; one that does is handed over, but the round
        // budget is for the bot's rounds from here on.
        const review = read?.review;
        const existing = review?.latestReviewId;
        const babysit: BabysitState = {
          ...initialBabysitState(startedAt, budget),
          ...(review === undefined || existing === undefined
            ? {}
            : leavesWork(review)
              ? { existingReviewId: existing }
              : { countedReviewId: existing }),
        };
        // The main PR as the transaction reads it: one promoted since `target` ran is the PR being
        // babysat, and writing the earlier read back would undo the promotion.
        // Babysitting starts from what is there now, not from what a monitor saw before it, and
        // hands the merge to the user, so a `merge_when_ready` intent goes.
        const updated = yield* runtimes.updateThread(threadId, (thread) => {
          const { mergeWhenReady: _, ...bound } = unmarked(thread.boundPr ?? found.bound);
          return bindMainPr({ ...thread, babysit }, { ...bound, reviewMonitor: true });
        });
        const watched = updated.boundPr ?? found.bound;
        yield* refreshes.request(found.cwd, true);
        // Delivered the way its notices are, so a steered first notice never overtakes it.
        yield* runtimes
          .sendNotice(threadId, kickoffKey(watched), {
            text: kickoffText(watched.number, babysit.budget.rounds ?? DEFAULT_BABYSIT_ROUNDS),
          })
          .pipe(Effect.ignore);
        // The refresh above publishes nothing when the PR hasn't changed, so what's already there
        // (changes requested, a failing check) is looked at now rather than at the next change.
        seen.delete(threadId);
        const state = yield* publisher.stateFor(found.cwd);
        const badge = yield* publisher.badgeFor(updated);
        if (state !== undefined)
          yield* onState(updated, { ...state, ...(badge === undefined ? {} : { pr: badge }) });
        return updated;
      });

    const setReviewMonitor: BabysitShape["setReviewMonitor"] = (threadId, enabled) =>
      Effect.gen(function* () {
        if (enabled) yield* refuseOrchestrator(threadId);
        const found = yield* target(threadId);
        if (found === undefined) {
          if (!enabled) return undefined;
          return yield* new InvalidState({
            message: "No pull request found for this thread's branch; bind one with pr_bind.",
            threadId,
          });
        }
        const updated = yield* runtimes.updateThread(threadId, (thread) =>
          bindMainPr(thread, {
            // A monitor turned on or off forgets what it saw; one already on keeps it.
            ...(thread.boundPr?.reviewMonitor === true && enabled
              ? thread.boundPr
              : unmarked(thread.boundPr ?? found.bound)),
            reviewMonitor: enabled,
          }),
        );
        if (enabled) yield* refreshes.request(found.cwd, true);
        return updated.boundPr ?? { ...found.bound, reviewMonitor: enabled };
      });

    const pushedFix: BabysitShape["pushedFix"] = (cwd, body, head) =>
      Effect.gen(function* () {
        if (head === undefined) return undefined;
        for (const sha of citedShas(body)) {
          if ((yield* reviews.isPushed(cwd, sha, head)) === true) return sha;
        }
        return undefined;
      });

    const recordResolved: BabysitShape["recordResolved"] = (threadId, reviewThreadId) =>
      updateWatching(threadId, (state) => [markHandled(state, reviewThreadId), true]).pipe(
        Effect.asVoid,
      );

    const recordReply: BabysitShape["recordReply"] = (threadId, reviewThreadId, fix) =>
      Effect.gen(function* () {
        const found = yield* target(threadId).pipe(Effect.orElseSucceed(() => undefined));
        if (found?.thread.babysit?.phase !== "watching") return { resolved: false };
        if (fix === undefined) {
          yield* updateWatching(threadId, (state) => [markDeclined(state, reviewThreadId), true]);
          return { resolved: false };
        }
        const resolved = yield* reviews.resolve(found.cwd, reviewThreadId).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (resolved) yield* recordResolved(threadId, reviewThreadId);
        return { resolved };
      });

    const recordRereview: BabysitShape["recordRereview"] = (threadId, head) =>
      updateWatching(threadId, (state) => [{ ...state, rereviewRequestedOn: head }, true]).pipe(
        Effect.asVoid,
      );

    yield* Queue.take(due).pipe(
      Effect.flatMap((threadId) => Effect.exit(deliver(threadId))),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* Queue.take(humanDue).pipe(
      Effect.flatMap((threadId) => Effect.exit(deliverHuman(threadId))),
      Effect.forever,
      Effect.forkScoped,
    );
    // Replayed: the publisher's start-up refresh may land before this observes, and a PR that
    // hasn't changed since publishes nothing more to compare against the mark it kept.
    yield* publisher.observe({ onState, onRound }, { replay: true });
    // A notice still queued when its monitor or babysitting is turned off is for work the user
    // turned off, as is anything pending for a thread that's been archived. The thread is read
    // again rather than taken from the event, which may be older than the notice. Only an upsert
    // that moved what it reads: the archive, the bound PR and the babysitting.
    yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
      Stream.filter(
        upsertsChanging((t) => JSON.stringify([t.parked, t.boundPr ?? null, t.babysit ?? null])),
      ),
      Stream.runForEach((event) =>
        event.type !== "thread.upsert"
          ? Effect.void
          : Effect.gen(function* () {
              const thread = yield* store.getThread(event.thread.id);
              if (thread.parked) yield* forgetTimers(thread.id);
              const bound = thread.boundPr;
              const wanted = new Set(
                bound === undefined || thread.parked
                  ? []
                  : [
                      ...(bound.reviewMonitor === true
                        ? [reviewNoticeKey(bound), humanReviewKey(bound)]
                        : []),
                      ...(thread.babysit?.phase === "watching" ? [kickoffKey(bound)] : []),
                    ],
              );
              yield* runtimes.dropNotices(
                thread.id,
                (key) => BABYSIT_KEYS.some((prefix) => key.startsWith(prefix)) && !wanted.has(key),
              );
            }).pipe(Effect.ignore),
      ),
      Effect.forkScoped,
    );

    return Babysit.of({
      setEnabled,
      setReviewMonitor,
      target,
      pushedFix,
      recordReply,
      recordResolved,
      recordRereview,
    });
  }),
);
