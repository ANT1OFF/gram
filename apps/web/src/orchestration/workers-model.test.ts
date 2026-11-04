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
  clockTime,
  daysBefore,
  doneDay,
  doneFeatures,
  finishedRow,
  finishedWhen,
  NOW_LINE_WORDS,
  openingTab,
  reportGist,
  requestGist,
  searchRows,
  searchWorkers,
  SOLO_FEATURE,
  soloWorkerRow,
  startOfDay,
  startOfMonth,
  tabCount,
  workerRow,
  workersByTab,
  type WorkerLiveFacts,
  type WorkerRow,
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

/** A row as `doneFeatures` reads it: its id and feature. */
const featureRow = (threadId: string, feature: string) =>
  ({ threadId, feature }) as unknown as WorkerRow;

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
      [worker("held", "f", "working", { userIntervened: true }), "Under your control"],
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

  it("deals workers into Now and Done, Done by the day or month each finished, then by feature", () => {
    const tabs = workersByTab(ledger, live);
    expect(tabs.now.map((f) => [f.feature, f.rows.map((r) => r.threadId)])).toEqual([
      ["mail-trigger", ["queue"]],
    ]);
    // Most recently finished first, each under its day this week and its month before; Done keeps
    // all Gram still has.
    expect(tabs.done.map((f) => [f.day?.label, f.feature, f.rows.map((r) => r.threadId)])).toEqual([
      ["Today", "mail-trigger", ["schema"]],
      ["Mon 12 Oct", "tooling", ["uv"]],
      ["October 2026", "tooling", ["py39"]],
      ["October 2026", "spike", ["spike"]],
    ]);
    expect(tabCount(tabs.done)).toBe(4);
    expect(tabs.done[1]!.rows[0]!.now).toBe("merged 12 Oct");
    // An archived worker says when too, as Done grouped by orchestrator has no day heading for it.
    expect(tabs.done[3]!.rows[0]!.now).toBe("archived 3 Oct");
  });

  it("searches finished workers by name, feature or repo, keeping their days", () => {
    const tabs = workersByTab(ledger, live);
    expect(
      searchWorkers(tabs.done, "web").map((f) => [f.day?.label, f.rows.map((r) => r.threadId)]),
    ).toEqual([["October 2026", ["py39"]]]);
    const rows = tabs.done.flatMap((f) => f.rows);
    expect(searchRows(rows, "tooling web").map((r) => r.threadId)).toEqual(["py39"]);
    expect(searchRows(rows, "")).toEqual(rows);
    expect(searchWorkers(tabs.done, "SPIKE")).toHaveLength(1);
    expect(searchWorkers(tabs.done, "nothing like it")).toEqual([]);
    expect(searchWorkers(tabs.done, " ")).toEqual(tabs.done);
  });

  it("opens on Done only when nothing is going on", () => {
    const tabs = workersByTab(ledger, live);
    expect(openingTab(tabs)).toBe("now");
    expect(openingTab({ ...tabs, now: [] })).toBe("done");
    expect(openingTab(workersByTab(undefined, live))).toBe("now");
  });

  it("says when a finished worker finished in 24-hour time, or its day", () => {
    expect(finishedWhen(startOfDay(NOW) + 9 * HOUR + 5 * 60_000, NOW)).toBe("09:05");
    expect(finishedWhen(NOW - 2 * 24 * HOUR, NOW)).toBe("13 Oct");
    expect(clockTime(NOW - 2 * 24 * HOUR)).toBe("14:40");
  });

  it("heads Done's days at local midnight: Today, Yesterday, then the weekday and date", () => {
    const midnight = startOfDay(NOW);
    const days = {
      features: [
        {
          feature: "f",
          workers: [
            worker("first", "f", "delivered"),
            worker("midnight", "f", "done"),
            worker("late", "f", "merged"),
            worker("parked", "f", "archived", { stateBase: { state: "merged", parked: true } }),
            worker("week", "f", "delivered"),
          ],
        } as unknown as FeatureLedgerEntry,
      ],
    };
    const tabs = workersByTab(
      days,
      facts({
        first: summary("first", "idle", { completedAt: midnight + 60_000 }),
        midnight: summary("midnight", "idle", { completedAt: midnight }),
        late: summary("late", "idle", { completedAt: midnight - 60_000 }),
        parked: summary("parked", "idle", { completedAt: daysBefore(NOW, 2) + 10 * HOUR }),
        week: summary("week", "idle", { completedAt: daysBefore(NOW, 6) + HOUR }),
      }),
    );
    expect(tabs.done.map((f) => [f.day?.label, f.rows.map((r) => r.threadId)])).toEqual([
      ["Today", ["first", "midnight"]],
      ["Yesterday", ["late"]],
      ["Tue 13 Oct", ["parked"]],
      ["Fri 9 Oct", ["week"]],
    ]);
    expect(tabs.done[0]!.day?.start).toBe(midnight);
    expect(tabs.done[1]!.day?.start).toBe(daysBefore(NOW, 1));
    // Archived by the orchestrator once its PR merged, it is still in Done, and still merged.
    expect(tabs.done[2]!.rows[0]).toMatchObject({
      state: "archived",
      glyph: "merged",
      now: "merged 13 Oct",
    });
  });

  it("counts days by the calendar, so the week before starts at a midnight", () => {
    expect(daysBefore(NOW, 0)).toBe(startOfDay(NOW));
    expect(daysBefore(NOW, 6)).toBe(new Date(2026, 9, 9).getTime());
    // Across the end of summer time in Europe (25 October 2026), a day is 25 hours long.
    expect(daysBefore(new Date(2026, 9, 26, 12).getTime(), 1)).toBe(
      new Date(2026, 9, 25).getTime(),
    );
  });

  it("heads Done by month before the week: this year's and earlier years' alike", () => {
    expect(doneDay(daysBefore(NOW, 6), NOW)).toEqual({
      start: daysBefore(NOW, 6),
      label: "Fri 9 Oct",
    });
    // The minute before the week's first midnight is October's.
    expect(doneDay(daysBefore(NOW, 6) - 60_000, NOW)).toEqual({
      start: new Date(2026, 9, 1).getTime(),
      label: "October 2026",
    });
    expect(doneDay(new Date(2026, 8, 30, 23, 59).getTime(), NOW)).toEqual({
      start: new Date(2026, 8, 1).getTime(),
      label: "September 2026",
    });
    expect(doneDay(new Date(2025, 11, 31, 8).getTime(), NOW).label).toBe("December 2025");
    expect(doneDay(undefined, NOW)).toEqual({ start: 0, label: "Earlier" });
    expect(startOfMonth(new Date(2026, 1, 28, 18).getTime())).toBe(new Date(2026, 1, 1).getTime());
  });

  it("lists a solo thread marked done as a row of ⌘J's Done, under Solo threads", () => {
    const done = summary("s1", "idle", {
      title: "Fix the flaky login test",
      completedAt: startOfDay(NOW) + 10 * HOUR,
      completedReason: "user",
    });
    expect(soloWorkerRow(done, NOW)).toMatchObject({
      threadId: "s1",
      title: "Fix the flaky login test",
      feature: SOLO_FEATURE,
      tab: "done",
      glyph: "delivered",
      now: "done 10:00",
      finishedAt: startOfDay(NOW) + 10 * HOUR,
      solo: true,
    });
    const merged = summary("s2", "idle", {
      completedAt: NOW - 2 * 24 * HOUR,
      completedReason: "prMerged",
    });
    expect(soloWorkerRow(merged, NOW)).toMatchObject({ glyph: "merged", now: "merged 13 Oct" });
  });

  it("splits one of Done's groups by feature, the latest feature first", () => {
    expect(
      doneFeatures([
        featureRow("a", "x"),
        featureRow("b", "y"),
        featureRow("c", "x"),
        featureRow("d", SOLO_FEATURE),
      ]).map((f) => [f.feature, f.rows.map((r) => r.threadId)]),
    ).toEqual([
      ["x", ["a", "c"]],
      ["y", ["b"]],
      [SOLO_FEATURE, ["d"]],
    ]);
  });

  it("lists a worker closed with its worktree as a done row, beside the ledger's", () => {
    const today = closed("c1", startOfDay(NOW) + 11 * HOUR + 40 * 60_000, true);
    const old = closed("c2", NOW - 3 * 24 * HOUR, false);
    expect(finishedRow(today, NOW)).toMatchObject({
      tab: "done",
      glyph: "merged",
      now: "merged 11:40",
      repo: "api",
      cleanedUp: true,
      held: false,
    });
    expect(finishedRow(old, NOW)).toMatchObject({ tab: "done", glyph: "archived" });
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
    // The reopened worker's ledger row wins; the closed ones join its feature on their days. With
    // no thread to say when it finished, it goes last, under Earlier.
    const all = tabs.done.flatMap((f) => f.rows);
    expect(all.filter((row) => row.threadId === "live")).toHaveLength(1);
    expect(all.find((row) => row.threadId === "live")?.cleanedUp).toBeUndefined();
    expect(tabs.done.map((f) => [f.day?.label, f.rows.map((r) => r.threadId)])).toEqual([
      ["Today", ["c1"]],
      ["Mon 12 Oct", ["c2"]],
      ["Earlier", ["live"]],
    ]);
  });
});
