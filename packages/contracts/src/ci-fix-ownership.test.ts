import { describe, expect, it } from "vitest";
import { workerOwnsCiFix, type CiFixWorker } from "./ci-fix-ownership.ts";
import type { WorkerPr } from "./orchestration.ts";

const worker: CiFixWorker = { state: "inReview", status: "idle", pendingRequests: [] };
const pr: WorkerPr = {
  repo: "example/api",
  number: 212,
  state: "open",
  checks: "failing",
  monitored: true,
};

describe("CI fix ownership", () => {
  it("is the worker's while it runs or can be woken, monitored or not", () => {
    const bare: WorkerPr = { repo: pr.repo, number: pr.number, state: "open", checks: "failing" };
    expect(workerOwnsCiFix(undefined, pr)).toBe(false);
    expect(workerOwnsCiFix(worker, pr)).toBe(true);
    expect(workerOwnsCiFix(worker, bare)).toBe(true);
    expect(workerOwnsCiFix({ ...worker, status: "cold" }, bare)).toBe(true);
    expect(workerOwnsCiFix({ ...worker, status: "running" }, bare)).toBe(true);
    expect(workerOwnsCiFix(worker, { ...bare, mergeWhenReady: {} })).toBe(true);
    // A turn that ended without a report is its orchestrator's to follow up, not the user's.
    expect(workerOwnsCiFix({ ...worker, quiet: { kind: "turnEnded", at: 1 } }, bare)).toBe(true);
  });

  it("is nobody's once the PR is merged or closed", () => {
    expect(workerOwnsCiFix(worker, { ...pr, state: "merged" })).toBe(false);
    expect(workerOwnsCiFix(worker, { ...pr, state: "closed" })).toBe(false);
  });

  it.each([
    { state: "error" },
    { state: "archived" },
    { status: "ended" },
    { status: "error" },
    { state: "blocked" },
    { state: "question" },
    { reportStands: true },
    { userIntervened: true },
    { status: "needsApproval" },
    { status: "needsInput" },
    { pendingRequests: [{ kind: "approval", ageMin: 0 }] },
    { quiet: { kind: "toolStalled", at: 1 } },
  ] satisfies Partial<CiFixWorker>[])("escalates a failed follow-up: %j", (over) => {
    expect(workerOwnsCiFix({ ...worker, ...over }, pr)).toBe(false);
  });

  it("keeps a stalled tool the user's, running or not", () => {
    expect(
      workerOwnsCiFix({ ...worker, status: "running", quiet: { kind: "toolStalled", at: 1 } }, pr),
    ).toBe(false);
  });
});
