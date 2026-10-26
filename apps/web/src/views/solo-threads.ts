import type { ThreadSummary } from "@gram/contracts";

import { splitForTree } from "@/sidebar/grouping";

const latestFirst = (a: ThreadSummary, b: ThreadSummary) =>
  b.thread.lastActivityAt - a.thread.lastActivityAt;

/**
 * The threads outside any workspace, as the overview lists them: the listed threads beside the
 * workspaces' own, less parked ones, latest first.
 */
export const soloThreads = (
  summaries: Iterable<ThreadSummary>,
  workspaceIds: ReadonlySet<string>,
): ThreadSummary[] =>
  splitForTree(summaries, workspaceIds)
    .listed.filter((summary) => !summary.thread.parked)
    .toSorted(latestFirst);

/** The parked threads outside any workspace, latest first: the overview's folded Parked line. */
export const parkedSoloThreads = (
  summaries: Iterable<ThreadSummary>,
  workspaceIds: ReadonlySet<string>,
): ThreadSummary[] =>
  splitForTree(summaries, workspaceIds)
    .listed.filter((summary) => summary.thread.parked)
    .toSorted(latestFirst);
