import type { ThreadSummary } from "@gram/contracts";

import { sectionOf, splitForTree } from "@/sidebar/grouping";

const latestFirst = (a: ThreadSummary, b: ThreadSummary) =>
  b.thread.lastActivityAt - a.thread.lastActivityAt;

/**
 * Done: marked completed, by the user, its agent or a merge, with nothing at work or waiting on the
 * user, either of which brings it back to the list. A pinned or parked one stays where its flag puts
 * it.
 */
export const soloDone = (summary: ThreadSummary): boolean =>
  summary.thread.completedAt !== undefined && sectionOf(summary) === "settled";

/**
 * The threads outside any workspace, as the overview lists them: the listed threads beside the
 * workspaces' own, less parked and done ones, latest first.
 */
export const soloThreads = (
  summaries: Iterable<ThreadSummary>,
  workspaceIds: ReadonlySet<string>,
): ThreadSummary[] =>
  splitForTree(summaries, workspaceIds)
    .listed.filter((summary) => !summary.thread.parked && !soloDone(summary))
    .toSorted(latestFirst);

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
    .listed.filter((summary) => !summary.thread.parked && soloDone(summary))
    .toSorted(latestFirst);
