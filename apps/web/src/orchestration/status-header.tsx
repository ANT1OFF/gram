import type { DeliveredDigest, Thread } from "@gram/contracts";

import { SinceYouLeft } from "./since-you-left";

/**
 * What sits over the orchestrator's chat: only what nothing else says. The running, review and
 * merged counts are the sidebar's and the Board's, and Show all activity is a view option in the
 * thread's "…", so the line holds "Since you left" while there is an absence to sum up (one fold,
 * its Dismiss inside) and is gone, band and all, when there isn't. The "New" line is the
 * transcript's own, over the first message you haven't seen; what needs you is the sidebar's pill.
 */
export function StatusHeader({
  thread,
  digests,
}: {
  thread: Thread;
  /** The digests the orchestrator was given, which "Since you left" folds; none before they load. */
  digests?: readonly DeliveredDigest[] | undefined;
}) {
  if (thread.role !== "orchestrator" || thread.workspaceId === undefined) return null;
  if (digests === undefined) return null;
  return <SinceYouLeft key={`since-you-left:${thread.id}`} thread={thread} digests={digests} />;
}
