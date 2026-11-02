import type { FeatureCardWorker, ThreadId, WorkerState } from "@gram/contracts";

// Whether a worker shows: the one rule the overview sidebar's rows, its orchestrator line's count,
// the compact rail and the Board's lines all go by, so the sidebar and the Board list the same
// workers. Finished work lives in Done (⌘J's and the sidebar's), and Show finished brings it back
// on the Board. No React.

/** What the window knows beside a worker's card. */
export interface ShownFacts {
  /** Workers whose thread is at work now (`workingWorkerThreads`). */
  readonly running: ReadonlySet<ThreadId>;
  /** Workers with an ask waiting in the stack. */
  readonly asking: ReadonlySet<ThreadId>;
  /**
   * Every worker the workspace's ledger still has, and whether its work is over by Done's rule
   * (`ledgerWorkersOver`); undefined until the ledger is read. A worker closed with its worktree
   * has left the ledger, though its card keeps it as it last was.
   */
  readonly over: ReadonlyMap<ThreadId, boolean> | undefined;
}

/** States whose work is over: what decides before the ledger is read, and a worker at work again. */
export const OVER_STATES: ReadonlySet<WorkerState> = new Set<WorkerState>([
  "merged",
  "delivered",
  "done",
  "archived",
]);

/**
 * Whether a worker shows in the sidebar and on the Board:
 * - at work now, or asking you: always;
 * - archived: never, the user put it away;
 * - otherwise while the ledger has it and its work isn't over. Reported done, merged or delivered
 *   still shows while it has an open PR or something pending (a request, a standing report, a wake,
 *   a monitored run, the user holding it); done with nothing left, or gone from the ledger, it
 *   leaves both for Done.
 *
 * Before the ledger is read, its card's state decides: anything short of finished shows.
 */
export const workerShown = (
  worker: Pick<FeatureCardWorker, "threadId" | "state"> &
    Partial<Pick<FeatureCardWorker, "station">>,
  facts: ShownFacts,
): boolean => {
  if (facts.running.has(worker.threadId) || facts.asking.has(worker.threadId)) return true;
  if (worker.state === "archived") return false;
  if (facts.over === undefined) {
    return !OVER_STATES.has(worker.state) && worker.station !== "merged";
  }
  return facts.over.get(worker.threadId) === false;
};
