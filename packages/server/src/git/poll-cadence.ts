import type { PrStatus } from "@gram/contracts";
import { offScreenWatchSweeps } from "../github/poll-backoff.ts";
import type { ActivityLevel } from "./activity.ts";

/**
 * How closely a thread is being looked at. `focused`: it is the focused pane of the window the user
 * is in. `shown`: a pane shows it. `listed`: only its sidebar row is on screen. `hidden`: every
 * sidebar is collapsed and no pane shows it, so none of its chips can be seen.
 */
export type Attention = "focused" | "shown" | "listed" | "hidden";

const RANK: Record<Attention, number> = { focused: 3, shown: 2, listed: 1, hidden: 0 };

/** The closest of several threads' attention: a checkout is as watched as its most-watched thread. */
export const closestAttention = (each: ReadonlyArray<Attention>): Attention =>
  each.reduce<Attention>((best, next) => (RANK[next] > RANK[best] ? next : best), "hidden");

export interface LookupCadenceInput {
  readonly attention: Attention;
  /** A monitor, review monitor or babysit is on: an agent is waiting on a notification. */
  readonly watched: boolean;
  /** Since the user last focused one of its threads, or one last saw activity. */
  readonly idleMs: number;
  /** Something just happened that GitHub is about to react to: a push, a rerun, a re-review. */
  readonly burst: boolean;
  /**
   * A PR one of its threads follows besides the branch's (bound elsewhere, followed, or its branch's
   * while bound to another) is open or not looked up yet: its merge is what the thread waits on.
   */
  readonly followsOpen?: boolean | undefined;
  /** The branch's PR as last seen, and the checkout's HEAD. */
  readonly pr?: Pick<PrStatus, "state" | "checks" | "headRefOid" | "review"> | undefined;
  readonly head?: string | undefined;
  readonly level: ActivityLevel;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const byIdle = (idleMs: number): number => {
  if (idleMs < 10 * MINUTE) return 1;
  if (idleMs < HOUR) return 2;
  if (idleMs < 6 * HOUR) return 4;
  if (idleMs < 24 * HOUR) return 12;
  return 40;
};

const CLOSED_EVERY = 20;
const WATCHED_AT_MOST = 4;

/**
 * Sweeps from one GitHub lookup of a checkout to the next: 1 is every sweep, `Infinity` never.
 *
 * A PR merged at the checkout's own HEAD is never asked about again: nothing GitHub can say about it
 * changes what the badge shows, and a commit on top moves HEAD and ends that. Unless another PR its
 * threads follow is still open (`followsOpen`), which only these lookups would see merge.
 */
export const lookupEvery = (input: LookupCadenceInput): number => {
  if (input.burst) return 1;
  const { pr, head } = input;
  const onHead = pr !== undefined && head !== undefined && head !== "" && pr.headRefOid === head;
  if (pr?.state === "MERGED" && onHead && input.followsOpen !== true) {
    return Number.POSITIVE_INFINITY;
  }
  if (input.attention === "hidden") {
    return input.watched ? offScreenWatchSweeps(input.level) : Number.POSITIVE_INFINITY;
  }
  const expecting =
    pr?.state === "OPEN" && (pr.checks === "pending" || pr.review?.roundInFlight === true);
  const idle = byIdle(input.idleMs);
  let every = input.attention === "focused" || expecting ? 1 : idle;
  if (input.attention === "shown") every = Math.min(every, 4);
  if (pr?.state === "CLOSED") every = Math.max(every, CLOSED_EVERY);
  return input.watched ? Math.min(every, WATCHED_AT_MOST) : every;
};
