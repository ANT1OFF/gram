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
import { postsIn, type Post } from "./posted-comments.ts";
import {
  commentNoticeText,
  OWN_COMMENT_LOOKBACK_MS,
  ownCommentPosts,
  passOver,
  type PassReason,
  type PostSource,
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

const msOf = (at: string): number => {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/** Whether `a` comes after `b`; everything comes after nothing. */
const isAfter = (a: Stamp, b: Stamp | undefined): boolean =>
  b === undefined || msOf(a.at) > msOf(b.at) || (msOf(a.at) === msOf(b.at) && a.id > b.id);

const latest = (stamps: ReadonlyArray<Stamp>): Stamp | undefined =>
  stamps.reduce<Stamp | undefined>((max, s) => (isAfter(s, max) ? s : max), undefined);

const oldest = (stamps: ReadonlyArray<Stamp>): Stamp | undefined =>
  stamps.reduce<Stamp | undefined>(
    (min, s) => (min === undefined || isAfter(min, s) ? s : min),
    undefined,
  );

const stampOf = (c: PersonComment): Stamp => ({ at: c.at, id: c.id });

/**
 * How far behind the newest handled comment the floor stays. GitHub's times have whole seconds,
 * and a read can list a comment late, after a newer one was handled: one inside this window that
 * wasn't handled still counts as new.
 */
export const LATE_COMMENT_GRACE_MS = 5 * 60_000;

/** A stamp `ms` milliseconds before `stamp`, before any comment posted then. */
const before = (stamp: Stamp, ms: number): Stamp | undefined => {
  const at = msOf(stamp.at) - ms;
  return Number.isFinite(at) ? { at: new Date(at).toISOString(), id: "" } : undefined;
};

/** Whether `stamp` has a time that can be put in order. */
const timed = (stamp: Stamp): boolean => Number.isFinite(msOf(stamp.at));

/** A kept entry, from a mark that may hold a plain id an earlier build wrote: that one has no time. */
const keptEntry = (each: string | { readonly id: string; readonly at: string }) =>
  typeof each === "string" ? ([each, ""] as const) : ([each.id, each.at] as const);

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
  /** Anything at or before it is old; every comment handled after it is in `seen`. */
  floor: Stamp | undefined;
  /** Comments delivered or passed over after `floor`, by id, with when each was posted. */
  seen: Map<string, string>;
  readonly pending: Map<string, Pending>;
  /** Comments that will wake the worker once the rate limit allows. */
  ready: Array<{ readonly listed: PersonComment; readonly comment: FetchedComment }>;
  /** Posts of Gram threads already spent explaining a comment, each only once. */
  readonly used: Set<string>;
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

    /** When each thread's retry timer fires, epoch ms. */
    const retryAt = new Map<ThreadId, number>();

    /** Looks again at `at`, unless a retry is already due by then: an earlier one replaces a later. */
    const retryBy = (threadId: ThreadId, at: number, now: number) =>
      Effect.gen(function* () {
        const set = retryAt.get(threadId);
        if (set !== undefined && set <= at && set > now) return;
        retryAt.set(threadId, at);
        yield* FiberMap.run(
          retryTimers,
          threadId,
          Effect.sleep(Duration.millis(Math.max(at - now, 0))).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                if (retryAt.get(threadId) === at) retryAt.delete(threadId);
                return offer(threadId);
              }),
            ),
          ),
        );
      });

    const forget = (threadId: ThreadId) =>
      Effect.gen(function* () {
        watches.delete(threadId);
        retryAt.delete(threadId);
        yield* FiberMap.remove(wakeTimers, threadId);
        yield* FiberMap.remove(retryTimers, threadId);
      });

    /** Marks `listed` handled: delivered or passed over. */
    const handle = (watch: Watch, listed: PersonComment) => {
      watch.seen.set(listed.id, listed.at);
    };

    /**
     * Raises the floor to a little behind the newest handled comment, never past one still open,
     * and keeps in `seen` every comment handled after it, as many as the mark holds.
     */
    const settle = (watch: Watch) => {
      const handled = [...watch.seen].map(([id, at]) => ({ id, at }));
      const open = [
        ...[...watch.pending.values()].map((p) => stampOf(p.listed)),
        ...watch.ready.map((r) => stampOf(r.listed)),
      ].filter(timed);
      const newest = latest(handled.filter(timed));
      const firstOpen = oldest(open);
      let floor = newest === undefined ? undefined : before(newest, LATE_COMMENT_GRACE_MS);
      // A comment still open stays after the floor, so a restart finds it new again.
      if (floor !== undefined && firstOpen !== undefined && !isAfter(firstOpen, floor))
        floor = before(firstOpen, 1);
      if (floor !== undefined && isAfter(floor, watch.floor)) watch.floor = floor;
      const kept = handled
        .filter((each) => isAfter(each, watch.floor))
        .toSorted((a, b) => (isAfter(a, b) ? -1 : 1));
      // More handled inside the window than the mark holds: what can't be kept is old, by the floor.
      if (kept.length > MONITOR_MARK_COMMENTS_MAX) watch.floor = kept[MONITOR_MARK_COMMENTS_MAX]!;
      watch.seen = new Map(
        kept
          .slice(0, MONITOR_MARK_COMMENTS_MAX)
          .toReversed()
          .map((each) => [each.id, each.at]),
      );
    };

    /** Keeps what the watch handled with the binding, so a restart neither forgets nor repeats it. */
    const remember = (threadId: ThreadId, bound: BoundPr, watch: Watch) =>
      Effect.gen(function* () {
        settle(watch);
        const now = yield* Clock.currentTimeMillis;
        const woke = (wakes.get(watch.pr) ?? [])
          .filter((at) => now - at < DAY_MS)
          .slice(-MONITOR_MARK_COMMENT_WAKES_MAX);
        const fields: MonitorMark = {
          comments: [...watch.seen].map(([id, at]) => ({ id, at })),
          ...(watch.floor === undefined ? {} : { commentsFloor: watch.floor }),
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
        const kept = bound.seen;
        if (!wakes.has(pr)) wakes.set(pr, [...(kept?.commentWakes ?? [])]);
        if (watch === undefined) {
          // The first look with nothing kept is a baseline: what's there already wakes nobody.
          const baseline = kept?.comments === undefined;
          watch = {
            pr,
            floor: baseline ? undefined : kept?.commentsFloor,
            seen: new Map(
              baseline
                ? listed.map((c) => [c.id, c.at] as const)
                : (kept?.comments ?? []).map(keptEntry),
            ),
            pending: new Map(),
            ready: [],
            used: new Set(),
          };
          watches.set(thread.id, watch);
          if (baseline) return yield* remember(thread.id, bound, watch);
        }
        const w = watch;
        // New means after the floor as it stood and not handled: a comment that slides back into
        // the badge's window when newer ones are deleted is at or before the floor, whatever
        // `seen` forgot. Worked out before the floor moves, so nothing listed is passed over.
        const fresh = listed.filter(
          (c) =>
            isAfter(stampOf(c), w.floor) &&
            !w.seen.has(c.id) &&
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
          retryAt.delete(thread.id);
          return yield* remember(thread.id, bound, w);
        }
        for (const each of fresh) w.pending.set(each.id, { listed: each, attempts: 0 });
        // A full listing that starts after the floor may have pushed comments out of view (a
        // flood). Those are skipped, never delivered later: the floor moves up to the listing, but
        // stays below every comment listed and not handled yet, the new ones above included, so
        // only what is truly out of every window is passed by.
        let floorRaised = false;
        const from = badge.personCommentsFrom;
        if (from !== undefined && w.floor !== undefined && isAfter({ at: from, id: "" }, w.floor)) {
          let raised = before({ at: from, id: "" }, 1);
          const firstOpen = oldest(
            [...[...w.pending.values()].map((p) => p.listed), ...w.ready.map((r) => r.listed)]
              .map(stampOf)
              .filter(timed),
          );
          if (raised !== undefined && firstOpen !== undefined && !isAfter(firstOpen, raised))
            raised = before(firstOpen, 1);
          if (raised !== undefined && isAfter(raised, w.floor)) {
            // Times only: who wrote what stays out of the log.
            yield* Effect.logInfo("pr comments older than the listing may have been skipped").pipe(
              Effect.annotateLogs({
                threadId: thread.id,
                pr: bound.number,
                from: w.floor.at,
                to: raised.at,
              }),
            );
            w.floor = raised;
            floorRaised = true;
          }
        }
        if (floorRaised) yield* remember(thread.id, bound, w);
        if (fresh.length > 0) yield* offer(thread.id);
      });

    /** What `threadId` posted in its tool calls since `since`, from the turn already running then. */
    const postsSince = (threadId: ThreadId, since: number) =>
      Effect.gen(function* () {
        const marks = yield* store.messageMarks(threadId);
        if (marks.length === 0) return [];
        const first = marks.findIndex((mark) => mark.at === undefined || mark.at >= since);
        // The message before the window may be a turn that started earlier and posted inside it.
        const from = marks[first === -1 ? marks.length - 1 : Math.max(0, first - 1)]!;
        const rows = yield* store.listMessagesFrom(threadId, from.seq);
        return postsIn(rows.map((row) => row.message));
      }).pipe(Effect.orElseSucceed((): ReadonlyArray<Post> => []));

    /**
     * The posts of the Gram threads whose comments go out with the user's login: the worker's, its
     * orchestrator's, and its sibling workers', read once per look from `since`.
     */
    const sourcesOf = (thread: Thread, since: number) =>
      Effect.gen(function* () {
        const orchestrator = thread.spawnedBy?.threadId;
        const siblings =
          orchestrator === undefined
            ? []
            : (yield* store.listThreads).filter(
                (t) => t.spawnedBy?.threadId === orchestrator && t.id !== thread.id,
              );
        const sources: Array<PostSource> = [
          { kind: "self", posts: yield* postsSince(thread.id, since) },
        ];
        if (orchestrator !== undefined)
          sources.push({ kind: "orchestrator", posts: yield* postsSince(orchestrator, since) });
        for (const sibling of siblings)
          sources.push({ kind: "sibling", posts: yield* postsSince(sibling.id, since) });
        return sources;
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
    const deliver = (thread: Thread, bound: BoundPr, watch: Watch) =>
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
        yield* remember(thread.id, bound, watch);
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
          // The Gram threads' posts, read once for the whole batch from before its oldest comment.
          let sources: ReadonlyArray<PostSource> | undefined;
          const postsFor = Effect.suspend(() => {
            if (sources !== undefined) return Effect.succeed(sources);
            const times = batch.map((p) => msOf(p.fetched?.createdAt ?? p.listed.at));
            const first = Math.min(...times.filter((t) => Number.isFinite(t)), now);
            return sourcesOf(thread.value, first - OWN_COMMENT_LOOKBACK_MS).pipe(
              Effect.tap((read) =>
                Effect.sync(() => {
                  sources = read;
                }),
              ),
            );
          });
          for (const p of batch) {
            const comment = p.fetched;
            if (comment === undefined || !watch.pending.has(p.listed.id)) continue;
            let why: PassReason | undefined = passOver(comment, bots);
            if (why === undefined && comment.viewerDidAuthor) {
              const spent = ownCommentPosts(comment, yield* postsFor, bound, watch.used);
              if (spent !== undefined) {
                for (const key of spent) watch.used.add(key);
                why = "own";
              }
            }
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
            p.nextAt = now + Duration.toMillis(backoff(p.attempts));
          }
          // The earliest any comment backing off is due, whichever failed first: none is stranded
          // behind a retry that has already gone.
          const backingOff = [...watch.pending.values()].flatMap((p) =>
            p.nextAt !== undefined && p.nextAt > now ? [p.nextAt] : [],
          );
          if (backingOff.length > 0) yield* retryBy(threadId, Math.min(...backingOff), now);
          // More than one lookup holds: the rest go next.
          if (batch.length === 30) yield* offer(threadId);
          yield* remember(threadId, bound, watch);
        }
        yield* deliver(thread.value, bound, watch);
      });

    yield* Queue.take(due).pipe(
      Effect.flatMap((threadId) => Effect.exit(look(threadId))),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* publisher.observe({ onState, onRound: () => Effect.void }, { replay: true });
  }),
);
