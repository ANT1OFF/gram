import type {
  FeatureLedgerEntry,
  FinishedWorker,
  PendingRequest,
  ProjectId,
  RequestId,
  Thread,
  ThreadId,
  ThreadStatus,
  ThreadSummary,
  WorkerLedgerEntry,
  WorkerState,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  activityGist,
  capWords,
  finishedRow,
  finishedWhen,
  NOW_LINE_WORDS,
  openingTab,
  reportGist,
  requestGist,
  searchWorkers,
  startOfDay,
  tabCount,
  workerRow,
  workersByTab,
  type WorkerLiveFacts,
} from "./workers-model";

// Wednesday 15 October 2026, 14:40 local time.
const NOW = new Date(2026, 9, 15, 14, 40).getTime();
const HOUR = 60 * 60_000;

const worker = (
  id: string,
  feature: string,
  state: WorkerState,
  extra: Partial<WorkerLedgerEntry> = {},
): WorkerLedgerEntry => ({
  feature,
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

const summary = (
  id: string,
  status: ThreadStatus,
  thread: Partial<Thread> = {},
  pendingRequests: PendingRequest[] = [],
): ThreadSummary =>
  ({
    thread: {
      id: id as ThreadId,
      title: `Title of ${id}`,
      lastActivityAt: NOW - HOUR,
      ...thread,
    },
    status,
    pendingRequests,
  }) as unknown as ThreadSummary;

const facts = (
  byId: Record<string, ThreadSummary> = {},
  statusDetail: Record<string, string> = {},
): WorkerLiveFacts => ({ byId, statusDetail, now: NOW });

const words = (line: string) => line.replace(/…$/, "").split(/\s+/).length;

const closed = (id: string, closedAt: number, merged: boolean): FinishedWorker => ({
  threadId: id as ThreadId,
  workspaceId: "w1" as FinishedWorker["workspaceId"],
  title: `Closed ${id}`,
  feature: "mail-retry",
  closedAt,
  ...(merged ? { completedReason: "prMerged" as const } : {}),
  prs: merged
    ? [{ repo: "example/api", number: 428, url: "https://x/428", merged: true as const }]
    : [],
  kept: "closed",
});

describe("the now line", () => {
  it("says what a running worker does, by the kind of thing, never its arguments", () => {
    expect(activityGist("Running uv run pytest tests/queue")).toBe("running tests");
    expect(activityGist("Running git push -u origin feat/x")).toBe("pushing");
    expect(activityGist("Running bun run lint")).toBe("linting");
    expect(activityGist("Running ls -la")).toBe("running a command");
    expect(activityGist("uv run pytest tests/queue")).toBe("running tests");
    expect(activityGist("git push")).toBe("pushing");
    expect(activityGist("Editing src/queue/consumer.py")).toBe("editing code");
    expect(activityGist("Editing 3 files")).toBe("editing code");
    expect(activityGist("Reading queue/consumer.py")).toBe("reading code");
    expect(activityGist("Searching for ackAfter")).toBe("searching code");
    expect(activityGist("Fetching docs.python.org")).toBe("reading the web");
    expect(activityGist("Explore: find the retry tests")).toBe("running a subagent");
    expect(activityGist("Using github: create_pull_request")).toBe("using github");
    // A plan step's own words, from the agent's todo list.
    expect(activityGist("Wiring the retry into the consumer loop")).toBe("wiring the retry into…");
  });

  it("takes a report's first clause, four words at most, or its test count", () => {
    expect(reportGist("Backoff is in. Docs next.")).toBe("backoff is in");
    // The design's own example: a count of tests run is the gist.
    expect(reportGist("Backoff is in. Running the suite; 38 of 52 so far.")).toBe("tests 38/52");
    expect(reportGist("Moved the ack after the handler and added backoff.")).toBe(
      "moved the ack after…",
    );
    expect(reportGist("API ready; docs next")).toBe("API ready");
    expect(reportGist("")).toBe("reported");
  });

  it("names the request a worker waits on you for", () => {
    expect(requestGist({ kind: "approval" }, "git push -u origin feat/x")).toBe("wants to push");
    expect(requestGist({ kind: "approval" }, "rm -rf build")).toBe("wants to run rm");
    expect(requestGist({ kind: "approval" })).toBe("wants approval");
    expect(requestGist({ kind: "question" })).toBe("asks you");
    expect(requestGist({ kind: "plan" })).toBe("has a plan");
  });

  it("caps any line at four words", () => {
    expect(capWords("one two three four five")).toBe("one two three four…");
    expect(capWords("  one   two ")).toBe("one two");
  });

  it("is deterministic and short for every kind of worker", () => {
    const push: PendingRequest = {
      kind: "approval",
      id: "r1" as RequestId,
      toolName: "Bash",
      displayName: "Bash",
      input: { command: "git push -u origin feat/form" },
      suggestions: [],
      scopes: ["once"],
    } as unknown as PendingRequest;
    const live = facts(
      {
        run: summary("run", "running"),
        push: summary("push", "needsApproval", {}, [push]),
        merged: summary("merged", "idle", { completedAt: NOW - 3 * HOUR }),
      },
      { run: "Running uv run pytest tests/queue" },
    );
    const cases: [WorkerLedgerEntry, string][] = [
      [worker("run", "f", "working"), "running tests"],
      [worker("push", "f", "working"), "wants to push"],
      [worker("merged", "f", "merged"), "merged 11:40"],
      [
        worker("asked", "f", "question", {
          lastReport: { threadId: "asked" as ThreadId, state: "question", summary: "?", at: NOW },
          reportStands: true,
        }),
        "asked a question",
      ],
      [worker("stuck", "f", "blocked", { reportStands: true }), "blocked"],
      [worker("held", "f", "working", { userIntervened: true }), "you hold it"],
      [worker("brief", "f", "briefed"), "briefed"],
      [worker("err", "f", "error"), "stopped on an error"],
      [worker("gone", "f", "archived"), "archived"],
      [
        worker("prog", "f", "working", {
          lastReport: {
            threadId: "prog" as ThreadId,
            state: "progress",
            summary: "Backoff is in; 38 of 52 pass.",
            at: NOW,
          },
        }),
        "backoff is in",
      ],
    ];
    for (const [entry, line] of cases) {
      const row = workerRow(entry, live);
      expect(row.now, entry.threadId).toBe(line);
      expect(words(row.now)).toBeLessThanOrEqual(NOW_LINE_WORDS);
      expect(workerRow(entry, live)).toEqual(row);
    }
  });
});

describe("the tabs", () => {
  const ledger = {
    features: [
      {
        feature: "mail-trigger",
        state: "working",
        workers: [
          worker("queue", "mail-trigger", "working"),
          worker("schema", "mail-trigger", "merged"),
        ],
      },
      {
        feature: "tooling",
        state: "merged",
        workers: [
          worker("uv", "tooling", "merged", { project: "api" }),
          worker("py39", "tooling", "merged", { project: "web" }),
        ],
      },
      {
        feature: "spike",
        state: "archived",
        workers: [worker("spike", "spike", "archived")],
      },
    ] satisfies FeatureLedgerEntry[],
  };
  const live = facts({
    queue: summary("queue", "running"),
    schema: summary("schema", "idle", { completedAt: NOW - 3 * HOUR }),
    uv: summary("uv", "idle", { completedAt: NOW - 3 * 24 * HOUR }),
    py39: summary("py39", "idle", { completedAt: NOW - 9 * 24 * HOUR }),
    spike: summary("spike", "idle", { lastActivityAt: NOW - 12 * 24 * HOUR }),
  });

  it("deals workers into Now, Done today and Earlier, grouped by feature", () => {
    const tabs = workersByTab(ledger, live);
    expect(tabs.now.map((f) => [f.feature, f.rows.map((r) => r.threadId)])).toEqual([
      ["mail-trigger", ["queue"]],
    ]);
    expect(tabs.doneToday.map((f) => [f.feature, f.rows.map((r) => r.threadId)])).toEqual([
      ["mail-trigger", ["schema"]],
    ]);
    // Most recently finished first.
    expect(tabs.earlier.map((f) => [f.feature, f.rows.map((r) => r.threadId)])).toEqual([
      ["tooling", ["uv", "py39"]],
      ["spike", ["spike"]],
    ]);
    expect(tabCount(tabs.earlier)).toBe(3);
    expect(tabs.earlier[0]!.rows[0]!.now).toBe("merged 12 Oct");
  });

  it("searches finished workers by name, feature or repo", () => {
    const tabs = workersByTab(ledger, live);
    expect(searchWorkers(tabs.earlier, "web").map((f) => f.rows.map((r) => r.threadId))).toEqual([
      ["py39"],
    ]);
    expect(searchWorkers(tabs.earlier, "SPIKE")).toHaveLength(1);
    expect(searchWorkers(tabs.earlier, "nothing like it")).toEqual([]);
    expect(searchWorkers(tabs.earlier, " ")).toEqual(tabs.earlier);
  });

  it("opens on Done today only when nothing is going on", () => {
    const tabs = workersByTab(ledger, live);
    expect(openingTab(tabs)).toBe("now");
    expect(openingTab({ ...tabs, now: [] })).toBe("doneToday");
    expect(openingTab(workersByTab(undefined, live))).toBe("now");
  });

  it("says when a finished worker finished in 24-hour time, or its day", () => {
    expect(finishedWhen(startOfDay(NOW) + 9 * HOUR + 5 * 60_000, NOW)).toBe("09:05");
    expect(finishedWhen(NOW - 2 * 24 * HOUR, NOW)).toBe("13 Oct");
  });

  it("lists a worker closed with its worktree as a done row, beside the ledger's", () => {
    const today = closed("c1", startOfDay(NOW) + 11 * HOUR + 40 * 60_000, true);
    const old = closed("c2", NOW - 3 * 24 * HOUR, false);
    expect(finishedRow(today, NOW)).toMatchObject({
      tab: "doneToday",
      glyph: "merged",
      now: "merged 11:40",
      repo: "api",
      cleanedUp: true,
      held: false,
    });
    expect(finishedRow(old, NOW)).toMatchObject({ tab: "earlier", glyph: "archived" });
    expect(finishedRow(old, NOW).now.split(" ").length).toBeLessThanOrEqual(NOW_LINE_WORDS);

    const withLive = {
      features: [
        {
          feature: "mail-retry",
          workers: [worker("live", "mail-retry", "merged")],
        } as unknown as FeatureLedgerEntry,
      ],
    };
    const tabs = workersByTab(withLive, facts(), [today, old, closed("live", NOW, true)]);
    // The reopened worker's ledger row wins; the closed ones join its feature's group.
    const all = [...tabs.doneToday, ...tabs.earlier].flatMap((f) => f.rows);
    expect(all.filter((row) => row.threadId === "live")).toHaveLength(1);
    expect(all.find((row) => row.threadId === "live")?.cleanedUp).toBeUndefined();
    expect(tabs.earlier.flatMap((f) => f.rows).map((row) => row.threadId)).toContain("c2");
    expect(tabs.doneToday.filter((f) => f.feature === "mail-retry")).toHaveLength(1);
  });
});
