import type {
  OrchestratorLedger,
  ProjectId,
  Thread,
  ThreadId,
  ThreadStatus,
  ThreadSummary,
  WorkerLedgerEntry,
  WorkerState,
  WorkspaceId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { needsYou } from "@/sidebar/grouping";

import { soloFailures, standingFailures } from "./needs-you-model";

const W1 = "w-platform" as WorkspaceId;

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

const ledger = (workers: WorkerLedgerEntry[]): OrchestratorLedger => ({
  workspaceId: W1,
  features: [...new Set(workers.map((w) => w.feature))].map((feature) => ({
    feature,
    state: "working",
    workers: workers.filter((w) => w.feature === feature),
  })),
  budget: { liveWorkers: 0, maxConcurrentWorkers: 4, costUsdToday: 0 },
  orchestratorEdits: 0,
  builtAt: 0,
});

const red = { repo: "example/api", number: 212, state: "open" as const, checks: "failing" };
const stopped = worker("t-stop", "flaky-retry", "error", {
  lastError: { kind: "costGuard", text: "The spending limit was reached." },
});

describe("standingFailures", () => {
  it("has none without a ledger", () => {
    expect(standingFailures(undefined, {}, new Set())).toEqual([]);
  });

  it("lists an errored worker and failing CI nobody live owns, a PR two follow once", () => {
    const failures = standingFailures(
      ledger([
        stopped,
        worker("t-red", "mail-trigger", "inReview", { pr: red }),
        worker("t-twin", "mail-trigger", "inReview", { pr: red }),
      ]),
      {},
      new Set(),
    );
    expect(failures.map((item) => [item.failure.kind, item.failure.tag])).toEqual([
      ["error", "Spending limit"],
      ["checks", "#212 checks failing"],
    ]);
  });

  it("leaves out what was dismissed, until it fails again under another id", () => {
    const all = ledger([stopped, worker("t-red", "mail-trigger", "inReview", { pr: red })]);
    const [first] = standingFailures(all, {}, new Set());
    const rest = standingFailures(all, {}, new Set(first!.ids));
    expect(rest.map((item) => item.failure.threadId)).toEqual(["t-red"]);
  });
});

const solo = (id: string, status: ThreadStatus, thread: Partial<Thread> = {}): ThreadSummary => ({
  status,
  pendingRequests: [],
  queue: [],
  thread: {
    id: id as ThreadId,
    projectId: "p-api" as ProjectId,
    title: `Title of ${id}`,
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: "/repo" },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 0,
    lastActivityAt: 7_000,
    ...thread,
  },
});

const limit = {
  kind: "costGuard" as const,
  retryable: false,
  text: "The spending limit was reached.",
  at: 9_000,
};

describe("soloFailures", () => {
  it("lists a thread in error as the badge counts it, its failed turn dated and named", () => {
    const threads = [
      solo("t-limit", "error", { lastError: limit }),
      solo("t-running", "running"),
      solo("t-ask", "needsApproval"),
    ];
    const failures = soloFailures(threads, new Set(), () => "api");
    expect(failures).toEqual([
      expect.objectContaining({
        key: "failure:error:t-limit:9000",
        workspaceId: undefined,
        failure: expect.objectContaining({
          kind: "error",
          threadId: "t-limit",
          title: "Title of t-limit",
          project: "api",
          tag: "Spending limit",
          at: 9_000,
        }),
      }),
    ]);
  });

  it("says a turn failed, dated by the last activity, when the thread recorded no error", () => {
    const [failure] = soloFailures([solo("t-quiet", "error")], new Set());
    expect(failure).toMatchObject({
      key: "failure:error:t-quiet:7000",
      failure: { tag: "Turn failed", at: 7_000 },
    });
  });

  it("leaves out a parked thread, which the badge doesn't count, and a dismissed error", () => {
    const parked = solo("t-parked", "error", { parked: true, lastError: limit });
    expect(needsYou(parked)).toBe(false);
    expect(soloFailures([parked], new Set())).toEqual([]);
    const limited = solo("t-limit", "error", { lastError: limit });
    expect(soloFailures([limited], new Set(["failure:error:t-limit:9000"]))).toEqual([]);
    // Failing again is another occurrence, which the dismiss doesn't hold.
    const again = solo("t-limit", "error", { lastError: { ...limit, at: 12_000 } });
    expect(soloFailures([again], new Set(["failure:error:t-limit:9000"]))).toHaveLength(1);
  });
});
