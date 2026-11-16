import { describe, expect, it } from "vitest";
import { workerOwnsCiFix, type CiFixWorker } from "./ci-fix-ownership.ts";
import type { WorkerPr } from "./orchestration.ts";

const worker: CiFixWorker = { state: "inReview", status: "idle" };
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
  });

  it("is nobody's once the PR is merged or closed", () => {
    expect(workerOwnsCiFix(worker, { ...pr, state: "merged" })).toBe(false);
    expect(workerOwnsCiFix(worker, { ...pr, state: "closed" })).toBe(false);
  });

  // A live worker is told of its checks and fixes them; when it can't, its own ask, report or
  // error is what reaches the user, never the check.
  it.each([
    { status: "running" },
    { status: "cold" },
    { state: "briefed", status: "cold" },
    { status: "needsApproval" },
    { state: "blocked" },
    { state: "error", status: "error" },
    { state: "done" },
  ] satisfies Partial<CiFixWorker>[])("stays with a live worker: %j", (over) => {
    expect(workerOwnsCiFix({ ...worker, ...over }, pr)).toBe(true);
  });

  it.each([{ state: "archived" }, { status: "ended" }] satisfies Partial<CiFixWorker>[])(
    "has no owner once the worker is gone: %j",
    (over) => {
      expect(workerOwnsCiFix({ ...worker, ...over }, pr)).toBe(false);
    },
  );
});
