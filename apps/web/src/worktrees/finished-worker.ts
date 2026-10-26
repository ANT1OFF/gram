import type { ThreadStatus, ThreadSummary } from "@gram/contracts";

import { activityLine } from "@/sidebar/status";
import { threadRoleOf } from "@/thread/orchestration-model";

/** Why a worker's worktree can go with it: the worker is archived, or its PR merged. */
export type FinishedWorker = "archived" | "merged";

/** Statuses of a thread that isn't doing anything and won't until someone writes to it. */
const AT_REST: ReadonlySet<ThreadStatus> = new Set<ThreadStatus>(["cold", "idle", "ended"]);

/**
 * Whether the thread is a worker whose work is over, as the orchestration ledger's first two rules
 * read it: parked (archived), else its PR merged. `undefined` for any other thread, for a worker
 * that is doing something or waits on the user, and for one spanning repos, whose worktrees in
 * the other repos closing it would take too. An idle worker still counts as doing something while
 * a background task, a terminal program or a subagent runs: closing it would stop them. `detail` is
 * the live status line (`statusDetail`), which is what says a subagent runs between turns.
 */
export const finishedWorker = (
  summary: ThreadSummary | undefined,
  detail: string | undefined,
): FinishedWorker | undefined => {
  if (summary === undefined) return undefined;
  const { thread } = summary;
  if (threadRoleOf(thread)?.kind !== "worker") return undefined;
  if (!AT_REST.has(summary.status) || summary.pendingRequests.length > 0) return undefined;
  if ((summary.background?.length ?? 0) > 0 || (summary.terminalProcesses?.length ?? 0) > 0) {
    return undefined;
  }
  // Between turns the server sends an activity line only while a background subagent works.
  if (activityLine(summary.status, detail, summary.activity) !== undefined) return undefined;
  if ((thread.extraCheckouts?.length ?? 0) > 0) return undefined;
  if (thread.parked) return "archived";
  if (summary.git?.pr?.state === "MERGED" || thread.completedReason === "prMerged") return "merged";
  return undefined;
};
