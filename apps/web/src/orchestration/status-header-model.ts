import type { ThreadId } from "@gram/contracts";

import { startOfDay, type WorkerRow, type WorkersByTab } from "./workers-model";

// The orchestrator's status header: what is running, what waits on the user, what is in review and
// what merged today, in counts that come from the same rows as the views they open (⌘J's Now,
// Needs you, the Board and History), so the header and the view never disagree. No React.

/** A worker as the header names it: its title and its now line, for the hover. */
export interface HeaderWorker {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly now: string;
}

export interface StatusHeaderCounts {
  /** Workers whose turn runs now, in ⌘J's order. */
  readonly running: readonly HeaderWorker[];
  /** What waits on the user in this workspace: its Needs you items. */
  readonly waiting: number;
  /** Workers whose PR is in review (checks running or passed, a reviewer to come). */
  readonly inReview: readonly HeaderWorker[];
  /** Workers that merged since local midnight, latest first. */
  readonly mergedToday: readonly HeaderWorker[];
}

const named = (row: WorkerRow): HeaderWorker => ({
  threadId: row.threadId,
  title: row.title,
  now: row.now,
});

const rowsOf = (features: WorkersByTab[keyof WorkersByTab]) =>
  features.flatMap((feature) => feature.rows);

export const statusHeaderCounts = (
  tabs: WorkersByTab,
  waiting: number,
  now: number,
): StatusHeaderCounts => {
  const live = rowsOf(tabs.now);
  const today = startOfDay(now);
  // A feature that finished over two days is under both; a worker counts once.
  const seen = new Set<ThreadId>();
  const mergedToday = rowsOf(tabs.done).filter((row) => {
    if (row.glyph !== "merged" || (row.finishedAt ?? 0) < today || seen.has(row.threadId))
      return false;
    seen.add(row.threadId);
    return true;
  });
  return {
    running: live.filter((row) => row.activity === "working").map(named),
    waiting,
    inReview: live.filter((row) => row.state === "inReview").map(named),
    mergedToday: mergedToday.map(named),
  };
};
