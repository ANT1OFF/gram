// A person's comment on a worker's PR wakes the worker. It rides the review monitor's poll: the
// badge read with the reviews lists people's comments by id, and only a new id costs a lookup of
// what it says (one `gh api graphql` call for every new comment together) and of its author's
// permission (one `gh api` call per author, kept ten minutes). The comment reaches the worker
// fenced as untrusted external content, and grants nothing.

import {
  effectiveCheckout,
  MONITOR_MARK_COMMENTS_MAX,
  reviewBotsOf,
  type BoundPr,
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
import {
  commentNoticeText,
  isOwnComment,
  OWN_COMMENT_LOOKBACK_MS,
  passOver,
  toolInputs,
  type PassReason,
} from "./pr-comment-rules.ts";

/** How often a PR's comments may wake its worker. */
export interface PrCommentWakeLimits {
  /** The least time between two wakes. */
  readonly minGap: Duration.Duration;
  /** The most wakes in any hour. */
  readonly perHour: number;
  /** How long a lookup that failed waits before it is tried again. */
  readonly retryAfter: Duration.Duration;
}

export const DEFAULT_PR_COMMENT_WAKE_LIMITS: PrCommentWakeLimits = {
  minGap: Duration.minutes(1),
  perHour: 6,
  retryAfter: Duration.minutes(1),
};

/** The rate limit and retry delay; tests set their own. */
export const PrCommentWakeConfig = Context.Reference<PrCommentWakeLimits>(
  "@gram/server/PrCommentWakeConfig",
  { defaultValue: () => DEFAULT_PR_COMMENT_WAKE_LIMITS },
);

/** The `sendNotice` key prefix of a comment notice; each notice has its own, so none replaces another. */
export const PR_COMMENT_KEY = "pr-comment:";

const HOUR_MS = 60 * 60_000;

/** What the watch keeps of one thread's PR. */
interface Watch {
  /** `repo#number`, lower-cased: what `seen` is of. */
  readonly pr: string;
  /** Comments delivered or passed over, by id, oldest first. */
  seen: Array<string>;
  /** New comments not yet looked up or decided, by id. */
  readonly pending: Map<string, PersonComment>;
  /** Comments that will wake the worker once the rate limit allows. */
  ready: Array<FetchedComment>;
  /** When each wake in the past hour went out, epoch ms. */
  wakes: Array<number>;
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
    const due = yield* Queue.unbounded<ThreadId>();
    /** Threads with a look in `due` already. */
    const queued = new Set<ThreadId>();
    const timers = yield* FiberMap.make<ThreadId>();

    const offer = (threadId: ThreadId) =>
      Effect.suspend(() => {
        if (queued.has(threadId)) return Effect.void;
        queued.add(threadId);
        return Queue.offer(due, threadId).pipe(Effect.asVoid);
      });

    /** Looks again after `delay`, unless a look is already waiting to run. */
    const later = (threadId: ThreadId, delay: Duration.Duration) =>
      FiberMap.run(timers, threadId, Effect.sleep(delay).pipe(Effect.andThen(offer(threadId))), {
        onlyIfMissing: true,
      }).pipe(Effect.asVoid);

    const forget = (threadId: ThreadId) =>
      Effect.gen(function* () {
        watches.delete(threadId);
        yield* FiberMap.remove(timers, threadId);
      });

    /** Keeps `watch.seen` with the binding, so a restart neither forgets nor repeats a delivery. */
    const remember = (
      threadId: ThreadId,
      bound: BoundPr,
      watch: Watch,
      listed: ReadonlySet<string>,
    ) =>
      Effect.gen(function* () {
        watch.seen = trimmed(watch.seen, listed);
        const comments = watch.seen;
        const thread = yield* store.getThread(threadId).pipe(Effect.option);
        if (Option.isNone(thread)) return;
        const next = (t: Thread) => withMonitorMark(t, bound, { ...markOf(t, bound), comments });
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
        const kept = bound.seen?.comments;
        if (watch === undefined) {
          // The first look with nothing kept is a baseline: what's there already wakes nobody.
          watch = {
            pr,
            seen: kept === undefined ? listed.map((c) => c.id) : [...kept],
            pending: new Map(),
            ready: [],
            wakes: [],
          };
          watches.set(thread.id, watch);
          if (kept === undefined) return yield* remember(thread.id, bound, watch, listedIds);
        }
        const fresh = listed.filter(
          (c) =>
            !watch.seen.includes(c.id) &&
            !watch.pending.has(c.id) &&
            !watch.ready.some((r) => r.id === c.id),
        );
        // A merged or closed PR's comments do nothing: resuming finished work is the user's call.
        if (badge.state !== "OPEN") {
          if (fresh.length === 0 && watch.pending.size === 0 && watch.ready.length === 0) return;
          for (const each of fresh) yield* passed(thread.id, each.id, "closed");
          for (const id of watch.pending.keys()) yield* passed(thread.id, id, "closed");
          watch.seen.push(
            ...fresh.map((c) => c.id),
            ...watch.pending.keys(),
            ...watch.ready.map((r) => r.id),
          );
          watch.pending.clear();
          watch.ready = [];
          yield* FiberMap.remove(timers, thread.id);
          return yield* remember(thread.id, bound, watch, listedIds);
        }
        if (fresh.length === 0) return;
        for (const each of fresh) watch.pending.set(each.id, each);
        yield* offer(thread.id);
      });

    /** The words of every tool call `threadId` made since `since`. */
    const inputsSince = (threadId: ThreadId, since: number) =>
      Effect.gen(function* () {
        const marks = yield* store.messageMarks(threadId);
        const from = marks.find((mark) => mark.at === undefined || mark.at >= since);
        if (from === undefined) return [];
        const rows = yield* store.listMessagesFrom(threadId, from.seq);
        return toolInputs(rows.map((row) => row.message));
      });

    /** Whether `comment`, posted with the user's login, is the worker's own or its orchestrator's. */
    const ownComment = (thread: Thread, comment: FetchedComment) =>
      Effect.gen(function* () {
        const posted = Date.parse(comment.createdAt);
        const since = Number.isNaN(posted) ? 0 : posted - OWN_COMMENT_LOOKBACK_MS;
        const threads = [thread.id, ...(thread.spawnedBy ? [thread.spawnedBy.threadId] : [])];
        for (const id of threads) {
          const inputs = yield* inputsSince(id, since).pipe(Effect.orElseSucceed(() => []));
          if (isOwnComment(comment, inputs)) return true;
        }
        return false;
      });

    /** Sends what is ready, as one notice, when the rate limit allows; otherwise waits for it. */
    const deliver = (thread: Thread, bound: BoundPr, watch: Watch, listed: ReadonlySet<string>) =>
      Effect.gen(function* () {
        if (watch.ready.length === 0) return;
        const now = yield* Clock.currentTimeMillis;
        watch.wakes = watch.wakes.filter((at) => now - at < HOUR_MS);
        const last = watch.wakes.at(-1);
        const gap = Duration.toMillis(limits.minGap);
        const waitGap = last === undefined ? 0 : last + gap - now;
        const waitHour = watch.wakes.length < limits.perHour ? 0 : watch.wakes[0]! + HOUR_MS - now;
        const wait = Math.max(waitGap, waitHour);
        if (wait > 0) {
          yield* Effect.logDebug("pr comment wake held by its rate limit").pipe(
            Effect.annotateLogs({ threadId: thread.id, pr: bound.number, waitMs: wait }),
          );
          return yield* later(thread.id, Duration.millis(wait));
        }
        // Merged or closed while it waited: the next state the watch sees passes these over.
        if ((yield* publisher.badgeFor(thread))?.state !== "OPEN") return;
        const comments = watch.ready;
        const text = commentNoticeText(bound.repo, bound.number, comments);
        const sent = yield* runtimes
          .sendNotice(thread.id, `${PR_COMMENT_KEY}${prKey(bound)}:${comments[0]!.id}`, { text })
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
        watch.seen.push(...comments.map((c) => c.id));
        if (sent) watch.wakes.push(now);
        yield* remember(thread.id, bound, watch, listed);
      });

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
        if (watch.pending.size > 0) {
          const ids = [...watch.pending.keys()].slice(0, 30);
          const fetched = yield* asBackground(reads.fetch(cwd, ids)).pipe(Effect.option);
          if (Option.isNone(fetched)) {
            yield* deliver(thread.value, bound, watch, listed);
            return yield* later(threadId, limits.retryAfter);
          }
          const byId = new Map(fetched.value.map((c) => [c.id, c]));
          let retry = false;
          for (const id of ids) {
            const comment = byId.get(id);
            const listedAs = watch.pending.get(id);
            let why: PassReason | undefined =
              comment === undefined ? "gone" : passOver(comment, bots);
            if (
              why === undefined &&
              comment!.viewerDidAuthor &&
              (yield* ownComment(thread.value, comment!))
            )
              why = "own";
            if (why === undefined) {
              // The author as the badge listed it and as the lookup found it must agree.
              const author = comment!.author;
              if (listedAs !== undefined && listedAs.author.toLowerCase() !== author.toLowerCase())
                why = "untrusted";
              else {
                const permission = yield* asBackground(
                  reads.permission(cwd, bound.repo, author),
                ).pipe(Effect.option);
                if (Option.isNone(permission)) {
                  retry = true;
                  continue;
                }
                if (!canWrite(permission.value)) why = "untrusted";
              }
            }
            watch.pending.delete(id);
            if (why !== undefined) {
              yield* passed(threadId, id, why);
              watch.seen.push(id);
            } else watch.ready.push(comment!);
          }
          if (watch.pending.size > 0 && !retry) yield* offer(threadId);
          if (retry) yield* later(threadId, limits.retryAfter);
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
