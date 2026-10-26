import * as Schema from "effect/Schema";
import { Thread } from "./domain.ts";
import { ThreadId } from "./ids.ts";

// Reopening closed threads: the server keeps the last closed threads across restarts.

/** How many closed threads the server keeps. */
export const CLOSED_THREADS_LIMIT = 20;

/** A closed thread as it was when closed, with what stands in the way of bringing it back. */
export const ClosedThread = Schema.Struct({
  thread: Thread,
  /** Epoch ms. */
  closedAt: Schema.Number,
  /**
   * `folderMissing`: its folder or worktree has been deleted since. `sessionOpen`: another thread
   * already shows its agent session, `openThreadId`.
   */
  problem: Schema.optionalKey(Schema.Literals(["folderMissing", "sessionOpen"])),
  openThreadId: Schema.optionalKey(ThreadId),
});
export type ClosedThread = typeof ClosedThread.Type;

/**
 * What came back of a reopened thread's place in its workspace. `restored`: its role, workspace and
 * link to its orchestrator, and for an orchestrator its slot and the workers it had. `slotTaken`:
 * an orchestrator whose workspace has another one now, so it is a plain thread there.
 * `orchestratorGone`: a worker whose orchestrator is closed or replaced, so it is in the workspace
 * with nobody to report to, as its orchestrator's close would have left it. `workspaceGone`: the
 * workspace was removed, so it is a plain thread. `notAdmitted`: its model or mode can no longer
 * take that part, so it is a plain thread in the workspace.
 */
export const ReopenedMembership = Schema.Literals([
  "restored",
  "slotTaken",
  "orchestratorGone",
  "workspaceGone",
  "notAdmitted",
]);
export type ReopenedMembership = typeof ReopenedMembership.Type;

/** What `threads.closed.reopen` did with the newest closed thread. */
export const ReopenedClosedThread = Schema.Struct({
  /** The entry taken off the list, marked as `threads.closed.list` would mark it. */
  closed: ClosedThread,
  /**
   * The thread, open again under its own id. Absent when `closed.problem` is `sessionOpen`: the
   * thread `closed.openThreadId` names shows that session, and the entry is dropped.
   */
  thread: Schema.optionalKey(Thread),
  /** For a thread that was an orchestrator or a worker: how much of that came back. */
  membership: Schema.optionalKey(ReopenedMembership),
});
export type ReopenedClosedThread = typeof ReopenedClosedThread.Type;
