import { describe, expect, it } from "vitest";
import type { PrFacts } from "../completion.ts";
import type { TurnId } from "../ids.ts";
import { WorkerState as WorkerStateSchema, type WorkerState } from "../orchestration.ts";
import { ThreadStatus } from "../thread-status.ts";
import {
  featureState,
  liveWorkerState,
  WORKER_STATE_ORDER,
  workerState,
  workerStateBase,
  type WorkerLive,
  type WorkerStateInput,
} from "./worker-state.ts";

const pr = (over: Partial<PrFacts>): PrFacts => ({
  state: "open",
  checksGreen: false,
  approvedOnHead: false,
  mergeable: false,
  ...over,
});

const failed = "turn-1" as TurnId;

/** Every worker fact the rule reads, but its status and requests, in each value that tells. */
const factCombinations = (): ReadonlyArray<Omit<WorkerStateInput, keyof WorkerLive>> => {
  const prs = [
    undefined,
    pr({}),
    pr({ checksGreen: true, approvedOnHead: true, mergeable: true }),
    pr({ state: "merged" }),
    pr({ state: "closed" }),
  ];
  const reports = [
    {},
    { lastReport: { state: "blocked" as const, at: 2_000 } },
    { lastReport: { state: "question" as const, at: 2_000 } },
    { lastReport: { state: "done" as const, at: 2_000 } },
    { lastReport: { state: "progress" as const, at: 2_000 } },
    { lastReport: { state: "done" as const, at: 2_000 }, lastInputAt: 3_000 },
  ];
  const failures = [
    {},
    { lastError: { at: 3_000, turnId: failed }, lastTurnId: failed },
    { lastError: { at: 3_000, turnId: failed }, lastTurnId: "turn-2" as TurnId },
  ];
  const all: Array<Omit<WorkerStateInput, keyof WorkerLive>> = [];
  for (const parked of [false, true])
    for (const badge of prs)
      for (const report of reports)
        for (const completedReason of [undefined, "agent", "prMerged"] as const)
          for (const hasStartedTurn of [false, true])
            for (const failure of failures)
              for (const canOpenPr of [undefined, false])
                for (const reopened of badge?.state === "merged" ? [false, true] : [false])
                  all.push({
                    parked,
                    hasStartedTurn,
                    ...(badge === undefined ? {} : { pr: badge }),
                    ...report,
                    ...(completedReason === undefined ? {} : { completedReason }),
                    ...failure,
                    ...(canOpenPr === undefined ? {} : { canOpenPr }),
                    reopened,
                  });
  return all;
};

const lives: ReadonlyArray<WorkerLive> = ThreadStatus.literals.flatMap((status) => [
  { status, pendingRequestCount: 0 },
  { status, pendingRequestCount: 1 },
]);

/** A ledger row from before the base was carried, and a live status over it. */
const oldRow = (state: WorkerState) => ({ state, status: "idle" as const, pendingRequests: [] });
const liveAs = (status: ThreadStatus, pendingRequestCount = 0) => ({ status, pendingRequestCount });

describe("liveWorkerState", () => {
  // The board lays a newer status over a ledger row; the ledger, refetched, works the state out
  // from the same facts and that status. The two must land on the same state, whatever status the
  // row was surveyed under.
  it("agrees with the ledger's rule for every fact, surveyed status and live status", () => {
    const mismatches: string[] = [];
    for (const facts of factCombinations()) {
      for (const surveyed of lives) {
        const input = { ...facts, ...surveyed };
        const row = {
          state: workerState(input),
          stateBase: workerStateBase(input),
          status: surveyed.status,
          pendingRequests: Array.from({ length: surveyed.pendingRequestCount }, () => ({
            kind: "approval",
            ageMin: 0,
          })),
        };
        if (liveWorkerState(row) !== row.state) {
          mismatches.push(`own ${JSON.stringify(input)}`);
        }
        for (const live of lives) {
          const board = liveWorkerState(row, live);
          const ledger = workerState({ ...facts, ...live });
          if (board !== ledger) {
            mismatches.push(`${JSON.stringify({ input, live })}: ${board} vs ${ledger}`);
          }
        }
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });

  it("lays a status over a row from a ledger that carries no base", () => {
    expect(liveWorkerState(oldRow("inReview"), liveAs("needsInput"))).toBe("needsUser");
    expect(liveWorkerState(oldRow("needsUser"), liveAs("running"))).toBe("working");
    expect(liveWorkerState(oldRow("error"), liveAs("running"))).toBe("working");
    expect(liveWorkerState(oldRow("error"), liveAs("cold"))).toBe("error");
    expect(liveWorkerState(oldRow("archived"), liveAs("error"))).toBe("archived");
    expect(liveWorkerState(oldRow("archived"), liveAs("running"))).toBe("working");
    expect(liveWorkerState(oldRow("archived"), liveAs("error", 1))).toBe("needsUser");
  });
});

describe("workerState for a parked worker", () => {
  const parked: WorkerStateInput = {
    status: "idle",
    parked: true,
    hasStartedTurn: true,
    pendingRequestCount: 0,
    pr: pr({ checksGreen: true, approvedOnHead: true, mergeable: true }),
  };

  it("is archived only at rest with nothing waiting on the user", () => {
    expect(workerState(parked)).toBe("archived");
    expect(workerState({ ...parked, status: "cold" })).toBe("archived");
    expect(workerState({ ...parked, status: "error" })).toBe("archived");
    expect(workerState({ ...parked, pendingRequestCount: 1 })).toBe("needsUser");
    expect(workerState({ ...parked, status: "error", pendingRequestCount: 1 })).toBe("needsUser");
    expect(workerState({ ...parked, status: "needsApproval" })).toBe("needsUser");
    // A turn it runs shows where it stands.
    expect(workerState({ ...parked, status: "running" })).toBe("readyToMerge");
    expect(workerState({ ...parked, status: "starting", pr: undefined })).toBe("working");
  });

  it("puts a merged worker's request in front of its merge", () => {
    const merged = { ...parked, parked: false, pr: pr({ state: "merged" }) };
    expect(workerState(merged)).toBe("merged");
    expect(workerState({ ...merged, status: "error" })).toBe("merged");
    expect(workerState({ ...merged, pendingRequestCount: 1 })).toBe("needsUser");
    expect(workerState({ ...merged, status: "needsInput" })).toBe("needsUser");
  });
});

describe("featureState", () => {
  it("orders every worker state exactly once", () => {
    expect(new Set(WORKER_STATE_ORDER).size).toBe(WorkerStateSchema.literals.length);
    expect(WORKER_STATE_ORDER).toHaveLength(WorkerStateSchema.literals.length);
  });

  it("puts a request waiting on the user before a report waiting on an answer", () => {
    expect(featureState(["blocked", "needsUser"])).toBe("needsUser");
    expect(featureState(["question", "needsUser", "working"])).toBe("needsUser");
    expect(featureState(["error", "needsUser"])).toBe("error");
  });

  it("leaves parked workers out while any sibling is live, and ranks an unknown state first", () => {
    expect(featureState(["archived", "working"])).toBe("working");
    expect(featureState(["archived"])).toBe("archived");
    expect(featureState(["merged", "shipped" as WorkerState])).toBe("shipped");
  });
});
