import {
  orchestrationMode,
  type CatchUpView,
  type GitState,
  type GramUIMessage,
  type ProjectId,
  type Thread,
  type ThreadId,
  type WorkerReport,
  type WorkspaceId,
} from "@gram/contracts";

import type { MockFinishedSimulation, MockOrchestrationHost } from "./mock-orchestration";

// The ⌘J Workers list scenario: the finished-work board with workers in every tab the list shows.
// A worker running live with a long transcript to scroll, one that asked a question, one merged
// today, and three finished on earlier days. Two of them carry reports the user hasn't seen, one
// with the helper's catch-up armed and one without, which falls back to its report's summary.

/** What the orchestration mock lends the scenario. */
export interface MockWorkersDeps {
  readonly host: MockOrchestrationHost;
  /** The workspace's home repo, which every worker here works in. */
  readonly home: (workspaceId: WorkspaceId) => { readonly id: ProjectId; readonly root: string };
  /** Files a report as the ledger's latest for its worker. */
  readonly fileReport: (report: WorkerReport) => void;
  /** Arms the helper's catch-up for a worker. */
  readonly catchUp: (view: CatchUpView) => void;
}

/** What the scenario made, for a spec to navigate by. */
export interface MockWorkersSimulation extends MockFinishedSimulation {
  /** Running tests now, with a long transcript and an unseen report the helper caught up on. */
  readonly live: ThreadId;
  /** Asked the orchestrator a question it is waiting on; its unseen report has no catch-up. */
  readonly asking: ThreadId;
  /** Merged within the last hour, so in Done today whatever the time. */
  readonly doneToday: ThreadId;
  /** Merged or archived days ago. */
  readonly earlier: readonly ThreadId[];
  /** The board's held worker (`working`), for Hand back. */
  readonly held: ThreadId;
}

export const MOCK_LIVE_CATCH_UP =
  "The worker moved the ack after the handler and added backoff with jitter. 38 of 52 tests pass so far.";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const STEPS = [
  "Reading queue/consumer.py to see where the ack happens.",
  "The ack runs before the handler, so a crash loses the message. Moving it after.",
  "Moved the ack. Adding a retry with exponential backoff on 5xx.",
  "Backoff is in: 1 s, 2 s, 4 s, 8 s, 16 s, then dead-letter.",
  "Adding jitter so retries from many consumers don't line up.",
  "Writing tests for the dead-letter path.",
  "tests/queue/test_retry.py covers the five tries and the dead letter.",
  "Running the suite: uv run pytest tests/queue.",
  "28 of 52 pass so far; nothing failed yet.",
  "Still running. test_consumer.py is the slow one.",
  "38 of 52 pass so far.",
  "Waiting on the last integration tests.",
];

/** The live worker's one edit: the ack moved after the handler, with the retry around it. */
const CONSUMER_EDIT = {
  file_path: "queue/consumer.py",
  old_string: ["    ack(message)", "    handle(message)"].join("\n"),
  new_string: [
    "    for attempt in range(MAX_TRIES):",
    "        try:",
    "            handle(message)",
    "            break",
    "        except ServerError:",
    "            sleep(backoff(attempt))",
    "    ack(message)",
  ].join("\n"),
};

export async function simulateWorkersList(
  deps: MockWorkersDeps,
  board: MockFinishedSimulation,
  /** The live worker's edit and running suite as tool calls, for its peek (One thread only). */
  { liveTools = false }: { readonly liveTools?: boolean } = {},
): Promise<MockWorkersSimulation> {
  const { host } = deps;
  const settings = await host.settings();
  const { workspaceId, orchestratorThreadId } = board;
  const home = deps.home(workspaceId);
  const now = Date.now();

  const spawn = async (
    feature: string,
    title: string,
    slug: string,
    patch: Partial<Thread> = {},
  ) => {
    const created = await host.createThread({
      projectRoot: home.root,
      title,
      mode: orchestrationMode(settings),
      branch: `feat/${slug}`,
    });
    const worker: Thread = {
      ...created,
      workspaceId,
      spawnedBy: { threadId: orchestratorThreadId, feature },
      ...patch,
    };
    host.replace(worker);
    return worker;
  };
  const say = (
    threadId: ThreadId,
    text: string,
    at: number,
    role: "user" | "assistant" = "assistant",
  ) =>
    host.putMessage(threadId, {
      id: host.ids(),
      role,
      metadata: { createdAt: at },
      parts: [{ type: "text", text, ...(role === "assistant" ? { state: "done" as const } : {}) }],
    } as GramUIMessage);
  /** A tool call of its own: finished, or still running. */
  const tool = (threadId: ThreadId, name: string, input: unknown, at: number, running = false) =>
    host.putMessage(threadId, {
      id: host.ids(),
      role: "assistant",
      metadata: { createdAt: at },
      parts: [
        {
          type: `tool-${name}`,
          toolCallId: host.ids(),
          state: running ? "input-available" : "output-available",
          input,
          ...(running ? {} : { output: "" }),
        },
      ],
    } as GramUIMessage);
  const merged = (worker: Thread, number: number, at: number) => {
    const git: GitState = {
      repo: true,
      branch: worker.checkout.branch!,
      worktree: true,
      head: `${number}`.padEnd(40, "0"),
      changesToken: `mock-workers-${number}`,
      changedFiles: 0,
      base: "origin/main",
      behindBase: 1,
      aheadBase: 0,
      conflicts: false,
      upstream: "synced",
      origin: "example/api",
      pr: {
        number,
        state: "MERGED",
        url: `https://github.com/example/api/pull/${number}`,
        title: worker.title,
        isDraft: false,
        checks: "passing",
        headMatches: true,
        aheadOfPr: false,
        baseRef: "main",
        headRef: worker.checkout.branch!,
      },
    };
    host.setGit(worker.id, git);
    host.replace({ ...worker, completedAt: at, completedReason: "prMerged", lastActivityAt: at });
  };

  // Live: running the suite, with a transcript taller than any pane and a report you haven't seen.
  const live = await spawn("mail-retry-policy", "Retry with backoff", "mail-retry-policy", {
    lastViewedAt: now - 3 * 60 * MINUTE,
  });
  say(live.id, "Retry on 5xx with backoff; dead-letter after 5 tries.", now - 50 * MINUTE, "user");
  STEPS.forEach((step, i) => {
    const at = now - (45 - i * 3) * MINUTE;
    say(live.id, step, at);
    // Its edit and the suite it is running, for its terminal and its peek.
    if (liveTools && i === 2) tool(live.id, "Edit", CONSUMER_EDIT, at);
    if (liveTools && i === 7)
      tool(live.id, "Bash", { command: "uv run pytest tests/queue" }, at, true);
  });
  host.setStatus(live.id, "running", "Running uv run pytest tests/queue");
  const liveReport: WorkerReport = {
    threadId: live.id,
    state: "progress",
    summary: "Backoff is in; 38 of 52 tests pass so far.",
    at: now - 12 * MINUTE,
  };
  deps.fileReport(liveReport);
  deps.catchUp({ threadId: live.id, text: MOCK_LIVE_CATCH_UP, reportAt: liveReport.at });

  // Waiting: asked the orchestrator a question; no catch-up is armed, so its report stands in.
  const asking = await spawn("rate-headers", "Rate limit headers", "rate-headers", {
    lastViewedAt: now - 2 * 60 * MINUTE,
  });
  say(asking.id, "Add X-RateLimit-* headers to every API response.", now - 70 * MINUTE, "user");
  say(
    asking.id,
    "The limiter already knows the window; the headers need its reset time.",
    now - 30 * MINUTE,
  );
  deps.fileReport({
    threadId: asking.id,
    state: "question",
    summary: "Should Retry-After be seconds or an HTTP date? The spec allows both.",
    at: now - 20 * MINUTE,
  });

  // Done today: merged within the hour, or just after midnight when it is earlier than that.
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const todayAt = Math.max(now - 40 * MINUTE, midnight.getTime() + MINUTE);
  const doneToday = await spawn("rate-headers", "Retry-After header", "rate-headers-retry");
  merged(doneToday, 431, Math.min(todayAt, now));
  deps.fileReport({
    threadId: doneToday.id,
    state: "done",
    summary: "Retry-After is in, as seconds, with tests.",
    at: Math.min(todayAt, now) - 5 * MINUTE,
  });

  // Earlier: finished on other days.
  const uv = await spawn("tooling", "Migrate to uv", "migrate-uv");
  merged(uv, 377, now - 3 * DAY);
  const py39 = await spawn("tooling", "Drop Python 3.9", "drop-py39");
  merged(py39, 352, now - 9 * DAY);
  const spike = await spawn("queue-choice", "Spike: SQS or Redis", "queue-choice");
  host.replace({ ...spike, parked: true, lastActivityAt: now - 12 * DAY });

  host.emit({ type: "orchestration.changed", workspaceId });
  return {
    ...board,
    live: live.id,
    asking: asking.id,
    doneToday: doneToday.id,
    earlier: [uv.id, py39.id, spike.id],
    held: board.working,
  };
}
