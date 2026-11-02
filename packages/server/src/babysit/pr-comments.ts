// A person's comment on a worker's PR wakes the worker. It rides the review monitor's poll: the
// badge read with the reviews lists people's comments by id and time, and only a new one costs a
// lookup of what it says (one `gh api graphql` call for every new comment together) and of its
// author's permission (one `gh api` call per author, kept ten minutes). The comment reaches the
// worker fenced as untrusted external content, and grants nothing.

import {
  effectiveCheckout,
  MONITOR_MARK_COMMENT_WAKES_MAX,
  MONITOR_MARK_COMMENTS_MAX,
  reviewBotsOf,
  type BoundPr,
  type MonitorMark,
  type PersonComment,
  type PrStatus,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import { canWrite, type FetchedComment } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { asBackground } from "../github/budget.ts";
import { isBadgeOf, markOf, withMonitorMark } from "../git/extra-prs.ts";
import { PrCommentReads } from "../git/pr-comments.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { postedIn, type Posted } from "./posted-comments.ts";
import {
  commentNoticeText,
  isOwnComment,
  OWN_COMMENT_LOOKBACK_MS,
  passOver,
  type PassReason,
} from "./pr-comment-rules.ts";

/** How often a PR's comments may wake its worker, and how long a failed lookup is retried. */
export interface PrCommentWakeLimits {
  /** The least time between two wakes. */
  readonly minGap: Duration.Duration;
  /** The most wakes in any hour. */
  readonly perHour: number;
  /** The most wakes in any day. */
  readonly perDay: number;
  /** How long the first retry of a failed lookup waits; each next one waits twice as long. */
  readonly retryAfter: Duration.Duration;
  /** Failed lookups of one comment before it is given up as not trusted. */
  readonly attempts: number;
}

export const DEFAULT_PR_COMMENT_WAKE_LIMITS: PrCommentWakeLimits = {
  minGap: Duration.minutes(1),
  perHour: 6,
  perDay: 24,
  retryAfter: Duration.minutes(1),
  attempts: 4,
};

/** The rate limit and retries; tests set their own. */
export const PrCommentWakeConfig = Context.Reference<PrCommentWakeLimits>(
  "@gram/server/PrCommentWakeConfig",
  { defaultValue: () => DEFAULT_PR_COMMENT_WAKE_LIMITS },
);

/** The `sendNotice` key prefix of a comment notice; each notice has its own, so none replaces another. */
export const PR_COMMENT_KEY = "pr-comment:";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Where a comment sits in a PR's order: when it was posted, then its id. */
interface Stamp {
  readonly at: string;
  readonly id: string;
}

/** Whether `a` comes after `b`; everything comes after nothing. */
const isAfter = (a: Stamp, b: Stamp | undefined): boolean =>
  b === undefined || a.at > b.at || (a.at === b.at && a.id > b.id);

const latest = (stamps: ReadonlyArray<Stamp>): Stamp | undefined =>
  stamps.reduce<Stamp | undefined>((max, s) => (isAfter(s, max) ? s : max), undefined);

const stampOf = (c: PersonComment): Stamp => ({ at: c.at, id: c.id });

/** A new comment not decided yet. */
interface Pending {
  readonly listed: PersonComment;
  /** What it says, once read. */
  fetched?: FetchedComment | undefined;
  /** Lookups of it that failed so far. */
  attempts: number;
  /** Not tried again before this, epoch ms, after a failed lookup. */
  nextAt?: number | undefined;
}

/** What the watch keeps of one thread's PR. */
interface Watch {
  /** `repo#number`, lower-cased: what the rest is of. */
  readonly pr: string;
  /** The newest comment handled with nothing older still open: anything not after it is old. */
  upTo: Stamp | undefined;
  /** Comments handled after `upTo` while an older one was still open, which `upTo` waits on. */
  handled: Array<Stamp>;
  /** Comments delivered or passed over, by id, oldest first: a guard beside `upTo`. */
  seen: Array<string>;
  readonly pending: Map<string, Pending>;
  /** Comments that will wake the worker once the rate limit allows. */
  ready: Array<{ readonly listed: PersonComment; readonly comment: FetchedComment }>;
}

const prKey = (bound: Pick<BoundPr, "repo" | "number">) =>
  `${bound.repo.toLowerCase()}#${bound.number}`;

/**
 * Whether `thread` takes comments on its PR: a worker, not archived, with the review monitor on
 * its bound PR and `badge` that PR's.
 */
const eligible = (thread: Thread, badge: PrStatus | undefined): badge is PrStatus =>
  thread.spawnedBy !== undefined &&
  thread.role === undefined &&
  !thread.parked &&
  thread.boundPr?.reviewMonitor === true &&
  badge !== undefined &&
  isBadgeOf(badge, thread.boundPr);

/** `seen` cut to the mark's size, never dropping an id the badge still lists. */
const trimmed = (seen: ReadonlyArray<string>, listed: ReadonlySet<string>): Array<string> => {
  if (seen.length <= MONITOR_MARK_COMMENTS_MAX) return [...seen];
  const room = MONITOR_MARK_COMMENTS_MAX - seen.filter((id) => listed.has(id)).length;
  const others = seen.filter((id) => !listed.has(id));
  const keep = new Set([
    ...seen.filter((id) => listed.has(id)),
    ...others.slice(-Math.max(room, 0)),
  ]);
  return seen.filter((id) => keep.has(id));
};

const passed = (threadId: ThreadId, id: string, why: PassReason) =>
  // Who wrote it and what it says stay out of the log.
  Effect.logDebug("pr comment passed over").pipe(Effect.annotateLogs({ threadId, id, why }));

/** Watches every worker's monitored PR for people's comments; provides nothing. */
export const PrCommentWakesLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const publisher = yield* GitStatePublisher;
    const reads = yield* PrCommentReads;
    const limits = yield* PrCommentWakeConfig;

    const watches = new Map<ThreadId, Watch>();
    /**
     * When comments woke each PR's worker, by `repo#number`. Apart from the watches, so a moment
     * the thread isn't eligible doesn't reset the rate limit; kept with the mark for a restart.
     */
    const wakes = new Map<string, Array<number>>();
    const due = yield* Queue.unbounded<ThreadId>();
    /** Threads with a look in `due` already. */
    const queued = new Set<ThreadId>();
    const wakeTimers = yield* FiberMap.make<ThreadId>();
    const retryTimers = yield* FiberMap.make<ThreadId>();

    const offer = (threadId: ThreadId) =>
      Effect.suspend(() => {
        if (queued.has(threadId)) return Effect.void;
        queued.add(threadId);
        return Queue.offer(due, threadId).pipe(Effect.asVoid);
      });

    /** Looks again after `delay`, unless a look on the same timer is already waiting. */
    const later = (
      timers: FiberMap.FiberMap<ThreadId>,
      threadId: ThreadId,
      delay: Duration.Duration,
    ) =>
      FiberMap.run(timers, threadId, Effect.sleep(delay).pipe(Effect.andThen(offer(threadId))), {
        onlyIfMissing: true,
      }).pipe(Effect.asVoid);

    const forget = (threadId: ThreadId) =>
      Effect.gen(function* () {
        watches.delete(threadId);
        yield* FiberMap.remove(wakeTimers, threadId);
        yield* FiberMap.remove(retryTimers, threadId);
      });

    /** Moves `upTo` past what was handled, as far as the oldest comment still open allows. */
    const advance = (watch: Watch) => {
      const open = [
        ...[...watch.pending.values()].map((p) => stampOf(p.listed)),
        ...watch.ready.map((r) => stampOf(r.listed)),
      ];
      const oldestOpen = open.reduce<Stamp | undefined>(
        (min, s) => (min === undefined || isAfter(min, s) ? s : min),
        undefined,
      );
      const folded = watch.handled.filter(
        (s) => oldestOpen === undefined || isAfter(oldestOpen, s),
      );
      const top = latest(folded);
      if (top !== undefined && isAfter(top, watch.upTo)) watch.upTo = top;
      watch.handled = watch.handled.filter((s) => isAfter(s, watch.upTo));
    };

    /** Marks `listed` handled: delivered or passed over. */
    const handle = (watch: Watch, listed: PersonComment) => {
      watch.seen.push(listed.id);
      watch.handled.push(stampOf(listed));
    };

    /** Keeps what the watch handled with the binding, so a restart neither forgets nor repeats it. */
    const remember = (
      threadId: ThreadId,
      bound: BoundPr,
      watch: Watch,
      listed: ReadonlySet<string>,
    ) =>
      Effect.gen(function* () {
        advance(watch);
        watch.seen = trimmed(watch.seen, listed);
        const now = yield* Clock.currentTimeMillis;
        const woke = (wakes.get(watch.pr) ?? [])
          .filter((at) => now - at < DAY_MS)
          .slice(-MONITOR_MARK_COMMENT_WAKES_MAX);
        const fields: MonitorMark = {
          comments: watch.seen,
          ...(watch.upTo === undefined ? {} : { commentsUpTo: watch.upTo }),
          ...(woke.length === 0 ? {} : { commentWakes: woke }),
        };
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        if (Option.isNone(thread)) return;
        const next = (t: Thread) => withMonitorMark(t, bound, { ...markOf(t, bound), ...fields });
        if (next(thread.value) === thread.value) return;
        yield* runtimes.updateThread(threadId, next).pipe(Effect.ignore);
      });

    const onState = (thread: Thread, state: { readonly pr?: PrStatus | undefined }) =>
      Effect.gen(function* () {
        const badge = state.pr;
        if (!eligible(thread, badge)) return yield* forget(thread.id);
        const bound = thread.boundPr!;
        // A badge that read no reviews lists no comments, which isn't the same as none.
        if (badge.reviewUnread === true) return;
        const pr = prKey(bound);
        let watch = watches.get(thread.id);
        if (watch !== undefined && watch.pr !== pr) {
          yield* forget(thread.id);
          watch = undefined;
        }
        const listed = badge.personComments ?? [];
        const listedIds = new Set(listed.map((c) => c.id));
        const kept = bound.seen;
        if (!wakes.has(pr)) wakes.set(pr, [...(kept?.commentWakes ?? [])]);
        if (watch === undefined) {
          // The first look with nothing kept is a baseline: what's there already wakes nobody.
          const baseline = kept?.comments === undefined;
          watch = {
            pr,
            upTo: baseline ? latest(listed.map(stampOf)) : kept?.commentsUpTo,
            handled: [],
            seen: baseline ? listed.map((c) => c.id) : [...(kept?.comments ?? [])],
            pending: new Map(),
            ready: [],
          };
          watches.set(thread.id, watch);
          if (baseline) return yield* remember(thread.id, bound, watch, listedIds);
        }
        const w = watch;
        // New means after the newest handled, and not handled by id either: a comment that slides
        // back into the badge's window when newer ones are deleted is old, whatever `seen` forgot.
        const fresh = listed.filter(
          (c) =>
            isAfter(stampOf(c), w.upTo) &&
            !w.seen.includes(c.id) &&
            !w.pending.has(c.id) &&
            !w.ready.some((r) => r.listed.id === c.id),
        );
        // A merged or closed PR's comments do nothing: resuming finished work is the user's call.
        if (badge.state !== "OPEN") {
          if (fresh.length === 0 && w.pending.size === 0 && w.ready.length === 0) return;
          for (const each of fresh) yield* passed(thread.id, each.id, "closed");
          for (const id of w.pending.keys()) yield* passed(thread.id, id, "closed");
          for (const each of [
            ...fresh,
            ...[...w.pending.values()].map((p) => p.listed),
            ...w.ready.map((r) => r.listed),
          ])
            handle(w, each);
          w.pending.clear();
          w.ready = [];
          yield* FiberMap.remove(wakeTimers, thread.id);
          yield* FiberMap.remove(retryTimers, thread.id);
          return yield* remember(thread.id, bound, w, listedIds);
        }
        if (fresh.length === 0) return;
        for (const each of fresh) w.pending.set(each.id, { listed: each, attempts: 0 });
        yield* offer(thread.id);
      });

    /** What `threadId` posted in its tool calls since `since`, from the turn already running then. */
    const postedSince = (threadId: ThreadId, since: number) =>
      Effect.gen(function* () {
        const marks = yield* store.messageMarks(threadId);
        if (marks.length === 0) return undefined;
        const first = marks.findIndex((mark) => mark.at === undefined || mark.at >= since);
        // The message before the window may be a turn that started earlier and posted inside it.
        const from = marks[first === -1 ? marks.length - 1 : Math.max(0, first - 1)]!;
        const rows = yield* store.listMessagesFrom(threadId, from.seq);
        return postedIn(rows.map((row) => row.message));
      });

    /**
     * Whether `comment`, posted with the user's login, is a Gram thread's own: the worker's, its
     * orchestrator's, or a sibling worker's under the same orchestrator.
     */
    const ownComment = (thread: Thread, comment: FetchedComment) =>
      Effect.gen(function* () {
        const postedAt = Date.parse(comment.createdAt);
        const since = Number.isNaN(postedAt) ? 0 : postedAt - OWN_COMMENT_LOOKBACK_MS;
        const orchestrator = thread.spawnedBy?.threadId;
        const siblings =
          orchestrator === undefined
            ? []
            : (yield* store.listThreads)
                .filter((t) => t.spawnedBy?.threadId === orchestrator && t.id !== thread.id)
                .map((t) => t.id);
        const threads = [
          thread.id,
          ...(orchestrator === undefined ? [] : [orchestrator]),
          ...siblings,
        ];
        for (const id of threads) {
          const posted: Posted | undefined = yield* postedSince(id, since).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (posted !== undefined && isOwnComment(comment, posted)) return true;
        }
        return false;
      });

    /** How long the rate limit holds the next wake of `pr` from `now`; 0 when it may go. */
    const holdFor = (pr: string, now: number) => {
      const woke = (wakes.get(pr) ?? []).filter((at) => now - at < DAY_MS);
      wakes.set(pr, woke);
      const hour = woke.filter((at) => now - at < HOUR_MS);
      const last = woke.at(-1);
      const waitGap = last === undefined ? 0 : last + Duration.toMillis(limits.minGap) - now;
      const waitHour = hour.length < limits.perHour ? 0 : hour[0]! + HOUR_MS - now;
      const waitDay = woke.length < limits.perDay ? 0 : woke[0]! + DAY_MS - now;
      return Math.max(waitGap, waitHour, waitDay, 0);
    };

    /** Sends what is ready, as one notice, when the rate limit allows; otherwise waits for it. */
    const deliver = (thread: Thread, bound: BoundPr, watch: Watch, listed: ReadonlySet<string>) =>
      Effect.gen(function* () {
        if (watch.ready.length === 0) return;
        const now = yield* Clock.currentTimeMillis;
        const wait = holdFor(watch.pr, now);
        if (wait > 0) {
          yield* Effect.logDebug("pr comment wake held by its rate limit").pipe(
            Effect.annotateLogs({ threadId: thread.id, pr: bound.number, waitMs: wait }),
          );
          return yield* later(wakeTimers, thread.id, Duration.millis(wait));
        }
        // Merged or closed while it waited: the next state the watch sees passes these over.
        if ((yield* publisher.badgeFor(thread))?.state !== "OPEN") return;
        const ready = watch.ready;
        const comments = ready.map((r) => r.comment);
        const text = commentNoticeText(bound.repo, bound.number, comments);
        const sent = yield* runtimes
          .sendNotice(thread.id, `${PR_COMMENT_KEY}${watch.pr}:${comments[0]!.id}`, { text })
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("pr comment notice not sent").pipe(
                Effect.annotateLogs({ threadId: thread.id, error: String(error) }),
                // An agent that can't start still has the notice in its queue.
                Effect.as(error._tag === "AgentUnavailable"),
              ),
            ),
          );
        yield* Effect.logDebug("pr comment notice sent").pipe(
          Effect.annotateLogs({ threadId: thread.id, pr: bound.number, comments: comments.length }),
        );
        // Sent or not, these are done with: a thread that has gone has no one to tell.
        watch.ready = [];
        for (const each of ready) handle(watch, each.listed);
        if (sent) wakes.set(watch.pr, [...(wakes.get(watch.pr) ?? []), now]);
        yield* remember(thread.id, bound, watch, listed);
      });

    /** The wait before the next try of a lookup that has failed `attempts` times. */
    const backoff = (attempts: number) =>
      Duration.millis(Duration.toMillis(limits.retryAfter) * 2 ** Math.max(attempts - 1, 0));

    const look = (threadId: ThreadId) =>
      Effect.gen(function* () {
        queued.delete(threadId);
        const watch = watches.get(threadId);
        if (watch === undefined) return;
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        if (Option.isNone(thread)) return yield* forget(threadId);
        const badge = yield* publisher.badgeFor(thread.value);
        if (!eligible(thread.value, badge) || prKey(thread.value.boundPr!) !== watch.pr) return;
        const bound = thread.value.boundPr!;
        const listed = new Set((badge.personComments ?? []).map((c) => c.id));
        // Merged or closed since: the next state the watch sees passes them over.
        if (badge.state !== "OPEN") return;
        const cwd = effectiveCheckout(thread.value).path;
        const bots = reviewBotsOf(yield* store.getSettings);
        const failed: Array<Pending> = [];
        if (watch.pending.size > 0) {
          const now = yield* Clock.currentTimeMillis;
          // One backing off after a failed lookup waits its turn, whatever else wakes the look.
          const batch = [...watch.pending.values()]
            .filter((p) => p.nextAt === undefined || p.nextAt <= now)
            .slice(0, 30);
          // What was read before isn't read again.
          const unread = batch.filter((p) => p.fetched === undefined).map((p) => p.listed.id);
          if (unread.length > 0) {
            const fetched = yield* asBackground(reads.fetch(cwd, unread)).pipe(Effect.option);
            if (Option.isNone(fetched)) {
              for (const p of batch) if (p.fetched === undefined) failed.push(p);
            } else {
              const byId = new Map(fetched.value.map((c) => [c.id, c]));
              for (const p of batch) {
                if (p.fetched !== undefined) continue;
                const found = byId.get(p.listed.id);
                if (found === undefined) {
                  watch.pending.delete(p.listed.id);
                  yield* passed(threadId, p.listed.id, "gone");
                  handle(watch, p.listed);
                } else p.fetched = found;
              }
            }
          }
          for (const p of batch) {
            const comment = p.fetched;
            if (comment === undefined || !watch.pending.has(p.listed.id)) continue;
            let why: PassReason | undefined = passOver(comment, bots);
            if (
              why === undefined &&
              comment.viewerDidAuthor &&
              (yield* ownComment(thread.value, comment))
            )
              why = "own";
            // The author as the badge listed it and as the lookup found it must agree.
            if (why === undefined && p.listed.author.toLowerCase() !== comment.author.toLowerCase())
              why = "untrusted";
            if (why === undefined) {
              const permission = yield* asBackground(
                reads.permission(cwd, bound.repo, comment.author),
              ).pipe(Effect.option);
              if (Option.isNone(permission)) {
                failed.push(p);
                continue;
              }
              if (!canWrite(permission.value)) why = "untrusted";
            }
            watch.pending.delete(p.listed.id);
            if (why !== undefined) {
              yield* passed(threadId, p.listed.id, why);
              handle(watch, p.listed);
            } else watch.ready.push({ listed: p.listed, comment });
          }
          let retryIn: Duration.Duration | undefined;
          for (const p of failed) {
            p.attempts++;
            if (p.attempts >= limits.attempts) {
              // Given up: never trusted. One line, with no author and nothing the comment says.
              watch.pending.delete(p.listed.id);
              handle(watch, p.listed);
              yield* Effect.logWarning("pr comment not verified; passed over as untrusted").pipe(
                Effect.annotateLogs({ threadId, id: p.listed.id, attempts: p.attempts }),
              );
              continue;
            }
            const wait = backoff(p.attempts);
            p.nextAt = now + Duration.toMillis(wait);
            if (retryIn === undefined || Duration.toMillis(wait) < Duration.toMillis(retryIn))
              retryIn = wait;
          }
          if (retryIn !== undefined) yield* later(retryTimers, threadId, retryIn);
          // More than one lookup holds: the rest go next.
          else if (batch.length === 30) yield* offer(threadId);
          yield* remember(threadId, bound, watch, listed);
        }
        yield* deliver(thread.value, bound, watch, listed);
      });

    yield* Queue.take(due).pipe(
      Effect.flatMap((threadId) => Effect.exit(look(threadId))),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* publisher.observe({ onState, onRound: () => Effect.void }, { replay: true });
  }),
);
