import { describe, expect, it } from "vitest";
import { bookCost, makeCostLedger, openCostSession, settleEstimate } from "./cost-ledger.ts";

describe("cost ledger", () => {
  it("has nothing to show until an agent prices something", () => {
    expect(bookCost(makeCostLedger(undefined), {})).toEqual({});
  });

  it("follows one session's running total", () => {
    const ledger = makeCostLedger(undefined);
    expect(bookCost(ledger, { costUsd: 0.2 })).toEqual({ costUsd: 0.2 });
    expect(bookCost(ledger, { costUsd: 0.5 })).toEqual({ costUsd: 0.5 });
  });

  it("keeps showing the settled cost through reports that carry none", () => {
    const ledger = makeCostLedger(undefined);
    bookCost(ledger, { costUsd: 0.2 });
    expect(bookCost(ledger, {})).toEqual({ costUsd: 0.2 });
  });

  it("adds a resumed session, which counts from zero, to what the thread already cost", () => {
    const ledger = makeCostLedger(1.5);
    openCostSession(ledger);
    expect(bookCost(ledger, { costUsd: 0.25 })).toEqual({ costUsd: 1.75 });
    expect(bookCost(ledger, { costUsd: 0.75 })).toEqual({ costUsd: 2.25 });
    openCostSession(ledger);
    expect(bookCost(ledger, { costUsd: 0.25 })).toEqual({ costUsd: 2.5 });
  });

  it("counts on when a session's counter restarts under it", () => {
    const ledger = makeCostLedger(undefined);
    bookCost(ledger, { costUsd: 1 });
    // A crash result carries zeroes; `/clear` starts the counter over.
    expect(bookCost(ledger, { costUsd: 0 })).toEqual({ costUsd: 1 });
    expect(bookCost(ledger, { costUsd: 0.5 })).toEqual({ costUsd: 1.5 });
  });

  it("shows an estimate without booking it", () => {
    const ledger = makeCostLedger(1);
    openCostSession(ledger);
    expect(bookCost(ledger, { costUsd: 0.25, costEstimated: true })).toEqual({
      costUsd: 1.25,
      costEstimated: true,
    });
    // The turn came in cheaper than guessed: the priced figure replaces the guess.
    expect(bookCost(ledger, { costUsd: 0.125 })).toEqual({ costUsd: 1.125 });
  });

  it("never shows an estimate below what is settled", () => {
    const ledger = makeCostLedger(undefined);
    bookCost(ledger, { costUsd: 1 });
    bookCost(ledger, { costUsd: 0 });
    expect(bookCost(ledger, { costUsd: 0.25, costEstimated: true }).costUsd).toBe(1.25);
    const stale = makeCostLedger(2);
    expect(bookCost(stale, { costUsd: 0, costEstimated: true }).costUsd).toBe(2);
  });

  it("keeps the estimate of a turn its session never priced, unless that session still does", () => {
    const died = makeCostLedger(1);
    openCostSession(died);
    settleEstimate(died, 1.5);
    openCostSession(died);
    expect(bookCost(died, { costUsd: 0.25 })).toEqual({ costUsd: 1.75 });

    const alive = makeCostLedger(1);
    openCostSession(alive);
    settleEstimate(alive, 1.5);
    expect(bookCost(alive, { costUsd: 0.25 })).toEqual({ costUsd: 1.25 });
  });
});
