// Shared fixtures for the PR app tool tests, which are split across files so they run side by side.
import { afterAll, expect } from "@effect/vitest";
import { MAX_RUN_WATCHES, type PrStatus, type ProjectId } from "@gram/contracts";
import { Pr, Proc } from "@gram/git";
import { captureLogs } from "@gram/agents/testing/logs";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { spawnSync } from "node:child_process";
import { gitPlatformTest } from "../git/platform.ts";
import { MergeWhenReadyLive } from "../git/merge-when-ready.ts";
import { GitStatePublisherLive } from "../git/publisher.ts";
import { RunMonitorLive } from "../git/run-monitor.ts";
import { makeRepo, removeDir, tempDir } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { type FakeAgentControlShape } from "../runtime/fake-agent.ts";
import { RuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  atAutonomy,
  completeTurn,
  openOrchestrator,
  publishGit,
  spawn,
  waitReal,
  type World,
} from "../orchestration/test-harness.ts";
import { Orchestration } from "../orchestration/service.ts";
import { PrAppToolsLive } from "./pr-tools.ts";
import { AppToolRegistry } from "./registry.ts";

export const current: {
  badge: PrStatus | undefined;
  fresh?: (() => PrStatus | undefined) | undefined;
} = {
  badge: undefined,
};
export const ghCalls: Array<ReadonlyArray<string>> = [];
/** The directory each of `ghCalls` ran in. */
export const ghDirs: Array<string> = [];
export type GhReply = { readonly status: number; readonly stdout: string; readonly stderr: string };
export const ok: GhReply = { status: 0, stdout: "", stderr: "" };
/** What the fake `gh` answers a call with; every call succeeds with no output unless a test says. */
export const gh: { answer: (args: ReadonlyArray<string>) => GhReply } = { answer: () => ok };

export const badge = (overrides: Partial<PrStatus> = {}): PrStatus => ({
  number: 7,
  state: "OPEN",
  url: "https://github.com/acme/web/pull/7",
  title: "t",
  isDraft: false,
  checks: "pending",
  headMatches: true,
  aheadOfPr: false,
  ...overrides,
});

const MockPr = Layer.succeed(Pr, {
  status: (_cwd, _bound, _checkout, options?: { fresh?: boolean | undefined }) =>
    Effect.sync(() =>
      options?.fresh === true && current.fresh !== undefined ? current.fresh() : current.badge,
    ),
  checks: () => Effect.succeed([]),
  prime: () => Effect.void,
  seenChecks: () => Effect.succeed(undefined),
  detail: () => Effect.succeed({ available: true }),
});

const FakeGh = Layer.succeed(Proc, {
  run: (bin, args, { cwd }) =>
    Effect.sync(() => {
      // Git is the real one, so a checkout's `origin` reads as it would.
      if (bin === "git") {
        const out = spawnSync(bin, args, { cwd, encoding: "utf8" });
        return {
          status: out.status ?? 1,
          stdout: out.stdout,
          stderr: out.stderr,
          truncated: false,
        };
      }
      ghCalls.push([bin, ...args]);
      ghDirs.push(cwd);
      return { ...gh.answer(args), truncated: false };
    }),
});

// Approvals, turns and merges log as they go; a warning would be news.
const quietLogs = captureLogs({ printWarnings: true }).layer;

export const TestLayer = PrAppToolsLive.pipe(
  Layer.provide(FakeGh),
  Layer.provideMerge(GitStatePublisherLive),
  Layer.provideMerge(RuntimeTestLayer),
  Layer.provideMerge(gitPlatformTest({ pr: MockPr })),
  Layer.provideMerge(quietLogs),
);

/** A `gh pr merge` call on acme/web. */
export const mergeCall = (number: string, ...rest: Array<string>) => [
  "gh",
  "pr",
  "merge",
  number,
  ...rest,
  "--repo",
  "acme/web",
];
/** A `gh pr view` of one field of acme/web#7. */
export const viewCall = (field: string) => [
  "gh",
  "pr",
  "view",
  "7",
  "--json",
  field,
  "--jq",
  `.${field}`,
  "--repo",
  "acme/web",
];
/** A gh call's command, `pr merge` or `pr view`. */
export const command = (args: ReadonlyArray<string>) => args.slice(0, 2).join(" ");

// Deleted once the layer has shut down: on Windows a live checkout watcher holds the tree.
const dirs: Array<string> = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

/** A thread in a temp repo, with its tools as the in-process host and the HTTP transport see them. */
export const liveThread = Effect.gen(function* () {
  const dir = tempDir();
  dirs.push(dir);
  const repo = makeRepo(dir);
  const runtimes = yield* ThreadRuntimes;
  const registry = yield* AppToolRegistry;
  const store = yield* ThreadStore;
  yield* store.updateSettings((settings) => ({
    ...settings,
    reviewBots: [
      {
        loginPattern: "example-code-review[bot]",
        rereviewCommand: "/agent review",
        canApprove: true,
      },
    ],
  }));
  const thread = yield* runtimes.create({
    projectRoot: repo,
    checkout: { kind: "main", path: repo },
  });
  yield* Effect.addFinalizer(() => runtimes.close(thread.id).pipe(Effect.ignore));
  const pick = (gated: boolean, name: string) => {
    const tools = gated ? registry.forTransport(thread.id) : registry.forThread(thread.id);
    const tool = tools.find((t) => t.descriptor.name === name);
    if (tool === undefined) throw new Error(`no app tool ${name}`);
    return tool;
  };
  return {
    thread,
    hosted: (name: string) => pick(false, name),
    transport: (name: string) => pick(true, name),
  };
});

export const RunTestLayer = PrAppToolsLive.pipe(
  Layer.provideMerge(RunMonitorLive),
  Layer.provide(FakeGh),
  Layer.provideMerge(GitStatePublisherLive),
  Layer.provideMerge(RuntimeTestLayer),
  Layer.provideMerge(
    gitPlatformTest({ pr: MockPr, config: { runPollInterval: Duration.hours(1) } }),
  ),
  Layer.provideMerge(quietLogs),
);

/** The monitor's own reads of the thread store, through `CountedStore`. */
export const monitorReads = { lists: 0, gets: 0 };
const CountedStore = Layer.effect(
  ThreadStore,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return ThreadStore.of({
      ...store,
      listThreads: Effect.suspend(() => {
        monitorReads.lists++;
        return store.listThreads;
      }),
      getThread: (id) =>
        Effect.suspend(() => {
          monitorReads.gets++;
          return store.getThread(id);
        }),
    });
  }),
);

/** The monitor with its own loop running every 20 ms, and its store reads counted. */
export const RunLoopTestLayer = PrAppToolsLive.pipe(
  Layer.provideMerge(RunMonitorLive.pipe(Layer.provide(CountedStore))),
  Layer.provide(FakeGh),
  Layer.provideMerge(GitStatePublisherLive),
  Layer.provideMerge(RuntimeTestLayer),
  Layer.provideMerge(
    gitPlatformTest({ pr: MockPr, config: { runPollInterval: Duration.millis(20) } }),
  ),
  Layer.provideMerge(quietLogs),
);

/** The `gh api` lookups of run `id` itself, not its jobs. */
export const viewsOf = (id: number) =>
  ghCalls.filter((call) => call[1] === "api" && call[2]?.endsWith(`/actions/runs/${id}`)).length;

/** The texts the fake agent was sent on `threadId`'s sessions. */
export const sentTo = (fake: FakeAgentControlShape, threadId: string) =>
  fake.sessions
    .filter((session) => session.options.threadId === threadId)
    .flatMap((session) => session.sent.map((input) => input.text));

/** The REST API's JSON for run `id`. */
export const runJson = (id: number, status: string, conclusion: string | null = null) => ({
  id,
  status,
  conclusion,
  name: "release",
  display_title: "v0.8.0-rc.1",
  html_url: `https://github.com/acme/web/actions/runs/${id}`,
  head_branch: "main",
});

/** A full set of watches on acme/web, numbered from `from`. */
export const watches = (from: number) =>
  Array.from({ length: MAX_RUN_WATCHES }, (_, i) => ({
    repo: "acme/web",
    runId: from + i,
    since: 1,
  }));

export const MergeTestLayer = PrAppToolsLive.pipe(
  Layer.provideMerge(MergeWhenReadyLive),
  Layer.provide(FakeGh),
  Layer.provideMerge(GitStatePublisherLive),
  Layer.provideMerge(RuntimeTestLayer),
  Layer.provideMerge(gitPlatformTest({ pr: MockPr })),
  Layer.provideMerge(quietLogs),
);

/** A badge the bot approved on its head, green and clean: ready to merge. */
export const ready = (overrides: Partial<PrStatus> = {}) =>
  badge({
    checks: "passing",
    mergeState: "CLEAN",
    headRefOid: "h1",
    review: {
      bots: ["example-code-review"],
      reviewedHead: true,
      roundInFlight: false,
      verdictOnHead: "approved",
      verdictOnHeadBy: "example-code-review",
      threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0 },
    },
    ...overrides,
  });

/** The armed worker's PR while waiting for checks, or approved and ready. */
export const armedWorkerBadge = (approved: boolean) =>
  ready({
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    ...(approved ? {} : { checks: "pending" }),
  });

/** A real per-call card approves a recovery PR whose historical branch the worker never held. */
export const approvedRecovery = (world: World, method: "squash" | "rebase" = "squash") =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const runtimes = yield* ThreadRuntimes;
    const registry = yield* AppToolRegistry;
    const root = yield* openOrchestrator(world);
    const worker = yield* spawn(root.session, { feature: "recovery-integration" });
    yield* completeTurn(worker.session);
    yield* atAutonomy(root.thread, "full", { mergeReviewPolicy: "bot" });
    yield* store.updateSettings((settings) => ({
      ...settings,
      reviewBots: [
        {
          loginPattern: "example-code-review[bot]",
          rereviewCommand: "/agent review",
          canApprove: true,
        },
      ],
    }));
    world.prHeads.set(12, { headRefName: "codex/historical-user-branch" });
    yield* registry
      .forThread(worker.thread.id, "worker")
      .find((t) => t.descriptor.name === "pr_bind")!
      .run({ repo: "acme/app", number: 12 });
    yield* publishGit(world, worker.thread, { pr: armedWorkerBadge(false) });
    const merge = registry
      .forTransport(root.thread.id, "orchestrator")
      .find((t) => t.descriptor.name === "merge_when_ready")!;
    const input = { threadId: worker.thread.id, method, hold: "independent review" };
    expect(yield* merge.delegatedAtFullAutonomy!(input)).toBe(false);
    const call = yield* Effect.forkScoped(merge.run(input));
    const card = yield* waitReal(
      "recovery merge approval",
      store.listRequests(root.thread.id).pipe(Effect.map((all) => all[0])),
    );
    expect(card).toMatchObject({ displayName: "merge_when_ready", scopes: ["once"] });
    yield* runtimes.respond(root.thread.id, card.id, {
      kind: "approval",
      decision: "allow",
      scope: "once",
    });
    yield* Fiber.join(call);
    return { root, worker, merge, input: { threadId: worker.thread.id, release: true } };
  });

export const otherRecoveryRoot = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const orchestration = yield* Orchestration;
    const state = yield* orchestration.saveWorkspace({
      name: "Other recovery workspace",
      projectIds: [projectId],
      homeProjectId: projectId,
    });
    const thread = yield* orchestration.open({ workspaceId: state.workspace.id });
    return { thread, workspaceId: state.workspace.id };
  });
