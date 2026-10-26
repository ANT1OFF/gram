import * as Schema from "effect/Schema";
import type { GitState } from "./git.ts";
import { RequestId, ThreadId, TurnId } from "./ids.ts";
import { WrapUpDataSchema } from "./wrap-up.ts";

// The helper model's help with a thread: "where you left off" recaps and suggested replies.

const HOUR_MS = 60 * 60 * 1000;

/** How long a thread has to sit idle before opening it shows where you left off. */
export const RECAP_IDLE_MS = 2 * HOUR_MS;

/** Away from a thread this long, it gets a recap even when nothing happened in it since. */
export const RECAP_AWAY_MS = 24 * HOUR_MS;

/**
 * A turn that ended while you weren't looking has its recap worked out this long after, so it's
 * there the moment the thread qualifies.
 */
export const RECAP_PRECOMPUTE_MS = 30 * 60 * 1000;

/** At most this many characters, and three sentences, or the recap is dropped. */
export const RECAP_MAX_CHARS = 450;

/** A **Next** line longer than this is dropped rather than cut. */
export const RECAP_NEXT_MAX_CHARS = 80;

/** What the helper said about a thread you're coming back to. */
export const ThreadRecap = Schema.Struct({
  /** Two or three sentences, past tense: what you asked for and what the agent did. */
  recap: Schema.String,
  /** The likeliest next step, imperative; `null` when the thread looks finished. */
  next: Schema.NullOr(Schema.String),
  /** Up to three messages you might send next, the first suggested replies; may be empty. */
  replies: Schema.Array(Schema.String),
});
export type ThreadRecap = typeof ThreadRecap.Type;

/** `thread.recap`'s answer: a recap, and what it was made from. */
export const RecapView = Schema.Struct({
  threadId: ThreadId,
  recap: ThreadRecap,
  /** Epoch ms of the thread's last activity, which the card's "Last active 3 h ago" counts from. */
  lastActiveAt: Schema.Number,
  /** The last turn it covers, which its replies belong to; absent for a thread with no turn. */
  turnId: Schema.optionalKey(TurnId),
  /**
   * The agent's own `wrap_up` for that turn, which `recap` then repeats with no next step or
   * replies: no helper was asked, so the helper's consent and settings don't come into it.
   */
  wrapUp: Schema.optionalKey(WrapUpDataSchema),
});
export type RecapView = typeof RecapView.Type;

export const RecapPayload = { threadId: ThreadId };

/** The most a worker's catch-up may hold, and two sentences, or it is dropped rather than cut. */
export const CATCH_UP_MAX_CHARS = 280;

/** What the helper said changed in a worker since you last looked: one or two sentences. */
export const WorkerCatchUp = Schema.Struct({ catchUp: Schema.String });
export type WorkerCatchUp = typeof WorkerCatchUp.Type;

/**
 * `thread.catchUp`'s answer for a worker opened after a report you hadn't seen: what changed since
 * you last looked, and the report it is keyed by. Absent when there is nothing new, the helper is
 * off or not allowed the conversation, or its call failed; the worker view then shows that report's
 * own summary.
 */
export const CatchUpView = Schema.Struct({
  threadId: ThreadId,
  text: Schema.String,
  /** Epoch ms of the report it covers up to, which keys the stored output. */
  reportAt: Schema.Number,
});
export type CatchUpView = typeof CatchUpView.Type;

/** Whether a worker has a report you haven't seen: one filed after you last moved away from it. */
export const catchUpDue = (
  reportAt: number | undefined,
  lastViewedAt: number | undefined,
): boolean => reportAt !== undefined && (lastViewedAt === undefined || reportAt > lastViewedAt);

/** When a thread you open deserves a recap. */
export interface RecapMoment {
  readonly now: number;
  readonly lastActivityAt: number;
  /** When you last moved away from the thread; absent when you never have since this was kept. */
  readonly lastViewedAt?: number | undefined;
  /** A turn is running or waiting on you, so there is nothing to come back to yet. */
  readonly busy: boolean;
}

/**
 * Idle at least `RECAP_IDLE_MS`, and either something happened since you last looked or you've been
 * away `RECAP_AWAY_MS`. A thread with no `lastViewedAt` counts as unseen.
 */
export const recapDue = ({ now, lastActivityAt, lastViewedAt, busy }: RecapMoment): boolean => {
  if (busy || now - lastActivityAt < RECAP_IDLE_MS) return false;
  return (
    lastViewedAt === undefined ||
    lastActivityAt > lastViewedAt ||
    now - lastViewedAt >= RECAP_AWAY_MS
  );
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The recap card's chips, from git and GitHub and never from the model: uncommitted files, whether
 * the branch's commits are pushed, and the PR. Empty for a repo with nothing going on.
 */
export const recapFacts = (git: GitState | undefined): string[] => {
  if (git === undefined || !git.repo) return [];
  const facts: string[] = [];
  if (git.changedFiles > 0) facts.push(plural(git.changedFiles, "file changed", "files changed"));
  const unpushed = git.aheadUpstream ?? (git.upstream === undefined ? git.aheadBase : 0);
  const branchWork = git.aheadBase > 0 || git.changedFiles > 0;
  if (unpushed > 0) facts.push("not pushed");
  else if (git.aheadBase > 0 && git.upstream !== undefined) facts.push("pushed");
  const pr = git.pr;
  if (pr !== undefined) {
    const state =
      pr.state === "MERGED"
        ? "merged"
        : pr.state === "CLOSED"
          ? "closed"
          : pr.isDraft
            ? "draft"
            : "open";
    facts.push(`#${pr.number} ${state}`);
  } else if (
    branchWork &&
    git.branch !== undefined &&
    // The git state leaves `base` out on the default branch itself, where no PR is expected.
    git.base !== undefined &&
    !git.base.endsWith(`/${git.branch}`)
  ) {
    facts.push("no PR yet");
  }
  return facts;
};

/** What the recap card saw happen, counted locally for the dogfood kill criteria. */
export const RecapEvent = Schema.Literals(["shown", "dismissed", "dismissedFast"]);
export type RecapEvent = typeof RecapEvent.Type;

/** A dismissal this soon after the card appeared counts as `dismissedFast`: it wasn't wanted. */
export const RECAP_DISMISSED_FAST_MS = 2_000;

/** Suggested replies for the thread's last turn, which a new turn or message makes stale. */
export const ThreadSuggestions = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  /** Most likely first, at most three; empty when nothing was obvious. */
  replies: Schema.Array(Schema.String),
  /**
   * What was sent for this turn is taken back: the plan it answered was edited, and `replies` is
   * empty. Asked for again, they are made against the plan as it is now.
   */
  stale: Schema.optionalKey(Schema.Literal(true)),
});
export type ThreadSuggestions = typeof ThreadSuggestions.Type;

export const SuggestionsPayload = { threadId: ThreadId };

/** A pending free-form question of the thread's, which `request.replies` drafts answers to. */
export const RequestRepliesPayload = { threadId: ThreadId, requestId: RequestId };

/** A pending request whose desktop notification wants a title; `count` asks that equal it. */
export const NoticeTitlePayload = {
  threadId: ThreadId,
  requestId: RequestId,
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 })),
};

/**
 * What the composer saw happen to a suggestion: shown once a turn, taken (whole or in part) once a
 * turn, each whole acceptance and each word taken, the accepted text edited before it was sent, or
 * dismissed with Esc.
 */
export const SuggestEvent = Schema.Literals([
  "shown",
  "taken",
  "accepted",
  "wordAccepted",
  "editedAfter",
  "dismissed",
]);
export type SuggestEvent = typeof SuggestEvent.Type;

/**
 * Accepted in whole or in part, per suggestion shown: under this after the dogfood week, suggested
 * replies go off by default (the 0.8 design's kill criterion).
 */
export const SUGGEST_KEEP_RATE = 0.2;

/**
 * The turns whose suggestions were taken, whole or a word at a time, per turn they were shown in;
 * undefined before any. Both are counted once a turn, so a word-by-word acceptance counts once.
 */
export const suggestKeepRate = (counts: {
  readonly shown: number;
  readonly taken: number;
}): number | undefined =>
  counts.shown === 0 ? undefined : Math.min(1, counts.taken / counts.shown);

export const HelperEventPayload = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("recap"), event: RecapEvent }),
  Schema.Struct({ kind: Schema.Literal("suggest"), event: SuggestEvent }),
]);
export type HelperEventPayload = typeof HelperEventPayload.Type;
