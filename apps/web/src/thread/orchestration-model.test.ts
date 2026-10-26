import { WorkerReportState, WorkerState, type BudgetMeters, type ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  budgetLine,
  budgetSpent,
  changeText,
  diffStat,
  digestTitle,
  formatBytes,
  handoffLabel,
  lineDiff,
  pauseClock,
  pauseConfirmText,
  pauseLeavesRunning,
  workerPauseHint,
  pauseText,
  prLabel,
  roleDescription,
  roleLabel,
  safeLink,
  known,
  presentReportState,
  presentState,
  threadRoleOf,
  workerFlags,
} from "./orchestration-model";

const budget: BudgetMeters = {
  liveWorkers: 1,
  maxConcurrentWorkers: 4,
  costUsdToday: 1.2,
};

describe("threadRoleOf", () => {
  it("is nothing for a plain thread", () => {
    expect(threadRoleOf({})).toBeUndefined();
  });

  it("names an orchestrator, a worker by its feature, and lets a role outrank a lineage", () => {
    const spawnedBy = { threadId: "t-o" as ThreadId, feature: "rate-limits" };
    expect(threadRoleOf({ role: "orchestrator" })).toEqual({ kind: "orchestrator" });
    expect(threadRoleOf({ spawnedBy })).toEqual({ kind: "worker", feature: "rate-limits" });
    expect(threadRoleOf({ role: "dream", spawnedBy })).toEqual({ kind: "dream" });
  });

  it("labels and describes each role", () => {
    expect(roleLabel({ kind: "orchestrator" })).toBe("Orchestrator");
    expect(roleLabel({ kind: "worker", feature: "rate-limits" })).toBe("Worker · rate-limits");
    expect(roleDescription({ kind: "worker", feature: "rate-limits" }, "Orchestrator · api")).toBe(
      "Worker for “rate-limits”, spawned by “Orchestrator · api”",
    );
    expect(roleDescription({ kind: "worker", feature: "rate-limits" })).toContain(
      "spawned by an orchestrator",
    );
  });
});

describe("digest words", () => {
  it("numbers only a wake while the app ran", () => {
    expect(digestTitle({ variant: "boot", generation: 0 })).toBe("Session start");
    expect(digestTitle({ variant: "digest", generation: 7 })).toBe("Digest #7");
    expect(digestTitle({ variant: "away", generation: 7 })).toBe("While you were away");
    expect(digestTitle({ variant: "checkpoint", generation: 7 })).toBe("Checkpoint");
  });

  it("writes a change as from → to, and a new worker without a from", () => {
    expect(changeText({ from: "working", to: "done" })).toBe("Working → Done");
    expect(changeText({ to: "briefed" })).toBe("New → Briefed");
  });

  it("gives delivered a label and an icon shape that merged doesn't share", () => {
    expect(changeText({ from: "done", to: "delivered" })).toBe("Done → Delivered");
    expect(presentState("delivered")).toEqual({ label: "Delivered", tone: "delivered" });
    expect(presentState("delivered").tone).not.toBe(presentState("merged").tone);
  });

  it("presents every known state, and a word a newer server sent as itself, never a crash", () => {
    for (const state of WorkerState.literals) {
      expect(presentState(state).label, state).not.toBe(state);
    }
    for (const state of WorkerReportState.literals) {
      expect(presentReportState(state).label, state).not.toBe(state);
    }
    type Change = Parameters<typeof changeText>[0];
    type Digest = Parameters<typeof digestTitle>[0];
    type Pause = Parameters<typeof pauseText>[0];
    type Reason = Parameters<typeof handoffLabel>[0];
    const neutral = { label: "shipped", tone: "muted" };
    expect(presentState("shipped")).toEqual(neutral);
    expect(presentReportState("shipped")).toEqual(neutral);
    // Names every object has must not read as entries of a table.
    expect(presentState("constructor")).toEqual({ label: "constructor", tone: "muted" });
    expect(known({ a: 1 }, "toString")).toBeUndefined();
    expect(known({ a: 1 }, "a")).toBe(1);
    expect(changeText({ from: "working", to: "shipped" } as unknown as Change)).toBe(
      "Working → shipped",
    );
    expect(digestTitle({ variant: "weekly", generation: 3 } as unknown as Digest)).toBe("Digest");
    expect(pauseText({ reason: "quota" } as unknown as Pause)).toBe("Paused (quota)");
    expect(pauseText({ reason: "quota", detail: "until noon" } as unknown as Pause)).toBe(
      "Paused (quota) (until noon)",
    );
    expect(handoffLabel({ reason: "schedule" } as unknown as Reason)).toBe(
      "New session · schedule",
    );
  });

  it("puts the workers on the budget line, not the day's cost, and warns only at the worker cap", () => {
    expect(budgetLine(budget)).toBe("Workers 1/4");
    expect(budgetSpent(budget)).toBe(false);
    expect(budgetSpent({ ...budget, costUsdToday: 9000 })).toBe(false);
    expect(budgetSpent({ ...budget, liveWorkers: 4 })).toBe(true);
  });

  it("names a PR with the facts it has", () => {
    expect(prLabel({ repo: "example/api", number: 12 })).toBe("example/api#12");
    expect(
      prLabel({ repo: "example/api", number: 12, checks: "passing", mergeState: "CLEAN" }),
    ).toBe("example/api#12 (passing, CLEAN)");
  });

  it("flags what the orchestrator should notice about a worker", () => {
    expect(workerFlags({ userIntervened: false, overlapsWith: [], pendingRequests: [] })).toEqual(
      [],
    );
    expect(
      workerFlags({
        userIntervened: true,
        overlapsWith: ["t-1" as ThreadId],
        pendingRequests: [{ kind: "approval", ageMin: 12 }],
      }),
    ).toEqual(["held by you", "overlaps 1 other worker", "waiting 12m on approval"]);
  });

  it("says why an orchestrator is paused, with the server's detail", () => {
    expect(pauseText({ reason: "user" })).toBe("Paused by you");
    expect(pauseText({ reason: "deliveryFailed", detail: "the session would not start" })).toBe(
      "Paused: a digest could not be delivered (the session would not start)",
    );
    // A pause the server made stops the orchestrator, never the workers already at it.
    expect(pauseLeavesRunning(0, { reason: "deliveryFailed" })).toBe(
      "Workers already running would keep going.",
    );
    expect(pauseLeavesRunning(2, { reason: "deliveryFailed" })).toBe(
      "Workers already running keep going (2 now).",
    );
    // The user's own stops them too.
    expect(pauseLeavesRunning(0, { reason: "user" })).toBe(
      "Its workers are stopped too. Resuming lets them go a few at a time.",
    );
    expect(pauseLeavesRunning(2, { reason: "user" })).toContain(
      "stop once they finish the step they're on (2 still at work",
    );
  });

  it("asks before a pause only with work mid-flight, and words a worker's pause", () => {
    expect(pauseConfirmText(0, false)).toBeUndefined();
    expect(pauseConfirmText(1, false)).toMatch(/^1 worker is mid-turn\. Pausing doesn't cut/);
    expect(pauseConfirmText(3, true)).toMatch(/^The orchestrator and 3 workers are mid-turn\./);
    expect(pauseConfirmText(0, true)).toMatch(/^The orchestrator is mid-turn\./);
    const at = new Date(2026, 9, 18, 14, 2).getTime();
    expect(pauseClock(at)).toBe("14:02");
    expect(workerPauseHint("stopping", at)).toBe("Pausing since 14:02… finishing the current step");
    expect(workerPauseHint("held", at)).toContain("yours: it keeps going with you");
    expect(workerPauseHint("paused", at)).toContain("continues where it left off");
  });

  it("words the handoff divider and a file's size", () => {
    expect(handoffLabel({ reason: "context" })).toBe("New session · context was filling up");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB");
    expect(formatBytes(6 * 1.2 * 1024 ** 3)).toBe("7.2 GB");
  });

  it("links only an https address a worker reported", () => {
    expect(safeLink("https://github.com/example/api/pull/1")).toBe(
      "https://github.com/example/api/pull/1",
    );
    expect(safeLink("javascript:alert(1)")).toBeUndefined();
    expect(safeLink("file:///etc/passwd")).toBeUndefined();
    expect(safeLink("not a url")).toBeUndefined();
    expect(safeLink(undefined)).toBeUndefined();
  });
});

describe("lineDiff", () => {
  it("marks a created file as all additions and a deleted one as all deletions", () => {
    expect(lineDiff(undefined, "a\nb\n")).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
    expect(lineDiff("a\n", undefined)).toEqual([{ kind: "del", text: "a" }]);
    expect(lineDiff(undefined, undefined)).toEqual([]);
  });

  it("keeps common lines and puts a replaced line's deletion ahead of its addition", () => {
    const diff = lineDiff("# Map\n\n- api: old\n- web\n", "# Map\n\n- api: new\n- web\n- docs\n");
    expect(diff).toEqual([
      { kind: "same", text: "# Map" },
      { kind: "same", text: "" },
      { kind: "del", text: "- api: old" },
      { kind: "add", text: "- api: new" },
      { kind: "same", text: "- web" },
      { kind: "add", text: "- docs" },
    ]);
    expect(diffStat(diff)).toBe("+2 −1");
  });

  it("is empty of changes for identical text", () => {
    expect(diffStat(lineDiff("a\nb", "a\nb\n"))).toBe("+0 −0");
  });
});
