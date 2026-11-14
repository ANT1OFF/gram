import type { WorkerLedgerEntry, WorkerPr } from "./orchestration.ts";

/** Facts that establish who will act on a failing check, independent of presentation. */
export type CiFixWorker = Pick<WorkerLedgerEntry, "state" | "status">;

/**
 * A live worker owns its PR's failing checks, whatever it is doing now: running, at rest, waiting
 * on an approval, a question or a usage limit, stopped on an error, blocked, held by the user, or
 * briefed and not yet started. It is notified of its checks and fixes them; when it can't, its own
 * ask, report or error is what reaches the user, never the check. Only an archived worker or a
 * closed thread (`ended`) owns nothing: such a PR is its orchestrator's to follow up, in its digest.
 */
export const workerOwnsCiFix = (worker: CiFixWorker | undefined, pr: WorkerPr): boolean =>
  pr.state !== "merged" &&
  pr.state !== "closed" &&
  worker !== undefined &&
  worker.state !== "archived" &&
  worker.status !== "ended";

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

/** One live owner is enough when several workers follow the same PR. */
export const ciFixOwnedPrs = (workers: Iterable<WorkerLedgerEntry>): ReadonlySet<string> =>
  new Set(
    [...workers].flatMap((worker) =>
      ledgerPrsOf(worker)
        .filter((pr) => workerOwnsCiFix(worker, pr))
        .map(ciFixPrKey),
    ),
  );
