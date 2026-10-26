import type { WorkerLedgerEntry, WorkerPr } from "./orchestration.ts";

/** Facts that establish who will act on a failing check, independent of presentation. */
export type CiFixWorker = Pick<WorkerLedgerEntry, "state" | "status" | "pendingRequests"> &
  Partial<Pick<WorkerLedgerEntry, "quiet" | "reportStands" | "userIntervened">>;

/**
 * A worker that can still act fixes its own failing checks: running, or at rest where its
 * orchestrator, a monitor or a wake can reach it. The user is the owner once it can't: archived,
 * stopped on an error or ended, blocked or asking, taken over by the user, or with a tool stalled.
 */
export const workerOwnsCiFix = (worker: CiFixWorker | undefined, pr: WorkerPr): boolean =>
  pr.state !== "merged" &&
  pr.state !== "closed" &&
  worker !== undefined &&
  worker.state !== "archived" &&
  worker.state !== "error" &&
  worker.status !== "error" &&
  worker.status !== "ended" &&
  worker.state !== "blocked" &&
  worker.state !== "question" &&
  worker.reportStands !== true &&
  worker.userIntervened !== true &&
  worker.pendingRequests.length === 0 &&
  worker.status !== "needsInput" &&
  worker.status !== "needsApproval" &&
  worker.quiet?.kind !== "toolStalled";

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
