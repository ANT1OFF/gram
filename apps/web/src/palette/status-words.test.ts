import type {
  OrchestratorLedger,
  ProjectId,
  ThreadId,
  ThreadStatus,
  ThreadSummary,
  WorkerLedgerEntry,
  WorkerPr,
  WorkerState,
  WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { STATUS_DOTS } from "@/orchestration/status-dot";
import { STATUS_WORDS } from "@/orchestration/status-words";
import { workersByTab } from "@/orchestration/workers-model";
import { STATUS_DISPLAY } from "@/sidebar/status";

import { paletteStatusWords, statusWord } from "./status-words";

// Round 8: the palette said "Search in Settings · Stopped" and every orchestrator "Stopped" while
// the sidebar and ⌘J said "Waiting · checks" and "4 workers · 3 working". The palette now reads the
// same selectors, so it says what they say.

const NOW = new Date(2026, 9, 20, 17, 16).getTime();
const WS = "ws-gram" as WorkspaceId;

const pr = (extra: Partial<WorkerPr> = {}): WorkerPr => ({
  repo: "acme/gram",
  number: 142,
  state: "open",
  ...extra,
});

const worker = (
  id: string,
  state: WorkerState,
  extra: Partial<WorkerLedgerEntry> = {},
  status: ThreadStatus = "idle",
): WorkerLedgerEntry => ({
  feature: id,
  projectId: "p-gram" as ProjectId,
  project: "gram",
  threadId: id as ThreadId,
  title: `Title of ${id}`,
  state,
  status,
  pendingRequests: [],
  changedFiles: 0,
  overlapsWith: [],
  userIntervened: false,
  messagesFromOrchestrator: 0,
  ...extra,
});

const summary = (
  id: string,
  status: ThreadStatus,
  extra: Record<string, unknown> = {},
): ThreadSummary =>
  ({
    thread: {
      id,
      title: `Title of ${id}`,
      workspaceId: WS,
      lastActivityAt: NOW - 60_000,
      model: { agent: "claude" },
      checkout: {},
      ...extra,
    },
    status,
    pendingRequests: [],
  }) as unknown as ThreadSummary;

const ledgerOf = (workers: WorkerLedgerEntry[]): Pick<OrchestratorLedger, "features"> =>
  ({
    features: workers.map((w) => ({ feature: w.feature, state: w.state, workers: [w] })),
  }) as unknown as Pick<OrchestratorLedger, "features">;

describe("the palette's status words", () => {
  const waiting = worker("settings-search", "inReview", { pr: pr({ checks: "pending" }) });
  const running = worker("diff-comments", "working", {}, "running");
  const merged = worker("history-sort", "merged", { pr: pr({ number: 141, state: "merged" }) });
  const ledger = ledgerOf([waiting, running, merged]);
  const byId = {
    "settings-search": summary("settings-search", "idle", { spawnedBy: { feature: "x" } }),
    "diff-comments": summary("diff-comments", "running", { spawnedBy: { feature: "y" } }),
    "history-sort": summary("history-sort", "idle", { spawnedBy: { feature: "z" } }),
    "orch-gram": summary("orch-gram", "idle", { role: "orchestrator" }),
    "solo-1": summary("solo-1", "idle", { workspaceId: undefined }),
  };
  const facts = { byId, statusDetail: {}, now: NOW };
  const words = paletteStatusWords([{ id: WS, paused: false }], new Map([[WS, ledger]]), facts);
  const say = (id: keyof typeof byId) => statusWord(byId[id], words);

  it("says a worker's status as ⌘J's row says it, its wait included", () => {
    const rows = new Map(
      [...workersByTab(ledger, facts).now, ...workersByTab(ledger, facts).done]
        .flatMap((feature) => feature.rows)
        .map((row) => [row.threadId as string, row] as const),
    );
    expect(say("settings-search")).toBe("Waiting · checks on #142");
    expect(say("settings-search")).toBe(rows.get("settings-search")?.waiting?.label);
    expect(say("settings-search")).not.toBe(STATUS_WORDS.idle);
    expect(say("diff-comments")).toBe(STATUS_WORDS.working);
    expect(say("history-sort")).toBe(STATUS_WORDS.done);
  });

  it("says an orchestrator at rest as its sidebar line does: its workers, not Stopped", () => {
    expect(say("orch-gram")).toBe("2 workers · 1 working");
  });

  it("says a paused workspace's orchestrator is paused", () => {
    const paused = paletteStatusWords([{ id: WS, paused: true }], new Map([[WS, ledger]]), facts);
    expect(statusWord(byId["orch-gram"], paused)).toBe("Paused");
  });

  it("says an orchestrator with no workers, and a thread in no workspace, Stopped", () => {
    const empty = paletteStatusWords([{ id: WS, paused: false }], new Map(), {
      ...facts,
      byId: { "orch-gram": byId["orch-gram"] },
    });
    expect(statusWord(byId["orch-gram"], empty)).toBe(STATUS_WORDS.idle);
    expect(say("solo-1")).toBe(STATUS_WORDS.idle);
  });
});

describe("one vocabulary", () => {
  it("draws every surface's words from STATUS_WORDS", () => {
    // The dots (sidebar, Board, ⌘J) and a thread's own status (palette, pane header) agree.
    for (const [state, { label }] of Object.entries(STATUS_DOTS)) {
      expect(label).toBe(STATUS_WORDS[state as keyof typeof STATUS_WORDS]);
    }
    const words = new Set(Object.values(STATUS_WORDS));
    for (const status of ["cold", "idle", "running", "error", "ended"] as const) {
      expect(words).toContain(STATUS_DISPLAY[status].label);
    }
    expect(words).not.toContain("Idle");
  });
});
