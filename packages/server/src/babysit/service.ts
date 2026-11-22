import {
  agentOwnsPrEvents,
  DEFAULT_BABYSIT_ROUNDS,
  effectiveCheckout,
  initialBabysitState,
  isLocalHost,
  InvalidState,
  MONITOR_MARK_REVIEWS_MAX,
  mergeStateAllowsMerge,
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
import { canWrite, Pr, prChecksStamp, repoFromPrUrl } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { randomUUID } from "node:crypto";
import { forThread } from "../embedding/gh-thread.ts";
import { EventHub } from "../events/event-hub.ts";
import { upsertsChanging } from "../events/upsert-changes.ts";
import { asBackground } from "../github/budget.ts";
import { PrCommentReads } from "../git/pr-comments.ts";
import { bindMainPr, isBadgeOf, markOf, unmarked, withMonitorMark } from "../git/extra-prs.ts";
import { GitRefresh, GitServerConfig } from "../git/platform.ts";
import { MachineBranchPr } from "../git/machine-branch-pr.ts";
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

const reviewNoticeKey = (pr: { readonly repo: string; readonly number: number }) =>
  `review:${pr.repo}#${pr.number}`;

const humanReviewKey = (pr: { readonly repo: string; readonly number: number }) =>
  `human-review:${pr.repo}#${pr.number}`;

const kickoffKey = (pr: { readonly repo: string; readonly number: number }) =>
  `babysit:${pr.repo}#${pr.number}`;

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
    const machineBranchPr = yield* MachineBranchPr;
    const commentReads = Option.getOrUndefined(yield* Effect.serviceOption(PrCommentReads));

    const seen = new Map<ThreadId, MonitorSnapshot>();
    const reasons = new Map<ThreadId, Set<NoticeReason>>();
    const roundCounts = new Map<string, number>();
    const announced = new Map<ThreadId, string>();
    const noticeTimers = yield* FiberMap.make<ThreadId>();
    const rereviewTimers = yield* FiberMap.make<ThreadId>();
    const finishers = yield* FiberMap.make<ThreadId>();
    const rereviewHeads = new Map<ThreadId, string>();
    const due = yield* Queue.unbounded<ThreadId>();
    const humanSeen = new Map<ThreadId, ReadonlySet<string>>();
    const humanPending = new Map<ThreadId, Set<string>>();
    const humanScheduled = new Set<ThreadId>();
    const humanQueued = new Map<ThreadId, ReadonlySet<string>>();
    const humanDue = yield* Queue.unbounded<ThreadId>();
    const watchedPrs = new Map<ThreadId, string>();
    const heldForReviews = new Set<ThreadId>();
    const delivering = new Set<ThreadId>();

    const target: BabysitShape["target"] = (threadId) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        if (thread.role === "orchestrator") return undefined;
        const cwd = effectiveCheckout(thread).path;
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

    const onMachine = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const thread = yield* store.getThread(threadId);
        const checkout = effectiveCheckout(thread);
        if (thread.role === "orchestrator" || isLocalHost(checkout) || thread.boundPr !== undefined)
          return undefined;
        const badge = yield* machineBranchPr.pr(thread);
        const repo = badge === undefined ? undefined : repoFromPrUrl(badge.url);
        if (badge === undefined || repo === undefined) return undefined;
        return {
          thread,
          bound: { repo, number: badge.number, monitor: false },
          cwd: checkout.path,
          badge,
        } satisfies PrTarget;
      });

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
          const thread = yield* store.getThread(threadId).pipe(Effect.option);
          if (Option.isSome(thread) && agentOwnsPrEvents(thread.value)) {
            return yield* runtimes
              .sendNotice(threadId, `babysit-stopped:${number}`, {
                text: `Babysitting stopped on #${number}: ${halt.detail}. Pick the PR up from here.`,
              })
              .pipe(Effect.ignore);
          }
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
        if (agentOwnsPrEvents(found.thread)) {
          return yield* runtimes
            .sendNotice(found.thread.id, `babysit-ready:${badge.number}`, {
              text: `#${badge.number} is ready to merge: approved on head, checks green, merge state clean. Not merged.`,
            })
            .pipe(Effect.ignore);
        }
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
            asBackground,
          );
        if (!posted) return;
        yield* updateWatching(threadId, (s) => [{ ...s, rereviewRequestedOn: head }, true]);
        yield* asBackground(refreshes.request(found.cwd, true, { expectChange: true }));
      });

    const armRereview = (thread: Thread, badge: PrStatus, state: BabysitState) =>
      Effect.gen(function* () {
        const head = badge.headRefOid;
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
            Effect.andThen(requestRereview(thread.id, head).pipe(forThread(thread.id))),
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
        yield* FiberMap.run(
          noticeTimers,
          threadId,
          Effect.sleep(config.monitorSettleDelay).pipe(Effect.andThen(Queue.offer(due, threadId))),
        );
      });

    const forgetMonitor = (threadId: ThreadId) =>
      Effect.gen(function* () {
        seen.delete(threadId);
        humanSeen.delete(threadId);
        humanPending.delete(threadId);
        humanQueued.delete(threadId);
        humanScheduled.delete(threadId);
        yield* forgetTimers(threadId);
      });

    const stopTerminalMonitor = (threadId: ThreadId, bound: BoundPr) =>
      Effect.gen(function* () {
        watchedPrs.delete(threadId);
        yield* forgetMonitor(threadId);
        yield* runtimes
          .updateThread(threadId, (thread) =>
            thread.boundPr?.repo === bound.repo && thread.boundPr.number === bound.number
              ? { ...thread, boundPr: { ...unmarked(thread.boundPr), reviewMonitor: false } }
              : thread,
          )
          .pipe(Effect.ignore);
        yield* runtimes.dropNotices(threadId, (key) =>
          [reviewNoticeKey(bound), humanReviewKey(bound), kickoffKey(bound)].includes(key),
        );
      });

    const onState = (thread: Thread, state: GitState) =>
      Effect.gen(function* () {
        const bound = thread.boundPr;
        const badge = state.pr;
        if (
          bound?.reviewMonitor === true &&
          badge !== undefined &&
          isBadgeOf(badge, bound) &&
          badge.state !== "OPEN"
        ) {
          yield* watch({ thread, bound, cwd: effectiveCheckout(thread).path, badge }, badge);
          return yield* stopTerminalMonitor(thread.id, bound);
        }
        if (
          thread.parked ||
          bound?.reviewMonitor !== true ||
          badge === undefined ||
          !isBadgeOf(badge, bound)
        ) {
          watchedPrs.delete(thread.id);
          return yield* forgetMonitor(thread.id);
        }
        const watchedPr = `${bound.repo.toLowerCase()}#${bound.number}`;
        const before = watchedPrs.get(thread.id);
        watchedPrs.set(thread.id, watchedPr);
        if (before !== undefined && before !== watchedPr) yield* forgetMonitor(thread.id);
        yield* onHumanReviews(thread.id, badge, bound);
        const previous = seen.get(thread.id) ?? markedSnapshot(bound.seen, badge.headRefOid);
        const current: MonitorSnapshot = {
          checks: requiredChecksOf(badge),
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
        const babysitting = thread.babysit?.phase === "watching" ? thread.babysit : undefined;
        if (
          babysitting !== undefined &&
          uncountedReview(babysitting, badge.review) !== undefined &&
          reasons.get(thread.id)?.has("round") !== true
        )
          yield* schedule(thread.id, ["round"]);
        if (previous === undefined) {
          if (babysitting !== undefined && current.checks === "failing")
            yield* schedule(thread.id, ["ciCatchUp"]);
          return yield* remember;
        }
        if (current.checks === "pending") {
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

    const toldPeople = (threadId: ThreadId, kept: ReadonlyArray<string> | undefined) => {
      const people = humanSeen.get(threadId);
      if (people === undefined) return kept;
      const pending = humanPending.get(threadId);
      return [...people].filter((id) => pending?.has(id) !== true).slice(-MONITOR_MARK_REVIEWS_MAX);
    };

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
          ...(current.verdict === undefined ? {} : { verdict: current.verdict }),
          ...(current.mergeState === undefined ? {} : { mergeState: current.mergeState }),
          ...(reviewId === undefined ? {} : { reviewId }),
          ...(mark?.reviewsRead === true || (read && badge.review?.roundInFlight !== true)
            ? { reviewsRead: true }
            : {}),
          ...(humanReviews === undefined ? {} : { humanReviews }),
          ...(mark?.comments === undefined ? {} : { comments: mark.comments }),
          ...(mark?.commentsFloor === undefined ? {} : { commentsFloor: mark.commentsFloor }),
          ...(mark?.commentWakes === undefined ? {} : { commentWakes: mark.commentWakes }),
        };
      };

    const onHumanReviews = (threadId: ThreadId, badge: PrStatus, bound: BoundPr) =>
      Effect.gen(function* () {
        if (badge.reviewUnread === true) return;
        const people = badge.review?.humanReviews ?? [];
        const kept = bound.seen?.humanReviews;
        const known = humanSeen.get(threadId) ?? (kept === undefined ? undefined : new Set(kept));
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
        if (found.thread.parked) return;
        if (found.badge.state !== "OPEN") return yield* stopTerminalMonitor(threadId, bound);
        if (found.badge.reviewUnread === true) return;
        const fresh = new Set([
          ...(humanPending.get(threadId) ?? []),
          ...(humanQueued.get(threadId) ?? []),
        ]);
        humanPending.delete(threadId);
        humanQueued.delete(threadId);
        const reviewed = (found.badge.review?.humanReviews ?? []).toReversed();
        const writers = new Set<string>();
        const unverified = new Set<string>();
        for (const author of new Set(reviewed.map((review) => review.author))) {
          const permission =
            commentReads === undefined
              ? Option.none()
              : yield* asBackground(commentReads.permission(found.cwd, bound.repo, author)).pipe(
                  Effect.option,
                );
          if (Option.isNone(permission)) unverified.add(author);
          else if (canWrite(permission.value)) writers.add(author);
        }
        const held = reviewed.filter((r) => fresh.has(r.id) && unverified.has(r.author));
        if (held.length > 0) {
          humanPending.set(threadId, new Set(held.map((r) => r.id)));
          yield* Effect.logWarning("person review not verified; held for the next look").pipe(
            Effect.annotateLogs({ threadId, pr: bound.number, reviews: held.length }),
          );
        }
        const standing = reviewed.filter((review) => writers.has(review.author));
        const newReviewIds = standing.filter((review) => fresh.has(review.id)).map((r) => r.id);
        if (newReviewIds.length === 0) return;
        const notice: HumanReviewNotice = {
          kind: "humanReview",
          number: bound.number,
          ...(found.badge.headRefOid === undefined ? {} : { headRefOid: found.badge.headRefOid }),
          reviews: standing,
          newReviewIds,
        };
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
        Effect.map((runs) =>
          runs
            .filter((run) => run.status === "failing" && run.name !== "" && run.required !== false)
            .map((run) => failingCheck(run.name, run.link)),
        ),
        Effect.orElseSucceed(() => undefined),
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
        if (badge.state !== "OPEN") return yield* stopTerminalMonitor(threadId, bound);
        const hasBot = reviewBotsOf(yield* store.getSettings).length > 0;
        if (!hasBot) {
          taken.delete("round");
          taken.delete("verdict");
          if (taken.size === 0) return yield* dropped(threadId, "no review bot configured", taken);
        }
        const told = seen.get(threadId);
        const phase = thread.babysit?.phase;
        if (phase === "done" || phase === "stopped")
          return yield* dropped(threadId, `babysit ${phase}`, taken);
        if (badge.reviewUnread === true && (taken.has("round") || taken.has("verdict"))) {
          const pending = reasons.get(threadId) ?? new Set<NoticeReason>();
          for (const reason of taken) pending.add(reason);
          reasons.set(threadId, pending);
          if (roundId !== undefined && !announced.has(threadId)) announced.set(threadId, roundId);
          heldForReviews.add(threadId);
          return yield* dropped(threadId, "held for a badge that read the reviews", taken);
        }
        const review = hasBot ? yield* fetchReview(cwd, bound) : undefined;
        const { blockers, suggestions } =
          review === undefined ? { blockers: [], suggestions: [] } : openFindings(review);
        const failed = requiredChecksOf(badge) === "failing";
        const details = failed ? yield* failingChecks(cwd, bound, badge) : [];
        const failing = details ?? [];
        // The rollup was read even if the check details could not be fetched from this checkout.
        const failedWithoutDetails = failed && details === undefined;
        if (taken.has("merge")) {
          const actionable =
            ["DIRTY", "CONFLICTING", "BEHIND"].includes(badge.mergeState ?? "") ||
            (["CLEAN", "UNSTABLE"].includes(badge.mergeState ?? "") &&
              requiredChecksOf(badge) === "passing") ||
            (badge.mergeState === "BLOCKED" &&
              (failing.length > 0 ||
                failedWithoutDetails ||
                blockers.length > 0 ||
                (hasBot && badge.review?.verdictOnHead === "changesRequested")));
          if (!actionable) taken.delete("merge");
        }
        if (isCiOnly(taken) && failed && details?.length === 0)
          return yield* dropped(threadId, "no failing required checks", taken);
        if (taken.size === 0) return yield* dropped(threadId, "no actionable change", taken);
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
            stale:
              (!isRound && taken.size === 1 && taken.has("round")) ||
              (taken.size === 1 && taken.has("ciCatchUp") && alreadyReported(state, failing, head)),
          };
        };
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
          if (isCiOnly(taken) && failing.length > 0 && ciFailed.length === 0) {
            yield* rerunFlakes((yield* commit)?.rerun ?? []);
            return yield* dropped(threadId, "failing checks rerun as flakes", taken);
          }
        }
        const verdict = hasBot
          ? badge.reviewUnread === true
            ? seen.get(threadId)?.verdict
            : badge.review?.verdictOnHead
          : undefined;
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
        const latest = yield* target(threadId).pipe(Effect.orElseSucceed(() => undefined));
        if (
          latest?.badge?.state !== "OPEN" ||
          latest.thread.boundPr?.reviewMonitor !== true ||
          latest.bound.repo !== bound.repo ||
          latest.bound.number !== bound.number
        )
          return yield* dropped(threadId, "PR no longer monitored and open", taken);
        if (
          taken.size === 1 &&
          taken.has("merge") &&
          ((latest.badge.mergeState !== badge.mergeState &&
            !(
              mergeStateAllowsMerge(latest.badge.mergeState) &&
              mergeStateAllowsMerge(badge.mergeState)
            )) ||
            requiredChecksOf(latest.badge) !== requiredChecksOf(badge) ||
            latest.badge.headRefOid !== badge.headRefOid)
        )
          return yield* dropped(threadId, "merge state changed during lookup", taken);
        yield* Effect.logDebug("review notice sent").pipe(
          Effect.annotateLogs({
            threadId,
            pr: bound.number,
            reasons: [...taken].join(","),
            reviewFetched: review !== undefined,
            ...(round === undefined ? {} : { round }),
          }),
        );
        const delivered = yield* runtimes
          .sendNotice(threadId, reviewNoticeKey(bound), {
            text:
              serializeReviewNotice(notice, hasBot) +
              (failedWithoutDetails
                ? "\nRequired CI checks failed. Check details are unavailable."
                : ""),
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
        if (watching !== undefined) yield* rerunFlakes((yield* commit)?.rerun ?? []);
      });

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
        const read =
          found.badge === undefined || found.badge.reviewUnread === true
            ? yield* readReviews(found)
            : found.badge;
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
        const updated = yield* runtimes.updateThread(threadId, (thread) => {
          const { mergeWhenReady: _, ...bound } = unmarked(thread.boundPr ?? found.bound);
          return bindMainPr({ ...thread, babysit }, { ...bound, reviewMonitor: true });
        });
        const watched = updated.boundPr ?? found.bound;
        yield* refreshes.request(found.cwd, true);
        yield* runtimes
          .sendNotice(threadId, kickoffKey(watched), {
            text: kickoffText(watched.number, babysit.budget.rounds ?? DEFAULT_BABYSIT_ROUNDS),
          })
          .pipe(Effect.ignore);
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
        const found =
          (yield* target(threadId)) ?? (enabled ? yield* onMachine(threadId) : undefined);
        if (found === undefined) {
          if (!enabled) return undefined;
          return yield* new InvalidState({
            message: "No pull request found for this thread's branch; bind one with pr_bind.",
            threadId,
          });
        }
        const updated = yield* runtimes.updateThread(threadId, (thread) =>
          bindMainPr(thread, {
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

    for (const [queue, run] of [
      [due, deliver],
      [humanDue, deliverHuman],
    ] as const)
      yield* Queue.take(queue).pipe(
        Effect.flatMap((threadId) => Effect.exit(run(threadId).pipe(forThread(threadId)))),
        Effect.forever,
        Effect.forkScoped,
      );
    yield* publisher.observe({ onState, onRound }, { replay: true });
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
