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
  it("requires a live owner with an active follow-up", () => {
    expect(workerOwnsCiFix(undefined, pr)).toBe(false);
    expect(workerOwnsCiFix(worker, { repo: pr.repo, number: pr.number })).toBe(false);
    expect(workerOwnsCiFix(worker, pr)).toBe(true);
    expect(workerOwnsCiFix(worker, { ...pr, mergeWhenReady: {} })).toBe(true);
    expect(
      workerOwnsCiFix({ ...worker, status: "running" }, { repo: pr.repo, number: pr.number }),
    ).toBe(true);
    expect(
      workerOwnsCiFix(
        { ...worker, wakes: [{ id: "wake", at: 1, note: "Fix CI" }] },
        { repo: pr.repo, number: pr.number },
      ),
    ).toBe(true);
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
    { quiet: { kind: "turnEnded", at: 1 } },
    { quiet: { kind: "toolStalled", at: 1 } },
  ] satisfies Partial<CiFixWorker>[])("escalates a failed follow-up: %j", (over) => {
    expect(workerOwnsCiFix({ ...worker, ...over }, pr)).toBe(false);
  });

  it("clears a previous unreported stop when another turn starts, but keeps stalled tools actionable", () => {
    expect(
      workerOwnsCiFix({ ...worker, status: "running", quiet: { kind: "turnEnded", at: 1 } }, pr),
    ).toBe(true);
    expect(
      workerOwnsCiFix({ ...worker, status: "running", quiet: { kind: "toolStalled", at: 1 } }, pr),
    ).toBe(false);
  });
});
