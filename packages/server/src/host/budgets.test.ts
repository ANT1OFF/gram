// Each caller's deadline is longer than the step it waits on (`budgets.ts`): broken, a caller
// gives up on a step that goes on where no one sees it, or asks for it again on top of itself.

import { describe, expect, it } from "vitest";
import {
  HOST_RESTORE_MS,
  HOST_STOP_MS,
  JOB_KEPT_MS,
  JOB_WAIT_MAX_MS,
  PREPARE_JOB_MS,
  REOPEN_MS,
  RESUME_JOB_MS,
  RESUME_STALL_MS,
  SHARED_FLUSH_MS,
  STOP_CANCEL_MS,
} from "./budgets.ts";

describe("the budgets of a machine's long steps", () => {
  it("nest: whoever waits on a step waits longer than it may take", () => {
    // A resume job goes without progress for no longer than one folder's restore or its reopen.
    expect(RESUME_JOB_MS).toBeGreaterThan(HOST_RESTORE_MS);
    expect(RESUME_JOB_MS).toBeGreaterThan(REOPEN_MS);
    // Sessions waiting on a resume give up only after the job would have ended by itself.
    expect(RESUME_STALL_MS).toBeGreaterThan(RESUME_JOB_MS);
    // A prepare job covers the host's prepare, the shared folders' flush and a take-back.
    expect(PREPARE_JOB_MS).toBeGreaterThan(HOST_STOP_MS + SHARED_FLUSH_MS + STOP_CANCEL_MS);
    // An ended job is kept for longer than a retry that follows it takes to come.
    expect(JOB_KEPT_MS).toBeGreaterThan(JOB_WAIT_MAX_MS);
    // A poll that waits stays well inside an ordinary call's deadline.
    expect(JOB_WAIT_MAX_MS).toBeLessThanOrEqual(25_000);
  });
});
