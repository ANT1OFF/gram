// The review monitor's and babysit mode's decisions as pure functions, so the
// stop conditions, flake reruns and SHA citations are testable without a server.

import {
  mergeStateAllowsMerge,
  requiredChecksGreen,
  requiredChecksOf,
  type BabysitReport,
  type BabysitState,
  type BabysitStopReason,
  type ChecksRollup,
  type MonitorMark,
  type PrReview,
  type PrReviewState,
  type PrStatus,
  type ReviewBot,
  type ReviewNoticeFinding,
  type ReviewSeverity,
  type ReviewThread,
  type ReviewVerdict,
} from "@gram/contracts";
import { actionsRunId, matchesBotLogin } from "@gram/git";

/** Rounds a declined thread may stay open before babysitting hands the point to the user. */
const DISAGREEMENT_ROUNDS = 2;

const BODY_LIMIT = 600;

export const short = (sha: string): string => sha.slice(0, 7);

/** What the monitor compares between two git states of a monitored PR. */
export interface MonitorSnapshot {
  /** The required checks, as `requiredChecksOf` reads them: a check nobody requires wakes no one. */
  readonly checks: ChecksRollup;
  readonly verdict: ReviewVerdict | undefined;
  /** `verdict` was read off a badge, not carried over ones that didn't read the reviews. */
  readonly reviewed: boolean;
  /** The head commit `verdict` is on. */
  readonly head?: string | undefined;
  readonly mergeState: string | undefined;
}

/**
 * The snapshot a review monitor kept with its binding (`BoundPr.seen`), for its first look after a
 * restart to compare against; `undefined` without one, when that look is only a baseline. A head it
 * never saw started out pending, with no verdict on it yet.
 */
export const markedSnapshot = (
  mark: MonitorMark | undefined,
  head: string | undefined,
): MonitorSnapshot | undefined => {
  if (mark?.checks === undefined) return undefined;
  const sameHead = head === undefined || mark.head === head;
  return {
    checks: sameHead ? mark.checks : "pending",
    verdict: sameHead ? mark.verdict : undefined,
    reviewed: true,
    head: sameHead ? mark.head : head,
    mergeState: mark.mergeState,
  };
};

/** `ciCatchUp` is checks found failing rather than seen to fail, which may have been reported already. */
export type NoticeReason = "ci" | "ciCatchUp" | "round" | "verdict" | "merge";

export const isCiOnly = (reasons: ReadonlySet<NoticeReason>): boolean =>
  reasons.size > 0 && [...reasons].every((reason) => reason === "ci" || reason === "ciCatchUp");

/** Merge states worth waking the agent for: ready, conflicting, or behind its base. */
const ACTIONABLE_MERGE_STATES: ReadonlySet<string> = new Set([
  "CLEAN",
  "UNSTABLE",
  "DIRTY",
  "BEHIND",
]);

/** UNSTABLE is CLEAN with a check nobody requires still red or running: no news between them. */
const mergeClass = (mergeState: string): string =>
  mergeState === "UNSTABLE" ? "CLEAN" : mergeState;

/** Why a state change warrants a notice; empty when it doesn't. */
export const noticeReasons = (
  previous: MonitorSnapshot,
  current: MonitorSnapshot,
): ReadonlyArray<NoticeReason> => {
  const reasons: Array<NoticeReason> = [];
  if (
    previous.checks === "pending" &&
    (current.checks === "passing" || current.checks === "failing")
  )
    reasons.push("ci");
  // A verdict first read is a baseline, as the monitor's first look is.
  if (previous.reviewed && current.verdict !== undefined && current.verdict !== previous.verdict)
    reasons.push("verdict");
  if (
    current.mergeState !== undefined &&
    previous.mergeState !== undefined &&
    mergeClass(current.mergeState) !== mergeClass(previous.mergeState) &&
    ACTIONABLE_MERGE_STATES.has(current.mergeState)
  )
    reasons.push("merge");
  return reasons;
};

/** SHAs a reply cites as its fix, as in "Fixed in 1a2b3c4: …". */
export const citedShas = (body: string): ReadonlyArray<string> =>
  Array.from(body.matchAll(/\bfixed in\s+`?([0-9a-f]{7,40})\b/gi), (match) =>
    (match[1] ?? "").toLowerCase(),
  );

/** Severities whose decline always needs the user, even in babysit mode. */
export const isBlockerSeverity = (severity: ReviewSeverity): boolean =>
  severity === "blocker" || severity === "outstanding";

const findingOf = (thread: ReviewThread): ReviewNoticeFinding => {
  const first = thread.comments[0];
  const body = (first?.body ?? "").trim();
  return {
    reviewThreadId: thread.id,
    path: thread.path,
    ...(thread.line === undefined ? {} : { line: thread.line }),
    body: body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}…` : body,
    ...(first === undefined || first.url === "" ? {} : { url: first.url }),
  };
};

/** Unresolved, current bot findings; outdated threads sit on code that has since changed. */
export const openFindings = (
  review: PrReview,
): {
  readonly blockers: ReadonlyArray<ReviewNoticeFinding>;
  readonly suggestions: ReadonlyArray<ReviewNoticeFinding>;
} => {
  const open = review.threads.filter((t) => t.byBot && !t.isResolved && !t.isOutdated);
  return {
    blockers: open.filter((t) => isBlockerSeverity(t.severity)).map(findingOf),
    suggestions: open.filter((t) => !isBlockerSeverity(t.severity)).map(findingOf),
  };
};

/**
 * The completed bot review babysitting hasn't counted as a round yet, if there is one. `announced` is
 * the id a round event carried, which holds even when the badge read at delivery is an older one.
 * The review already there at kick-off is owed only until something has been counted.
 */
export const uncountedReview = (
  state: BabysitState,
  review: PrReviewState | undefined,
  announced?: string,
): string | undefined => {
  const id = review?.roundInFlight === true ? undefined : review?.latestReviewId;
  const settled = (each: string) =>
    each === state.countedReviewId ||
    (state.countedReviewId !== undefined && each === state.existingReviewId);
  return [id, announced].find((each) => each !== undefined && !settled(each));
};

/** A review already on the PR when babysitting starts leaves work: changes requested or findings on head. */
export const leavesWork = (review: PrReviewState): boolean =>
  review.verdictOnHead === "changesRequested" ||
  (review.reviewedHead && review.threads.unresolved - review.threads.outdatedUnresolved > 0);

/** Every failing check was already reported to the agent on this head. */
export const alreadyReported = (
  state: BabysitState,
  failing: ReadonlyArray<FailingCheck>,
  head: string,
): boolean =>
  failing.length > 0 && failing.every((check) => state.failedChecks[check.name] === head);

export const unresolvedBotThreads = (review: PrReview): ReadonlySet<string> =>
  new Set(review.threads.filter((t) => t.byBot && !t.isResolved).map((t) => t.id));

/** The configured bot that reviewed this PR, else the first configured one. */
export const pickBot = (
  bots: ReadonlyArray<ReviewBot>,
  logins: ReadonlyArray<string>,
): ReviewBot | undefined =>
  bots.find((bot) => logins.some((login) => matchesBotLogin(bot.loginPattern, login))) ?? bots[0];

/**
 * Babysit's finish line: approved on head, required checks green, and a merge state GitHub would
 * merge from, which is UNSTABLE as well as CLEAN when only checks it doesn't require are red.
 */
export const isReadyToMerge = (badge: PrStatus): boolean =>
  badge.state === "OPEN" &&
  requiredChecksGreen(badge) &&
  badge.review?.verdictOnHead === "approved" &&
  mergeStateAllowsMerge(badge.mergeState);

export interface Halt {
  readonly reason: BabysitStopReason;
  readonly detail: string;
}

const addUnique = (ids: ReadonlyArray<string>, id: string) =>
  ids.includes(id) ? ids : [...ids, id];

export const markDeclined = (state: BabysitState, id: string): BabysitState => ({
  ...state,
  pendingDeclines: addUnique(state.pendingDeclines, id),
  declined: addUnique(state.declined, id),
});

export const markHandled = (state: BabysitState, id: string): BabysitState => ({
  ...state,
  handled: addUnique(state.handled, id),
  declined: state.declined.filter((d) => d !== id),
  pendingDeclines: state.pendingDeclines.filter((d) => d !== id),
});

/** Counts a completed bot round; a thread declined since the last round and still open is a disagreement. */
export const countRound = (state: BabysitState, stillOpen: ReadonlySet<string>): BabysitState => {
  const disagreements = { ...state.disagreements };
  for (const id of state.pendingDeclines) {
    if (stillOpen.has(id)) disagreements[id] = (disagreements[id] ?? 0) + 1;
  }
  return { ...state, rounds: state.rounds + 1, disagreements, pendingDeclines: [] };
};

/** The PR or counter condition that ends babysitting, if any. */
export const stopReasonOf = (state: BabysitState, badge: PrStatus): Halt | undefined => {
  if (badge.state === "MERGED")
    return { reason: "prMerged", detail: `#${badge.number} was merged` };
  if (badge.state === "CLOSED")
    return { reason: "prClosed", detail: `#${badge.number} was closed` };
  const disputed = Object.entries(state.disagreements).find(
    ([, rounds]) => rounds >= DISAGREEMENT_ROUNDS,
  );
  if (disputed !== undefined) {
    return {
      reason: "disagreement",
      detail: `Review thread ${disputed[0]} stayed open after ${disputed[1]} declined rounds`,
    };
  }
  // A badge that didn't read the reviews can't say the head isn't approved.
  if (
    state.rounds >= state.budget.rounds &&
    badge.reviewUnread !== true &&
    badge.review?.verdictOnHead !== "approved"
  ) {
    return { reason: "rounds", detail: `${state.rounds} review rounds without approval on head` };
  }
  return undefined;
};

export interface FailingCheck {
  readonly name: string;
  /** The Actions run behind the check, when its link names one. */
  readonly runId?: string;
}

export const failingCheck = (name: string, link: string): FailingCheck => {
  const runId = actionsRunId(link);
  return runId === undefined ? { name } : { name, runId };
};

export interface CheckDecision {
  readonly state: BabysitState;
  /** Checks to rerun once as possible flakes. */
  readonly rerun: ReadonlyArray<{ readonly name: string; readonly runId: string }>;
  /** Checks the agent should look at. */
  readonly real: ReadonlyArray<string>;
  readonly stop?: Halt;
}

/**
 * A check's first failure gets one rerun as a possible flake. Failing again makes it real, for the
 * agent to fix; failing once more on a later head is "the same check failing twice", which stops.
 */
export const checkDecision = (
  state: BabysitState,
  failing: ReadonlyArray<FailingCheck>,
  head: string,
): CheckDecision => {
  const rerunChecks = { ...state.rerunChecks };
  const failedChecks = { ...state.failedChecks };
  const rerun: Array<{ name: string; runId: string }> = [];
  const real: Array<string> = [];
  let stop: Halt | undefined;
  for (const check of failing) {
    const failedOn = failedChecks[check.name];
    if (failedOn !== undefined && failedOn !== head) {
      stop ??= {
        reason: "checkFailedTwice",
        detail: `${check.name} failed on ${short(failedOn)} and again on ${short(head)}`,
      };
      real.push(check.name);
    } else if (rerunChecks[check.name] === undefined && check.runId !== undefined) {
      rerunChecks[check.name] = head;
      rerun.push({ name: check.name, runId: check.runId });
    } else {
      failedChecks[check.name] = head;
      real.push(check.name);
    }
  }
  return {
    state: { ...state, rerunChecks, failedChecks },
    rerun,
    real,
    ...(stop === undefined ? {} : { stop }),
  };
};

export const buildReport = (
  state: BabysitState,
  badge: PrStatus,
  review: PrReview | undefined,
): BabysitReport => {
  const byId = new Map((review?.threads ?? []).map((t) => [t.id, t]));
  return {
    number: badge.number,
    url: badge.url,
    headRefOid: badge.headRefOid ?? "",
    ...(badge.review?.verdictOnHead === undefined ? {} : { verdict: badge.review.verdictOnHead }),
    checks: requiredChecksOf(badge),
    mergeState: badge.mergeState ?? "",
    rounds: state.rounds,
    handled: state.handled.length,
    declined: state.declined.flatMap((id) => {
      const thread = byId.get(id);
      return thread === undefined ? [] : [findingOf(thread)];
    }),
    merged: false,
  };
};

/** The message that starts the loop once the user turns babysitting on. */
export const kickoffText = (number: number, rounds: number): string =>
  [
    `Babysit mode is on for #${number}. After each bot round or CI settle, Gram sends one review update into this thread, mid-turn when it can.`,
    "For each update: fix the findings that hold up, in one push per round, then answer each thread with pr_reply_to_thread: " +
      '"Fixed in <sha>: …" once the fix is pushed (that resolves the thread), or the concrete reason when you decline.',
    "When a finding needs the user's judgement (a product or design decision, a trade-off, work beyond this PR, or a disagreement with the bot that matters), don't guess and don't decline on their behalf: " +
      "leave that thread unanswered, finish the rest, and end your turn by asking the user, naming the thread and the options you see.",
    "Gram reruns a failing check once as a possible flake and requests a re-review when the bot stays quiet. Never merge, enable auto-merge, approve, or force-push.",
    "A bot review already on the PR comes as round 0: work through it the same way, but it doesn't count toward the round limit.",
    `It stops and hands the PR back after ${rounds} new bot rounds, two declined rounds on one thread, the same check failing twice, or when the PR closes.`,
  ].join("\n");
