import type {
  OrchestratorLedger,
  ProjectId,
  Thread,
  ThreadId,
  ThreadStatus,
  ThreadSummary,
  WorkerLedgerEntry,
  WorkerState,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import type { RailTone } from "./rail-model";
import { workersByTab, type WorkerRow, type WorkersByTab } from "./workers-model";
import {
  filteredGroups,
  filterLabel,
  FOLDED_BY_DEFAULT,
  groupOf,
  panelRow,
  STATUS_GROUPS,
  statusGroups,
  type StatusGroupId,
} from "./workers-panel-model";

// Wednesday 15 October 2026, 14:40 local time.
const NOW = new Date(2026, 9, 15, 14, 40).getTime();
const MINUTE = 60_000;

const worker = (
  id: string,
  state: WorkerState,
  extra: Partial<WorkerLedgerEntry> = {},
): WorkerLedgerEntry => ({
  feature: "refunds",
  projectId: "p-api" as ProjectId,
  project: "api",
  threadId: id as ThreadId,
  title: `Title of ${id}`,
  state,
  status: "idle",
  pendingRequests: [],
  changedFiles: 0,
  overlapsWith: [],
  userIntervened: false,
  messagesFromOrchestrator: 0,
  ...extra,
});

const summary = (id: string, status: ThreadStatus, thread: Partial<Thread> = {}): ThreadSummary =>
  ({
    thread: { id: id as ThreadId, title: `Title of ${id}`, lastActivityAt: NOW, ...thread },
    status,
    pendingRequests: [],
  }) as unknown as ThreadSummary;

const ledgerOf = (workers: WorkerLedgerEntry[]): Pick<OrchestratorLedger, "features"> =>
  ({ features: [{ feature: "refunds", workers }] }) as unknown as Pick<
    OrchestratorLedger,
    "features"
  >;

/** A ⌘J row with just what the panel reads. */
const row = (id: string, tone: RailTone, extra: Partial<WorkerRow> = {}): WorkerRow =>
  ({
    threadId: id as ThreadId,
    title: `Title of ${id}`,
    feature: "refunds",
    repo: "api",
    tab: "now",
    glyph: "idle",
    tone,
    now: "",
    held: false,
    ...extra,
  }) as unknown as WorkerRow;

const tabsOf = (now: WorkerRow[], done: WorkerRow[] = []): WorkersByTab => ({
  now: now.length === 0 ? [] : [{ feature: "refunds", rows: now }],
  done: done.length === 0 ? [] : [{ feature: "refunds", rows: done }],
});

const ids = (groups: ReturnType<typeof statusGroups>, id: StatusGroupId) =>
  groups.find((group) => group.id === id)!.rows.map((each) => each.threadId);

describe("the Workers tab's groups", () => {
  it("lists every group in order, each named by the one status word and saying what it holds", () => {
    const groups = statusGroups(tabsOf([]), {}, NOW);
    expect(groups.map((group) => group.label)).toEqual([
      "Needs you",
      "Running",
      "Waiting",
      "Stopped",
      "Done",
    ]);
    for (const group of groups) {
      expect(group.rows).toEqual([]);
      // A fragment, no full stop (DESIGN.md → Voice).
      expect(group.empty).not.toMatch(/\.$/);
      expect(group.empty.length).toBeGreaterThan(0);
    }
  });

  it("folds only Done to start with", () => {
    expect(FOLDED_BY_DEFAULT).toEqual(["done"]);
  });

  it("puts each worker in its tone's group, a failure with what needs you", () => {
    expect(groupOf(row("a", "needs"))).toBe("needs");
    expect(groupOf(row("b", "error"))).toBe("needs");
    expect(groupOf(row("c", "working"))).toBe("running");
    expect(groupOf(row("d", "waiting"))).toBe("waiting");
    expect(groupOf(row("e", "attention"))).toBe("stopped");
    expect(groupOf(row("f", "idle"))).toBe("stopped");
    expect(groupOf(row("g", "merged"))).toBe("done");
    expect(groupOf(row("h", "idle", { tab: "done", glyph: "merged" }))).toBe("done");
  });

  it("reads tones from the shared selector, so its counts are the sidebar's and the Board's", () => {
    const ledger = ledgerOf([
      worker("ask", "needsUser", { status: "needsInput" }),
      worker("run", "working", { status: "running" }),
      worker("rest", "working"),
      worker("broke", "error"),
      worker("shipped", "merged"),
    ]);
    const byId = {
      ask: summary("ask", "needsInput"),
      run: summary("run", "running"),
      rest: summary("rest", "idle"),
      broke: summary("broke", "error"),
      shipped: summary("shipped", "idle", { completedAt: NOW - 5 * MINUTE }),
    };
    const tabs = workersByTab(ledger, { byId, statusDetail: {}, now: NOW });
    const groups = statusGroups(tabs, byId, NOW);
    // Each row's group is its ⌘J row's tone, whatever list it is drawn in.
    for (const each of tabs.now.flatMap((feature) => feature.rows)) {
      expect(ids(groups, groupOf(each))).toContain(each.threadId);
    }
    expect(ids(groups, "needs")).toEqual(["ask", "broke"]);
    expect(ids(groups, "running")).toEqual(["run"]);
    expect(ids(groups, "done")).toEqual(["shipped"]);
    expect(groups.reduce((sum, group) => sum + group.rows.length, 0)).toBe(5);
  });

  it("filters by search over the title, feature and repo", () => {
    const tabs = tabsOf([row("a", "working"), row("b", "idle", { title: "Fix the mailer" })]);
    const groups = statusGroups(tabs, {}, NOW, "mailer");
    expect(ids(groups, "running")).toEqual([]);
    expect(ids(groups, "stopped")).toEqual(["b"]);
  });
});

describe("a row", () => {
  it("says its dot, its state in words and its age", () => {
    const at = NOW - 5 * MINUTE;
    const live = panelRow(
      row("a", "waiting", {
        now: "Waiting · checks",
        waiting: { label: "Waiting · checks" } as WorkerRow["waiting"],
      }),
      summary("a", "idle", { lastActivityAt: at }),
      NOW,
    );
    expect(live.dot).toBe("waiting");
    expect(live.status).toBe("Waiting · checks");
    expect(live.age).toBe("5m");
    expect(live.at).toBe("14:35");
    expect(live.mainOnly).toBe(false);
  });

  it("is now while it has just moved, and finished work goes by when it finished", () => {
    expect(panelRow(row("a", "working"), summary("a", "running"), NOW).age).toBe("now");
    const done = panelRow(
      row("b", "merged", { tab: "done", glyph: "merged", finishedAt: NOW - 3 * 60 * MINUTE }),
      summary("b", "idle", { lastActivityAt: NOW }),
      NOW,
    );
    expect(done.dot).toBe("merged");
    expect(done.age).toBe("3h");
  });

  it("adds its now line to the state's word", () => {
    expect(panelRow(row("a", "working", { now: "running tests" }), undefined, NOW).status).toBe(
      "Running · running tests",
    );
    expect(panelRow(row("a", "idle"), undefined, NOW)).toMatchObject({
      status: "Stopped",
      age: "",
    });
  });

  it("opens in the main view only once closed with its worktree, or for a solo thread", () => {
    expect(panelRow(row("a", "merged", { cleanedUp: true }), undefined, NOW).mainOnly).toBe(true);
    expect(panelRow(row("b", "merged", { solo: true }), undefined, NOW).mainOnly).toBe(true);
  });
});

describe("the filter", () => {
  const groups = statusGroups(tabsOf([]), {}, NOW);

  it("shows every group with none picked", () => {
    expect(filteredGroups(groups, new Set())).toHaveLength(STATUS_GROUPS.length);
    expect(filterLabel(new Set())).toBe("All workers");
  });

  it("shows only the groups picked, and names them", () => {
    const shown = new Set<StatusGroupId>(["needs", "waiting"]);
    expect(filteredGroups(groups, shown).map((group) => group.id)).toEqual(["needs", "waiting"]);
    expect(filterLabel(shown)).toBe("Needs you, Waiting");
  });
});
