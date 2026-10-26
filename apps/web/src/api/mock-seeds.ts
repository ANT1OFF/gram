import type { MockCoreScenes, ThreadRuntime } from "./mock-thread-runtime";
import { IDENTITY, MOCK_CAPABILITIES } from "./mock-thread-runtime";
import type {
  AgentModel,
  ReviewRequest,
  GramUIMessageChunk,
  Thread,
  ThreadFeedEvent,
  ThreadId,
  ThreadSummary,
  UsageSummary,
} from "@gram/contracts";
import { longTranscript, longTurnChunks } from "@gram/contracts/testing";
import { mockGitState } from "./mock-git";
import { mockPrStateThreads } from "./mock-pr-states";
import { PROJECTS, finish, seedSummaries, start } from "./mock-scripts";

// Perf and load seeds for MockApi: busy and long threads, a turn in flight, PR states, the
// sidebar's realistic load and the Claude account's models.

/**
 * Perf hook: adds `streaming` threads that work until `stopBusyThreads`, and `idle` ones beside
 * them, spread over the seeded projects in worktrees with an open PR. Each working thread sends
 * what a real turn does at about the rate the server publishes it: a text delta every 40 ms to
 * its feed, and to every client a tool call's activity line each second, usage every 2 s and a
 * changed git state every 5 s. Timers are real time, whatever the mock's speed.
 */
export function seedBusyThreads(
  core: MockCoreScenes,
  { streaming, idle }: { streaming: number; idle: number },
): ThreadId[] {
  const [template] = seedSummaries();
  const git = mockGitState("t-flaky" as ThreadId, undefined)!;
  const batch = core.ids();
  return Array.from({ length: streaming + idle }, (_, i) => {
    const id = `t-busy-${batch}-${i}` as ThreadId;
    const project = core.projects()[i % core.projects().length]!;
    const branch = `perf/busy-${i}`;
    const runtime = core.add({
      ...template!,
      status: "idle",
      pendingRequests: [],
      queue: [],
      capabilities: MOCK_CAPABILITIES,
      identity: IDENTITY,
      git: { ...git, branch },
      thread: {
        ...template!.thread,
        id,
        projectId: project.id,
        title: `${i < streaming ? "Busy" : "Quiet"} thread ${i + 1}`,
        checkout: {
          kind: "worktree",
          path: `${project.root}/.worktrees/perf-busy-${i}`,
          branch,
          base: "main",
          repoRoot: project.root,
        },
        lastActivityAt: Date.now() - i * 60_000,
      },
    });
    core.emit({ type: "thread.upsert", thread: runtime.summary.thread });
    core.emit({ type: "git.state", threadId: id, state: runtime.summary.git! });
    core.setStatus(runtime, "idle");
    if (i < streaming) keepBusy(core, runtime, i * 37);
    return id;
  });
}

/** Ends what `seedBusyThreads` started; the threads stay, idle. */
export function stopBusyThreads(core: MockCoreScenes) {
  for (const timer of core.busy) clearInterval(timer);
  core.busy.length = 0;
  for (const runtime of core.threads.values()) {
    if (runtime.summary.thread.id.startsWith("t-busy-") && runtime.summary.status === "running") {
      core.abortInflight(runtime);
      core.setStatus(runtime, "idle");
    }
  }
}

/** One thread's endless turn, `offset` ms out of phase with the others so they don't tick as one. */
function keepBusy(core: MockCoreScenes, runtime: ThreadRuntime, offset: number) {
  const threadId = runtime.summary.thread.id;
  let messageId = "";
  let ticks = 0;
  const send = (chunk: GramUIMessageChunk) => {
    const event: ThreadFeedEvent = { type: "chunk", messageId: messageId as never, chunk };
    runtime.inflight.get(messageId)?.push(event);
    core.feed(runtime, event);
  };
  const tick = () => {
    // A new message every 20 s, so no one message grows without bound.
    if (ticks % 500 === 0) {
      if (messageId !== "") {
        send({ type: "text-end", id: "t" });
        for (const step of finish(messageId)) if (step.kind === "chunk") send(step.chunk);
        runtime.inflight.delete(messageId);
        core.update(runtime, { lastActivityAt: Date.now() });
      }
      messageId = core.ids();
      runtime.inflight.set(messageId, []);
      for (const step of start(messageId)) if (step.kind === "chunk") send(step.chunk);
      send({ type: "text-start", id: "t" });
    }
    send({ type: "text-delta", id: "t", delta: ticks % 12 === 11 ? "streams.\n\n" : "word " });
    if (ticks % 25 === 0) {
      core.setStatus(runtime, "running", `Reading src/module-${(ticks / 25) % 40}.ts`);
    }
    if (ticks % 50 === 0) {
      const usage: UsageSummary = {
        tokens: { inputTokens: 40_000 + ticks * 10, outputTokens: ticks * 4 },
        contextWindow: 200_000,
        contextTokens: 40_000 + ticks * 10,
      };
      runtime.summary = { ...runtime.summary, usage };
      core.emit({ type: "thread.usage", threadId, usage });
    }
    if (ticks % 125 === 0) {
      const state = { ...runtime.summary.git!, changedFiles: (ticks / 125) % 9 };
      runtime.summary = { ...runtime.summary, git: state };
      core.emit({ type: "git.state", threadId, state });
    }
    ticks++;
  };
  const starter = setTimeout(() => {
    core.busy.push(setInterval(tick, 40));
  }, offset);
  core.busy.push(starter);
}

/** Perf hook: adds `count` idle threads with `turns` generated turns each; returns their ids. */
export function seedLongThreads(
  core: MockCoreScenes,
  { count, turns }: { count: number; turns: number },
): ThreadId[] {
  const [template] = seedSummaries();
  const batch = core.ids();
  return Array.from({ length: count }, (_, i) => {
    const id = `t-long-${batch}-${i}` as ThreadId;
    const runtime = core.add({
      ...template!,
      status: "idle",
      pendingRequests: [],
      queue: [],
      capabilities: MOCK_CAPABILITIES,
      identity: IDENTITY,
      thread: {
        ...template!.thread,
        id,
        title: `Long thread ${i + 1} (${turns} turns)`,
        lastActivityAt: Date.now() + count - i,
      },
    });
    runtime.fold.apply({ type: "messages", messages: longTranscript({ threadId: id, turns }) });
    runtime.fold.apply({ type: "caughtUp", rev: core.rev() });
    core.emit({ type: "thread.upsert", thread: runtime.summary.thread });
    core.emit({ type: "thread.status", threadId: id, status: "idle" });
    return id;
  });
}

/**
 * Perf hook: adds a running thread in the middle of a turn of `steps` agent steps, whose chunks a
 * subscriber that opens it is replayed, as the server does; returns its id.
 */
export function seedInFlightTurn(core: MockCoreScenes, { steps }: { steps: number }): ThreadId {
  const id = core.mock.seedLongThreads({ count: 1, turns: 1 })[0]!;
  const runtime = core.runtime(id);
  const messageId = `${id}-streaming`;
  const events = longTurnChunks({ messageId, steps }).map((chunk): ThreadFeedEvent => ({
    type: "chunk",
    messageId: messageId as never,
    chunk,
  }));
  runtime.inflight.set(messageId, events);
  for (const event of events) runtime.fold.apply(event);
  core.setStatus(runtime, "running");
  return id;
}

/**
 * Dev and e2e hook: a thread per state the sidebar's PR glyph draws (open, ready, checks failing,
 * changes requested, draft, merged, closed) and one with several PRs.
 */
export function seedPrStates(core: MockCoreScenes): void {
  const [template] = seedSummaries();
  const project = core.projects()[0]!;
  const at = Date.now();
  mockPrStateThreads().forEach(({ id, title, git, extraPrs }, i) => {
    const threadId = id as ThreadId;
    if (core.threads.has(threadId)) return;
    const runtime = core.add({
      ...template!,
      status: "idle",
      pendingRequests: [],
      queue: [],
      capabilities: MOCK_CAPABILITIES,
      identity: IDENTITY,
      git,
      thread: {
        ...template!.thread,
        id: threadId,
        projectId: project.id,
        title,
        checkout: {
          kind: "worktree",
          path: `${project.root}/.worktrees/${git.branch!.replaceAll("/", "-")}`,
          branch: git.branch!,
          base: "main",
          repoRoot: project.root,
        },
        createdAt: at - (i + 2) * 60 * 60_000,
        lastActivityAt: at - (i + 1) * 7 * 60_000,
        ...(extraPrs === undefined ? {} : { extraPrs }),
      },
    });
    core.emit({ type: "thread.upsert", thread: runtime.summary.thread });
    core.emit({ type: "git.state", threadId, state: git });
    core.setStatus(runtime, "idle");
  });
}

/**
 * Dev and e2e hook: a realistic sidebar. Three workspaces (the board scenario's busy one with its Done
 * row, one at rest, one parked), about thirty threads outside any workspace across every status,
 * and a dozen review requests.
 */
export async function seedSidebarLoad(core: MockCoreScenes): Promise<void> {
  await core.mock.simulateFinishedWork();
  const { toPark } = await core.orchestration.simulateQuietWorkspaces(
    PROJECTS.map((project) => project.id),
  );
  await core.mock.park(toPark, true);

  const [template] = seedSummaries();
  const hour = 60 * 60_000;
  const loose: {
    title: string;
    status: ThreadSummary["status"];
    hoursAgo: number;
    flags?: Partial<Pick<Thread, "parked" | "pinned" | "completedAt">>;
  }[] = [
    { title: "Migrate the CI cache", status: "error", hoursAgo: 0.3 },
    { title: "Profile the cold start", status: "running", hoursAgo: 0.05 },
    { title: "Draft the Q4 roadmap", status: "running", hoursAgo: 0.1 },
    ...[
      "Tidy the logging config",
      "Try the new router",
      "Explain the retry budget",
      "Split the settings page",
      "Audit the feature flags",
      "Look into the memory leak",
      "Port the cron jobs",
      "Rename the queue topics",
      "Check the bundle size",
    ].map((title, i) => ({ title, status: "idle" as const, hoursAgo: 2 + i * 5 })),
    ...[
      "Fix the timezone bug",
      "Add a health endpoint",
      "Write the upgrade notes",
      "Pin the Node version",
    ].map((title, i) => ({
      title,
      status: "idle" as const,
      hoursAgo: 8 + i * 9,
      flags: { completedAt: Date.now() - (8 + i * 9) * hour },
    })),
    ...[
      "Spike: WebTransport",
      "Old onboarding flow",
      "Evaluate Bun",
      "Prototype the CLI",
      "Investigate the flaky e2e",
      "Try Tailwind 5",
      "Map the legacy API",
      "Benchmark the parser",
      "Explore offline mode",
    ].map((title, i) => ({
      title,
      status: "cold" as const,
      hoursAgo: 60 + i * 30,
      flags: { parked: true },
    })),
  ];
  loose.forEach(({ title, status, hoursAgo, flags }, i) => {
    const id = `t-load-${i}` as ThreadId;
    const project = core.projects()[i % core.projects().length]!;
    const at = Date.now() - hoursAgo * hour;
    const runtime = core.add({
      ...template!,
      status,
      pendingRequests: [],
      queue: [],
      capabilities: MOCK_CAPABILITIES,
      identity: IDENTITY,
      ...(status === "running" ? { activity: "Reading src/app.ts…" } : {}),
      thread: {
        ...template!.thread,
        id,
        projectId: project.id,
        title,
        checkout: { kind: "main", path: project.root, branch: "main", base: "main" },
        createdAt: at - hour,
        lastActivityAt: at,
        ...flags,
      },
    });
    core.emit({ type: "thread.upsert", thread: runtime.summary.thread });
    core.setStatus(runtime, status);
  });

  const repos = ["example/api", "example/web", "example/platform", "example/infra"];
  const authors = ["jordan", "ola", "ingrid", "per", "sofie"];
  core.reviewRequests.append(
    Array.from({ length: 10 }, (_, i): ReviewRequest => {
      const repo = repos[i % repos.length]!;
      const number = 600 + i * 7;
      return {
        repo,
        number,
        title: `Review request ${i + 1}`,
        url: `https://github.com/${repo}/pull/${number}`,
        author: authors[i % authors.length]!,
        updatedAt: new Date(Date.now() - (i + 1) * 5 * hour).toISOString(),
        createdAt: new Date(Date.now() - (i + 2) * 24 * hour).toISOString(),
        checks: i % 3 === 0 ? "failing" : "passing",
      };
    }),
  );
  core.emit({ type: "reviewRequests.changed" });
}

/**
 * Dev and e2e hook: what the user's own Claude Code account lists from now on, as its SDK reports
 * it, such as a model it was just granted.
 */
export function seedClaudeAccountModels(core: MockCoreScenes, models: readonly AgentModel[]) {
  core.profiles.claude.models = models;
}
