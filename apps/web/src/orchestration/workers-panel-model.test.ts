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
  elsewhereLine,
  FOLDED_BY_DEFAULT,
  groupOf,
  lineOf,
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

const NONE: ReadonlySet<ThreadId> = new Set();
const needing = (...threads: string[]): ReadonlySet<ThreadId> =>
  new Set(threads.map((id) => id as ThreadId));

const ids = (groups: ReturnType<typeof statusGroups>, id: StatusGroupId) =>
  groups.find((group) => group.id === id)!.rows.map((each) => each.threadId);

describe("the Workers tab's groups", () => {
  it("lists every group in order, each named by the one status word and saying what it holds", () => {
    const groups = statusGroups(tabsOf([]), {}, NOW, NONE);
    expect(groups.map((group) => group.label)).toEqual([
      "Needs you",
      "Running",
      "Waiting",
      "Stopped",
      "Done",
    ]);
    for (const group of groups) expect(group.rows).toEqual([]);
  });

  it("folds only Done to start with", () => {
    expect(FOLDED_BY_DEFAULT).toEqual(["done"]);
  });

  it("puts a worker under Needs you exactly when the needs-you list has an item on it", () => {
    const listed = needing("a", "b", "w", "h");
    expect(groupOf(row("a", "needs"), listed)).toBe("needs");
    expect(groupOf(row("b", "error"), listed)).toBe("needs");
    // A Waiting on you item on a worker at work: the Inbox lists it, so Needs you does too.
    expect(groupOf(row("w", "working"), listed)).toBe("needs");
    // Finished, with something still on it for you: it needs you before it is done.
    expect(groupOf(row("h", "idle", { tab: "done", glyph: "merged" }), listed)).toBe("needs");
  });

  it("puts every other worker in its tone's group", () => {
    expect(groupOf(row("c", "working"), NONE)).toBe("running");
    expect(groupOf(row("d", "waiting"), NONE)).toBe("waiting");
    expect(groupOf(row("e", "attention"), NONE)).toBe("stopped");
    expect(groupOf(row("f", "idle"), NONE)).toBe("stopped");
    expect(groupOf(row("g", "merged"), NONE)).toBe("done");
    expect(groupOf(row("h", "idle", { tab: "done", glyph: "merged" }), NONE)).toBe("done");
    // An ask put away for Later, a failure dismissed: no item, so not counted as needing you here
    // when the badge and the Inbox don't count it; at rest, its dot still says why.
    expect(groupOf(row("a", "needs"), NONE)).toBe("stopped");
    expect(groupOf(row("b", "error"), NONE)).toBe("stopped");
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
    // What the needs-you list holds for this workspace: the ask and the failure.
    const listed = needing("ask", "broke");
    const groups = statusGroups(tabs, byId, NOW, listed);
    // Each row's group is its ⌘J row's, whatever list it is drawn in.
    for (const each of tabs.now.flatMap((feature) => feature.rows)) {
      expect(ids(groups, groupOf(each, listed))).toContain(each.threadId);
    }
    expect(ids(groups, "needs")).toEqual(["ask", "broke"]);
    expect(ids(groups, "running")).toEqual(["run"]);
    expect(ids(groups, "done")).toEqual(["shipped"]);
    expect(groups.reduce((sum, group) => sum + group.rows.length, 0)).toBe(5);
  });

  it("filters by search over the title, feature and repo", () => {
    const tabs = tabsOf([row("a", "working"), row("b", "idle", { title: "Fix the mailer" })]);
    const groups = statusGroups(tabs, {}, NOW, NONE, "mailer");
    expect(ids(groups, "running")).toEqual([]);
    expect(ids(groups, "stopped")).toEqual(["b"]);
  });
});

describe("what needs you elsewhere", () => {
  it("says the rest of the pill's count apart from this workspace's", () => {
    expect(elsewhereLine(2, 0)).toBe("2 need you elsewhere");
    expect(elsewhereLine(1, 0)).toBe("1 needs you elsewhere");
    expect(elsewhereLine(1, 2)).toBe("1 more needs you elsewhere");
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

  it("names the joined machine its checkout is on, and none for this one", () => {
    const remote = summary("a", "running", {
      checkout: {
        kind: "worktree",
        path: "/srv/w",
        branch: "b",
        repoRoot: "/srv/r",
        hostId: "m-0123456789abcdef01234567",
      },
    } as Partial<Thread>);
    expect(panelRow(row("a", "working"), remote, NOW).hostId).toBe("m-0123456789abcdef01234567");
    expect(panelRow(row("a", "working"), summary("a", "running"), NOW).hostId).toBeUndefined();
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

  it("says Starting while it is spawned and not begun, never Stopped", () => {
    const starting = row("a", "working", { starting: true, now: "starting…" });
    expect(panelRow(starting, undefined, NOW).status).toBe("Starting…");
  });

  it("opens in the main view only once closed with its worktree, or for a solo thread", () => {
    expect(panelRow(row("a", "merged", { cleanedUp: true }), undefined, NOW).mainOnly).toBe(true);
    expect(panelRow(row("b", "merged", { solo: true }), undefined, NOW).mainOnly).toBe(true);
  });
});

describe("the filter", () => {
  const groups = statusGroups(tabsOf([]), {}, NOW, NONE);

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

describe("a row's status line", () => {
  it("leaves out the state word its group's heading says, and keeps one that heading doesn't", () => {
    expect(lineOf("Waiting · checks on #88", "waiting")).toBe("Checks on #88");
    expect(lineOf("Needs you · wants to push", "needs")).toBe("Wants to push");
    expect(lineOf("Paused · limit until 08:10", "waiting")).toBe("Paused · limit until 08:10");
    expect(lineOf("Running", "working")).toBe("Running");
  });
});
