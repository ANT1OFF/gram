/*
 * A thread's cost, added up across its agent sessions. An agent counts from zero: Claude's
 * `total_cost_usd` covers one agent process, so every resume (an app restart, an eviction, a model
 * switch) would otherwise start the thread's ticker over.
 */

export interface CostLedger {
  /** The thread's cost as far as agents have priced it; `undefined` until one has. */
  settled: number | undefined;
  /** `settled` when the live session's counter last stood at zero. */
  base: number;
  /** The live session's latest priced total. */
  session: number;
}

/** A ledger that carries on from `settled`, the cost the thread's last turn was saved with. */
export const makeCostLedger = (settled: number | undefined): CostLedger => ({
  settled,
  base: settled ?? 0,
  session: 0,
});

/** A new agent session: its counter starts at zero, on top of everything settled so far. */
export const openCostSession = (ledger: CostLedger): void => {
  ledger.base = ledger.settled ?? 0;
  ledger.session = 0;
};

/**
 * Books a usage report's session cost and returns what the thread has cost. An estimate moves
 * nothing, so a guess never becomes part of the total; it shows on top of the session's base, and
 * never below what is already settled. No cost at all shows the settled figure.
 */
export const bookCost = (
  ledger: CostLedger,
  report: { readonly costUsd?: number | undefined; readonly costEstimated?: boolean | undefined },
): { readonly costUsd?: number; readonly costEstimated?: true } => {
  const { costUsd } = report;
  if (costUsd === undefined) return ledger.settled === undefined ? {} : { costUsd: ledger.settled };
  if (report.costEstimated === true) {
    return { costUsd: Math.max(ledger.settled ?? 0, ledger.base + costUsd), costEstimated: true };
  }
  // A counter that went backwards was restarted under us: `/clear` does it, and a crash result
  // carries zeroes. What it had counted is already settled, so count on from there.
  if (costUsd < ledger.session) ledger.base = ledger.settled ?? 0;
  ledger.session = costUsd;
  ledger.settled = ledger.base + costUsd;
  return { costUsd: ledger.settled };
};

/**
 * A turn that ended on an estimate (its session died before pricing it) is never getting a better
 * figure, so the guess becomes the thread's cost. A session that does price it later still wins:
 * its reports are booked from `base`, not from here.
 */
export const settleEstimate = (ledger: CostLedger, costUsd: number): void => {
  ledger.settled = Math.max(ledger.settled ?? 0, costUsd);
};
