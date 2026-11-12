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
  return (
    // One quiet muted line with a hairline under it, so a message scrolled half out of view under
    // it reads as behind the line and not as printed over it. Hidden while empty (`empty:hidden`):
    // with no absence to sum up, or once it is dismissed, there is no band over the chat at all.
    <div
      data-testid="status-header"
      className="flex min-w-0 shrink-0 items-center border-b border-edge px-2 py-0.5 empty:hidden"
    >
      {digests !== undefined && (
        <SinceYouLeft key={`since-you-left:${thread.id}`} thread={thread} digests={digests} />
      )}
    </div>
  );
}
