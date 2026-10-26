import type { WorkerLedgerEntry, WorkerPr } from "./orchestration.ts";

/** Facts that establish who will act on a failing check, independent of presentation. */
export type CiFixWorker = Pick<WorkerLedgerEntry, "state" | "status" | "pendingRequests"> &
  Partial<Pick<WorkerLedgerEntry, "quiet" | "reportStands" | "userIntervened" | "wakes">>;

/** An unreported stop or stalled tool is the ledger's existing escalation bound. */
export const workerOwnsCiFix = (worker: CiFixWorker | undefined, pr: WorkerPr): boolean => {
  if (
    pr.state === "merged" ||
    pr.state === "closed" ||
    worker === undefined ||
    worker.state === "archived" ||
    worker.state === "error" ||
    worker.status === "error" ||
    worker.status === "ended" ||
    worker.state === "blocked" ||
    worker.state === "question" ||
    worker.reportStands === true ||
    worker.userIntervened ||
    worker.pendingRequests.length > 0 ||
    worker.status === "needsInput" ||
    worker.status === "needsApproval"
  )
    return false;
  const working = worker.status === "running" || worker.status === "starting";
  if (worker.quiet?.kind === "toolStalled" || (!working && worker.quiet?.kind === "turnEnded"))
    return false;
  return (
    working ||
    pr.monitored === true ||
    pr.mergeWhenReady !== undefined ||
    (worker.wakes?.length ?? 0) > 0
  );
};

export const ciFixPrKey = (pr: Pick<WorkerPr, "repo" | "number">): string =>
  `${pr.repo.toLowerCase()}#${pr.number}`;

/** Every PR a worker follows, including further PRs in extra repositories. */
export const ledgerPrsOf = (
  worker: Pick<WorkerLedgerEntry, "pr" | "morePrs" | "alsoIn">,
): ReadonlyArray<WorkerPr> =>
  [
    worker.pr,
    ...(worker.morePrs ?? []),
    ...(worker.alsoIn ?? []).flatMap((repo) => [repo.pr, ...(repo.morePrs ?? [])]),
  ].filter((pr) => pr !== undefined);

/** One active owner is enough when several workers follow the same PR. */
export const ciFixOwnedPrs = (workers: Iterable<WorkerLedgerEntry>): ReadonlySet<string> =>
  new Set(
    [...workers].flatMap((worker) =>
      ledgerPrsOf(worker)
        .filter((pr) => workerOwnsCiFix(worker, pr))
        .map(ciFixPrKey),
    ),
  );
