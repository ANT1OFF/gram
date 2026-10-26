import { describe, expect, it } from "vitest";

import type { TerminalId, Thread } from "@gram/contracts";

import {
  activityLine,
  backgroundWorking,
  rowStatus,
  runningSummary,
  runningWork,
  STATUS_DISPLAY,
  statusHint,
} from "./status";

describe("activityLine", () => {
  it("shows what a working thread does, preferring the live detail", () => {
    expect(activityLine("running", "Reading a.ts", "Thinking")).toBe("Reading a.ts");
    expect(activityLine("starting", undefined, "Thinking")).toBe("Thinking");
  });

  it("shows a background subagent's work while the thread is idle", () => {
    expect(activityLine("idle", "Explore: Thinking", undefined)).toBe("Explore: Thinking");
    expect(activityLine("idle", undefined, undefined)).toBeUndefined();
  });

  it("lets a live event that cleared the detail win over the snapshot", () => {
    expect(activityLine("idle", "", "Explore: Thinking")).toBeUndefined();
    expect(backgroundWorking("idle", activityLine("idle", "", "Explore: Thinking"))).toBe(false);
  });

  it("stays quiet for waits, errors and ended threads", () => {
    expect(activityLine("needsApproval", "Waiting for approval", undefined)).toBeUndefined();
    expect(activityLine("error", "boom", undefined)).toBeUndefined();
    expect(activityLine("ended", undefined, "Thinking")).toBeUndefined();
  });
});

describe("backgroundWorking", () => {
  it("is true only for an idle thread with a subagent line", () => {
    expect(backgroundWorking("idle", "Explore: Thinking")).toBe(true);
    expect(backgroundWorking("idle", undefined)).toBe(false);
    expect(backgroundWorking("running", "Thinking")).toBe(false);
  });
});

describe("rowStatus", () => {
  const open = {} as Thread;
  const merged = { completedAt: 1, completedReason: "prMerged" } as unknown as Thread;

  it("names the status in both the label and the tooltip", () => {
    expect(rowStatus(open, "needsApproval", undefined)).toMatchObject({
      label: "Needs approval",
      title: "Needs approval",
      working: false,
    });
  });

  it("reads an idle thread with a background subagent as working", () => {
    expect(rowStatus(open, "idle", "Explore: Thinking")).toMatchObject({
      icon: STATUS_DISPLAY.running.icon,
      label: "Working",
      working: true,
    });
  });

  it("gives a completed thread at rest the check and its reason", () => {
    const byUser = { completedAt: 1, completedReason: "user" } as unknown as Thread;
    expect(rowStatus(byUser, "idle", undefined)).toMatchObject({
      icon: STATUS_DISPLAY.ended.icon,
      label: "Completed",
      title: "Completed: marked done by you",
    });
  });

  it("gives a thread its PR's merge completed the check too, with the merge as its reason", () => {
    const status = rowStatus(merged, "cold", undefined);
    expect(status).toMatchObject({ label: "Completed", title: "Completed: PR merged" });
    expect(status.icon).toBe(STATUS_DISPLAY.ended.icon);
  });

  it("shows unseen attention on a quiet thread, but never over a working one", () => {
    const attention = { reason: "ciFailed", key: "ci:1:abc", label: "CI failed" } as const;
    const plain = {} as Thread;
    expect(rowStatus(plain, "idle", undefined, attention)).toMatchObject({
      label: "CI failed",
      tone: "text-destructive",
    });
    expect(rowStatus(plain, "idle", "Running tests", attention).label).toBe("Working");
  });

  it("reads Compacting while the turn compacts, its hint naming who asked for it", () => {
    const plain = {} as Thread;
    const compacting = rowStatus(plain, "running", "Compacting context", undefined, [], {
      startedAt: 1,
      trigger: "auto",
    });
    expect(compacting).toMatchObject({
      label: "Compacting",
      title: "Compacting context to make room",
      working: true,
      compacting: true,
      tone: STATUS_DISPLAY.running.tone,
    });
    expect(statusHint(compacting, "Compacting context")).toBe("Compacting context to make room");
    const working = rowStatus(plain, "running", "Running tests");
    expect(statusHint(working, "Running tests")).toBe("Working: Running tests");
    // Only a running thread compacts; a request waiting outranks a stale compaction.
    expect(
      rowStatus(plain, "needsApproval", undefined, undefined, [], { startedAt: 1 }).label,
    ).toBe("Needs approval");
  });

  it("shows work running under a thread at rest, but never over its own turn", () => {
    const work = runningWork({
      background: [
        {
          taskId: "a",
          kind: "subagent",
          description: "List files",
          subagentType: "Explore",
          startedAt: 1,
        },
        { taskId: "b", kind: "shell", description: "Tests", command: "pnpm test", startedAt: 1 },
      ],
      terminalProcesses: [
        { terminalId: "t" as TerminalId, pid: 7, command: "pnpm dev", startedAt: 1 },
      ],
    });
    const status = rowStatus(merged, "idle", "Explore: Thinking", undefined, work);
    expect(status).toMatchObject({
      label: "Running: a subagent, a background shell and a terminal process",
      title:
        "Running: a subagent, a background shell and a terminal process\n• List files (Explore)\n• pnpm test\n• pnpm dev",
      working: false,
      running: 3,
    });
    expect(rowStatus(merged, "running", undefined, undefined, work).label).toBe("Working");
    expect(rowStatus(merged, "needsInput", undefined, undefined, work).label).toBe("Needs input");
    const attention = { reason: "ciFailed", key: "ci:1:abc", label: "CI failed" } as const;
    expect(rowStatus(merged, "idle", undefined, attention, work).running).toBe(3);
    expect(runningWork({})).toEqual([]);
    expect(runningSummary(work.slice(1, 2))).toBe("Running: a background shell");
  });

  it("lists work a line each, never a whole heredoc, and counts past six", () => {
    const heredoc = `cat > app/config.py <<'EOF'\n${"X = 1\n".repeat(200)}EOF`;
    const shells = Array.from({ length: 8 }, (_, i) => ({
      taskId: `s${i}`,
      kind: "shell" as const,
      description: heredoc,
      command: heredoc,
      startedAt: 1,
    }));
    const work = runningWork({ background: shells });
    expect(work[0]!.label).toBe("cat > app/config.py <<'EOF' …");
    const lines = rowStatus(merged, "idle", undefined, undefined, work).title.split("\n");
    expect(lines).toHaveLength(8);
    expect(lines.at(-1)).toBe("and 2 more");
    const seven = rowStatus(merged, "idle", undefined, undefined, work.slice(0, 7));
    expect(seven.title.split("\n")).toHaveLength(8);
  });

  it("never lets completion hide a live status", () => {
    expect(rowStatus(merged, "needsInput", undefined).label).toBe("Needs input");
    expect(rowStatus(merged, "running", undefined).label).toBe("Working");
  });
});
