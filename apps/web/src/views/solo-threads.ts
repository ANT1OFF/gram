import { mergedAndDone, threadPrBadges, type ThreadSummary } from "@gram/contracts";

import { sectionOf, splitForTree } from "@/sidebar/grouping";

const DAY_MS = 86_400_000;

/**
 * When a solo thread at rest settles into History on its own: a merged PR with nothing left open,
 * or `days` without activity (Settings → General, `settleAfterDaysOf`; 0 never settles an idle
 * one). `now` is the reader's clock, so a test pins it.
 */
export interface SettleRule {
  readonly now: number;
  readonly days: number;
}

/**
 * Settled on its own (`SettleRule`): at rest with nothing waiting on the user, and neither pinned,
 * parked, unread nor already marked done, which have their own places. Its PR merged with nothing
 * left open, or it has sat idle the rule's days. New activity brings it back.
 */
export const autoSettled = (summary: ThreadSummary, rule: SettleRule | undefined): boolean => {
  if (rule === undefined) return false;
  const { thread } = summary;
  if (
    thread.pinned ||
    thread.parked ||
    thread.unread ||
    thread.snoozedUntil !== undefined ||
    thread.completedAt !== undefined
  ) {
    return false;
  }
  if (summary.status !== "idle" && summary.status !== "cold" && summary.status !== "ended") {
    return false;
  }
  const section = sectionOf(summary);
  if (section !== "idle" && section !== "settled") return false;
  if (mergedAndDone(thread, threadPrBadges(thread, summary.git))) return true;
  return rule.days > 0 && rule.now - thread.lastActivityAt >= rule.days * DAY_MS;
};

/** Over, either way: marked done (`soloDone`) or settled on its own (`autoSettled`). */
export const soloOver = (summary: ThreadSummary, rule: SettleRule | undefined): boolean =>
  soloDone(summary) || autoSettled(summary, rule);

const latestFirst = (a: ThreadSummary, b: ThreadSummary) =>
  b.thread.lastActivityAt - a.thread.lastActivityAt;

/**
 * Done: marked completed, by the user, its agent or a merge, with nothing at work or waiting on the
 * user, either of which brings it back to the list. A pinned or parked one stays where its flag puts
 * it.
 */
export const soloDone = (summary: ThreadSummary): boolean =>
  summary.thread.completedAt !== undefined && sectionOf(summary) === "settled";

/** Asks you something now: an approval or an answer, the rows that say so in amber. */
const asks = (summary: ThreadSummary): boolean =>
  summary.status === "needsApproval" ||
  summary.status === "needsInput" ||
  summary.pendingRequests.length > 0;

/** Those that ask you first, so a long list never scrolls them away; then latest first. */
const needsYouFirst = (a: ThreadSummary, b: ThreadSummary) =>
  Number(asks(b)) - Number(asks(a)) || latestFirst(a, b);

/** Snoozed and not archived: out of the list until its snooze ends. */
const snoozedOnly = (summary: ThreadSummary): boolean =>
  summary.thread.snoozedUntil !== undefined && !summary.thread.parked;

/**
 * The threads outside any workspace, as the overview lists them: the listed threads beside the
 * workspaces' own, less parked, snoozed, done and settled ones (`soloOver` under `rule`), those that
 * ask you something first, then latest first.
 */
export const soloThreads = (
  summaries: Iterable<ThreadSummary>,
  workspaceIds: ReadonlySet<string>,
  rule?: SettleRule,
): ThreadSummary[] =>
  splitForTree(summaries, workspaceIds)
    .listed.filter(
      (summary) => !summary.thread.parked && !snoozedOnly(summary) && !soloOver(summary, rule),
    )
    .toSorted(needsYouFirst);

/** The snoozed threads outside any workspace, soonest back first: the overview's folded line. */
export const snoozedSoloThreads = (
  summaries: Iterable<ThreadSummary>,
  workspaceIds: ReadonlySet<string>,
): ThreadSummary[] =>
  splitForTree(summaries, workspaceIds)
    .listed.filter(snoozedOnly)
    .toSorted((a, b) => (a.thread.snoozedUntil ?? 0) - (b.thread.snoozedUntil ?? 0));

/** The parked threads outside any workspace, latest first: the overview's folded Parked line. */
export const parkedSoloThreads = (
  summaries: Iterable<ThreadSummary>,
  workspaceIds: ReadonlySet<string>,
): ThreadSummary[] =>
  splitForTree(summaries, workspaceIds)
    .listed.filter((summary) => summary.thread.parked)
    .toSorted(latestFirst);

/** The done threads outside any workspace, latest first: the overview's folded Done line. */
export const doneSoloThreads = (
  summaries: Iterable<ThreadSummary>,
  workspaceIds: ReadonlySet<string>,
): ThreadSummary[] =>
  splitForTree(summaries, workspaceIds)
    .listed.filter(
      (summary) => !summary.thread.parked && !snoozedOnly(summary) && soloDone(summary),
    )
    .toSorted(latestFirst);

/**
 * Whether History is a thread's home now, not the live lists: archived, marked done, or, for a
 * one-off thread, settled on its own (`autoSettled`). The palette hands such threads to History
 * rather than list them beside the live ones.
 */
export const inHistory = (summary: ThreadSummary, rule: SettleRule | undefined): boolean =>
  summary.thread.parked ||
  soloDone(summary) ||
  (summary.thread.role === undefined &&
    summary.thread.spawnedBy === undefined &&
    autoSettled(summary, rule));
