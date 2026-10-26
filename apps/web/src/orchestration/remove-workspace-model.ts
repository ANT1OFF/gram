import type { ThreadSummary, WorkspaceState } from "@gram/contracts";

/** The open threads removing a workspace touches: its orchestrator, its workers, its dream passes. */
export interface WorkspaceRemoval {
  readonly orchestrator?: ThreadSummary | undefined;
  /** What the current orchestrator spawned. */
  readonly workers: readonly ThreadSummary[];
  /** Dream and import passes, which run in the workspace without an orchestrator's say. */
  readonly passes: readonly ThreadSummary[];
}

/** What of `summaries` belongs to the workspace, as removing it would find it. */
export const workspaceRemoval = (
  state: WorkspaceState,
  summaries: Iterable<ThreadSummary>,
): WorkspaceRemoval => {
  const { id, orchestratorThreadId: holder } = state.workspace;
  const all = [...summaries];
  const orchestrator =
    holder === undefined ? undefined : all.find((summary) => summary.thread.id === holder);
  return {
    ...(orchestrator === undefined ? {} : { orchestrator }),
    workers:
      holder === undefined
        ? []
        : all.filter((summary) => summary.thread.spawnedBy?.threadId === holder),
    passes: all.filter(
      (summary) => summary.thread.workspaceId === id && summary.thread.role === "dream",
    ),
  };
};

/** "its worker", "its 3 workers": what the dialog offers to close as well; none without workers. */
export const workersText = ({ workers }: WorkspaceRemoval): string | undefined =>
  workers.length === 0
    ? undefined
    : workers.length === 1
      ? "its worker"
      : `its ${workers.length} workers`;

/**
 * What the removal dialog says will happen, one sentence each, as the server does it: closing the
 * orchestrator cuts its workers loose (they keep their worktrees), and removing the workspace deletes
 * its record, reports, dreams and history but leaves its memory folder on disk. A dream pass always
 * closes: with its dream deleted, what it writes has nowhere to be reviewed or adopted.
 */
export const removalLines = (
  removal: WorkspaceRemoval,
  closeWorkers: boolean,
): { readonly happens: readonly string[]; readonly kept: readonly string[] } => {
  const happens: string[] = [];
  if (removal.orchestrator !== undefined) {
    happens.push("The orchestrator stops and its thread closes.");
  }
  const workers = workersText(removal);
  if (workers !== undefined) {
    const one = removal.workers.length === 1;
    const them = `I${workers.slice(1)}`;
    happens.push(
      closeWorkers
        ? `${them} ${one ? "stops and closes" : "stop and close"}.`
        : `${them} ${one ? "stays open as an ordinary thread" : "stay open as ordinary threads"}, answering to no one.`,
    );
  }
  const passes = removal.passes.length;
  if (passes > 0) {
    happens.push(
      `${passes === 1 ? "Its dream pass stops and closes" : `Its ${passes} dream passes stop and close`}, since a dream can't be reviewed without its workspace.`,
    );
  }
  happens.push(
    "Its charter, stages, groups, worker reports, dreams and history are deleted. This can't be undone.",
  );
  const kept: string[] = [];
  if (removal.workers.some((worker) => worker.thread.checkout.kind === "worktree")) {
    kept.push(
      `The ${removal.workers.length === 1 ? "worker's" : "workers'"} worktrees and branches stay on disk, commits and all.`,
    );
  }
  kept.push(
    "Its memory, open questions included, stays in Gram's data folder, but a new workspace starts with an empty one.",
  );
  kept.push("Its repositories aren't touched.");
  return { happens, kept };
};
