// The orchestration tests' world: the real service, tools, runtimes, store and git checkouts over
// the fake agent and a fake `GitStatePublisher` a test publishes through. The database is a file,
// so a test can tear the layer down and build it again over the same rows (a restart).

import {
  DEFAULT_CHARTER,
  repoFromPrUrl,
  type Autonomy,
  type GitState,
  type OrchestratorCharter,
  type PrStatus,
  type ServerEvent,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as nodePath from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Pr, Proc, ProcLive, ProcSpawnError } from "@gram/git";
import { OrchestrationAppToolsLive } from "../app-tools/orchestration-tools.ts";
import { PrAppToolsLive } from "../app-tools/pr-tools.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { GitCheckoutLive } from "../git/checkout.ts";
import {
  LocalCheckRunner,
  LocalChecksLive,
  type LocalCheckRunnerShape,
} from "../git/local-checks.ts";
import { MergeWhenReadyLive } from "../git/merge-when-ready.ts";
import { gitPlatformTest } from "../git/platform.ts";
import { GitStatePublisher, type GitStateObserver, type PrWatch } from "../git/publisher.ts";
import { makeRepo, removeDir, run, tempDir } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import type { SqlClient } from "../platform/unstable.ts";
import { FakeAgentAdapter, FakeAgentControl, type FakeSession } from "../runtime/fake-agent.ts";
import { TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import type { AgentHosts } from "../runtime/agent-hosts.ts";
import { OrchestrationMemory } from "./memory.ts";
import { decodeOutbox } from "./outbox.ts";
import { Orchestration, OrchestrationLive } from "./service.ts";
import { ComposerPresence } from "../runtime/composer-presence.ts";
import { OrchestratorAppToolsLive } from "./tools.ts";
import { PrDependenciesLive } from "../wakes/pr-dependencies.ts";
import { ThreadWakesLive } from "../wakes/thread-wakes.ts";

/** What outlives a layer: the temp dir with the repo, the database and the memory, and the fake git states. */
export interface World {
  readonly dir: string;
  readonly repo: string;
  readonly states: Map<string, GitState>;
  /** A checkout on a different branch from its bound PR, while the bound badge remains available. */
  readonly branchPrs: Map<string, PrStatus>;
  observers: Array<GitStateObserver>;
  /** Every `gh` call the PR tools made, which here reach no GitHub. */
  readonly ghCalls: Array<ReadonlyArray<string>>;
  /** The folder each of `ghCalls` ran in. */
  readonly ghDirs: Array<string>;
  /** What `gh pr view` says of a PR by number, in whichever repo it is asked about; unknown fails. */
  readonly prHeads: Map<
    number,
    {
      readonly headRefName: string;
      readonly fork?: boolean;
      readonly state?: string;
      readonly headRefOid?: string;
    }
  >;
  /**
   * While set, every `stateFor` waits on it: a git state the service handles then holds its signal
   * fiber, so what is offered meanwhile queues behind it.
   */
  stall: Effect.Effect<void> | undefined;
  /** Runs before each event the server publishes, for a test to hold one. */
  onPublish?: ((event: ServerEvent) => Effect.Effect<void>) | undefined;
  /**
   * What GitHub says of a PR some thread waits on, by `owner/repo#N` lower-cased: `lookupPr` and
   * `watchedBadge` answer from it, and `watchedPr` publishes a new one to the observers.
   */
  readonly prBadges: Map<string, PrStatus>;
  /** Fresh provider reads at merge launch, separate from the published badge. */
  readonly freshPrReads: Array<string>;
  /** Test-only provider barriers for launch races, after the corresponding result was read. */
  prHeadRead?: Effect.Effect<void> | undefined;
  freshPrRead?: Effect.Effect<void> | undefined;
  /** A test-only barrier as `gh pr merge` starts, before it is recorded or answers. */
  mergeLaunch?: Effect.Effect<void> | undefined;
  /** What each owner of `watchPrs` last asked the sweeps to look up. */
  readonly prWatches: Map<string, ReadonlyArray<PrWatch>>;
  /**
   * Set before the server is built to give it Gram's own local checks, run by this instead of
   * `bun run check:ci`. Absent, the server has none and solo merges wait for CI.
   */
  localCheckRunner?: LocalCheckRunnerShape["run"] | undefined;
}

const prKey = (pr: { readonly repo: string; readonly number: number }) =>
  `${pr.repo.toLowerCase()}#${pr.number}`;

/** `badge` as GitHub's new answer about `pr`, handed to every observer as a watch's lookup would. */
export const watchedPr = (
  world: World,
  pr: { readonly repo: string; readonly number: number },
  badge: PrStatus,
) =>
  Effect.gen(function* () {
    world.prBadges.set(prKey(pr), badge);
    for (const observer of world.observers) {
      if (observer.onWatchedPr !== undefined) yield* observer.onWatchedPr(badge);
    }
  });

/** A temp dir holding a git repo on `main`, removed when the scope closes. */
export const makeWorld = Effect.gen(function* () {
  const dir = tempDir();
  yield* Effect.addFinalizer(() => Effect.sync(() => removeDir(dir)));
  const world: World = {
    dir,
    repo: makeRepo(dir),
    states: new Map(),
    branchPrs: new Map(),
    observers: [],
    ghCalls: [],
    ghDirs: [],
    prHeads: new Map(),
    stall: undefined,
    prBadges: new Map(),
    freshPrReads: [],
    prWatches: new Map(),
  };
  return world;
});

/** The server's event hub, running `world.onPublish` first when a test set one. */
const hubOf = (world: World) =>
  Layer.effect(
    EventHub,
    Effect.gen(function* () {
      const hub = yield* EventHub;
      return EventHub.of({
        ...hub,
        publish: (event) =>
          Effect.suspend(() => world.onPublish?.(event) ?? Effect.void).pipe(
            Effect.andThen(hub.publish(event)),
          ),
      });
    }),
  ).pipe(Layer.provide(EventHub.layer));

const fakePublisher = (world: World) =>
  Layer.sync(GitStatePublisher, () => {
    world.observers = [];
    return {
      stateFor: (path) =>
        Effect.suspend(() => world.stall ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const state = world.states.get(path);
              const pr = world.branchPrs.get(path);
              return state === undefined || pr === undefined ? state : { ...state, pr };
            }),
          ),
        ),
      badgeFor: (thread) => Effect.sync(() => world.states.get(thread.checkout.path)?.pr),
      extraBadgesFor: () => Effect.succeed([]),
      stateForThread: (thread) => Effect.sync(() => world.states.get(thread.checkout.path)),
      reconcile: () => Effect.void,
      checksRead: () => Effect.void,
      refresh: () => Effect.void,
      sweep: Effect.void,
      sync: Effect.void,
      hold: () => Effect.succeed(Effect.void),
      observe: (observer) => Effect.sync(() => void world.observers.push(observer)),
      watchPrs: (owner, watches) => Effect.sync(() => void world.prWatches.set(owner, watches)),
      watchedBadge: (pr) => Effect.sync(() => world.prBadges.get(prKey(pr))),
      lookupPr: (_thread, pr) => Effect.sync(() => Option.some(world.prBadges.get(prKey(pr)))),
    };
  });

// The PR tools' own `Proc`, so `set_auto_merge` can be run to the end without a `gh` to answer it.
// Every checkout's `origin` is acme/app.
const fakeGh = (world: World) => {
  const fakeRun = (bin: string, args: ReadonlyArray<string>, cwd: string) => {
    if (bin === "git") {
      if (args[0] === "symbolic-ref") {
        const out = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: 2_000 });
        return {
          status: out.status ?? 1,
          stdout: out.stdout,
          stderr: out.stderr,
          truncated: false,
        };
      }
      return {
        status: 0,
        stdout: "https://github.com/acme/app.git\n",
        stderr: "",
        truncated: false,
      };
    }
    world.ghCalls.push([bin, ...args]);
    world.ghDirs.push(cwd);
    if (args[0] === "pr" && args[1] === "view" && !args.includes("--jq")) {
      const head = world.prHeads.get(Number(args[2]));
      const repo = args[args.indexOf("--repo") + 1];
      if (head === undefined) {
        return { status: 1, stdout: "", stderr: "no pull requests found", truncated: false };
      }
      const view = {
        number: Number(args[2]),
        url: `https://github.com/${repo}/pull/${args[2]}`,
        title: "t",
        headRefName: head.headRefName,
        isCrossRepository: head.fork === true,
        state: head.state ?? "OPEN",
        headRefOid: head.headRefOid ?? "h1",
      };
      return { status: 0, stdout: JSON.stringify(view), stderr: "", truncated: false };
    }
    return { status: 0, stdout: "", stderr: "", truncated: false };
  };
  return Layer.succeed(Proc, {
    run: (bin, args, { cwd }) =>
      (bin === "gh" && args[0] === "pr" && args[1] === "merge"
        ? (world.mergeLaunch ?? Effect.void)
        : Effect.void
      ).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            // As a real spawn does: nothing starts in a folder that isn't there.
            existsSync(cwd)
              ? Effect.succeed(fakeRun(bin, args, cwd))
              : Effect.fail(new ProcSpawnError({ bin, message: `spawn ${bin} ENOENT` })),
          ).pipe(
            Effect.tap(() =>
              bin === "gh" && args[0] === "pr" && args[1] === "view" && !args.includes("--jq")
                ? (world.prHeadRead ?? Effect.void)
                : Effect.void,
            ),
          ),
        ),
      ),
  });
};

/**
 * The git processes the server under test has started and not yet seen end. Module state, since
 * `settle` has no layer to ask and a test file runs one server at a time.
 */
const gitActivity = { running: 0, started: 0 };

// Every git process of the server, the service's and the worktrees' alike, counted while it runs.
const countedProc = Layer.effect(
  Proc,
  Effect.gen(function* () {
    const proc = yield* Proc;
    return {
      run: (bin, args, options) =>
        Effect.suspend(() => {
          gitActivity.running++;
          gitActivity.started++;
          return proc.run(bin, args, options);
        }).pipe(Effect.ensuring(Effect.sync(() => void gitActivity.running--))),
    };
  }),
).pipe(Layer.provide(ProcLive));

/** Gram's own local checks, when the world asks for them, over the real git of its repos. */
const localChecksOf = (world: World) =>
  (world.localCheckRunner === undefined
    ? Layer.empty
    : LocalChecksLive.pipe(
        Layer.provide(Layer.succeed(LocalCheckRunner, { run: world.localCheckRunner })),
        Layer.provide(ProcLive),
      )) as Layer.Layer<never, never, SqlClient.SqlClient | ServerConfig | ThreadStore>;

/** The server over `world`'s database file and memory root. */
export const serverLayer = (
  world: World,
  config: Partial<ServerConfigShape> = {},
  agents: Layer.Layer<AgentHosts | FakeAgentControl> = FakeAgentAdapter,
) =>
  Layer.mergeAll(
    OrchestrationAppToolsLive,
    OrchestratorAppToolsLive.pipe(Layer.provideMerge(PrDependenciesLive)),
    PrAppToolsLive.pipe(
      Layer.provideMerge(MergeWhenReadyLive.pipe(Layer.provide(fakeGh(world)))),
      Layer.provide(fakeGh(world)),
    ),
  ).pipe(
    Layer.provideMerge(OrchestrationLive),
    Layer.provideMerge(ComposerPresence.layer),
    Layer.provideMerge(localChecksOf(world)),
    Layer.provideMerge(ThreadWakesLive),
    Layer.provideMerge(OrchestrationMemory.layerAt(nodePath.join(world.dir, "memory"))),
    Layer.provideMerge(fakePublisher(world)),
    Layer.provideMerge(AppToolRegistry.layer),
    // As the server has it: the runtime reads the limits (`limitedUntil`, early releases).
    Layer.provideMerge(ThreadRuntimes.layer.pipe(Layer.provideMerge(UsageLimitReadings.layer))),
    Layer.provideMerge(GitCheckoutLive),
    Layer.provideMerge(hubOf(world)),
    Layer.provideMerge(ThreadStore.layerSqlite(nodePath.join(world.dir, "gram.db"))),
    Layer.provideMerge(agents),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(
      gitPlatformTest({
        proc: countedProc,
        pr: Layer.succeed(Pr, {
          status: (cwd, bound, _checkout, options) =>
            Effect.sync(() => {
              if (options?.fresh === true && bound !== undefined)
                world.freshPrReads.push(prKey(bound));
              return (
                (bound === undefined ? undefined : world.prBadges.get(prKey(bound))) ??
                world.states.get(cwd)?.pr ??
                (bound === undefined
                  ? undefined
                  : [...world.states.values()]
                      .map((state) => state.pr)
                      .find(
                        (badge) =>
                          badge?.number === bound.number &&
                          repoFromPrUrl(badge.url)?.toLowerCase() === bound.repo.toLowerCase(),
                      ))
              );
            }).pipe(
              Effect.tap(() =>
                options?.fresh === true ? (world.freshPrRead ?? Effect.void) : Effect.void,
              ),
            ),
          checks: () => Effect.succeed([]),
          prime: () => Effect.void,
          seenChecks: () => Effect.succeed(undefined),
          detail: () => Effect.succeed({ available: false }),
        }),
      }),
    ),
    Layer.provideMerge(ServerConfig.layer({ ...TEST_CONFIG, ...config, dataDir: world.dir })),
    Layer.orDie,
  );

export type Server = Layer.Success<ReturnType<typeof serverLayer>>;

/**
 * Runs `body` against a server built for it and torn down after: calling it twice over one world
 * is a restart. The fake agent's sessions belong to the layer, so the second run starts with none.
 */
export const withServer = <A, E>(
  world: World,
  body: Effect.Effect<A, E, Server | Scope.Scope>,
  config: Partial<ServerConfigShape> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(serverLayer(world, config));
      return yield* body.pipe(Effect.provide(context));
    }),
  );

const realPause = (ms: number) =>
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

/**
 * For a test that makes worktrees in more than one repo: some forty git processes, which a Windows
 * runner takes several times as long over, and the suite's thirty seconds leave too little room.
 */
export const GIT_HEAVY = { timeout: 90_000 } as const;

/** How long one `settle` or `waitReal` may take, in real time: well inside the test timeout, so the wait that gave up is named. */
const REAL_WAIT_MS = 20_000;

/**
 * Lets every fiber that can run do so, so "nothing more happened" means something. The service
 * works through its signals on one fiber, which at an orchestrator's turn start and end waits on
 * real git processes, so yielding alone would look before it got there. Nor would a fixed pause
 * do: a Windows runner takes several times as long over a git process, and a test that moves the
 * clock on while the service is still in one moves it past a timer that isn't armed yet, which
 * then never fires. So it returns after two rounds in a row in which no git process ran, and never
 * before three rounds.
 */
export const settle = Effect.gen(function* () {
  const deadline = Date.now() + REAL_WAIT_MS;
  let quiet = 0;
  for (let round = 0; (round < 3 || quiet < 2) && Date.now() < deadline; round++) {
    const started = gitActivity.started;
    for (let i = 0; i < 50; i++) yield* Effect.yieldNow;
    yield* realPause(15);
    quiet = gitActivity.running === 0 && gitActivity.started === started ? quiet + 1 : 0;
  }
});

/**
 * Polls on real time, since the service may be waiting on a git process; the test clock doesn't
 * move meanwhile. Bounded by the time it has taken rather than by how often it has looked, which
 * on a slow machine comes to the same number of looks in far less of the work done.
 */
export const waitReal = <A, E, R>(
  label: string,
  check: Effect.Effect<A | undefined | false, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + REAL_WAIT_MS;
    for (let i = 0; Date.now() < deadline; i++) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      for (let spin = 0; spin < 20; spin++) yield* Effect.yieldNow;
      yield* realPause(i < 100 ? 2 : 10);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

export const waitStatus = (threadId: ThreadId, status: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* waitReal(
      `status ${status}`,
      runtimes.status(threadId).pipe(Effect.map((s) => s === status)),
    );
  });

export const waitSent = (threadId: ThreadId, count: number) =>
  Effect.gen(function* () {
    const fake = yield* FakeAgentControl;
    return yield* waitReal(
      `send ${count} to ${threadId}`,
      Effect.sync(() => {
        const session = fake.sessions.findLast((s) => s.options.threadId === threadId);
        return session !== undefined && session.sent.length >= count ? session : undefined;
      }),
    );
  });

/** How many turn ends the service has counted for a worker; `undefined` when nobody is listening to it. */
const countedTurnEnds = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const thread = yield* store.getThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
    if (thread?.spawnedBy === undefined || thread.workspaceId === undefined) return undefined;
    const state = yield* store
      .getWorkspace(thread.workspaceId)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (state?.workspace.orchestratorThreadId !== thread.spawnedBy.threadId) return undefined;
    const outbox = decodeOutbox(yield* store.getOutbox(thread.workspaceId));
    return outbox.workers[threadId]?.turnEnds ?? 0;
  });

/**
 * Ends the running turn as the adapter would, and waits for the thread to be idle again. For a
 * worker it also waits until the service has heard of it, so a test that moves the clock next
 * moves it over a window that is already open.
 */
export const completeTurn = (session: FakeSession, text?: string) =>
  Effect.gen(function* () {
    const { threadId } = session.options;
    const before = yield* countedTurnEnds(threadId);
    yield* session.completeTurn(text);
    yield* waitStatus(threadId, "idle");
    if (before !== undefined) {
      yield* waitReal(
        "the service to hear of the turn end",
        countedTurnEnds(threadId).pipe(
          Effect.map((count) => count === undefined || count > before),
        ),
      );
    }
    yield* settle;
  });

/** The project of `world.repo`. */
export const openProject = (world: World) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return yield* store.ensureProject({ root: world.repo, name: "shop" });
  });

/**
 * A workspace at `publish` with no models of its own, the charter these tests were written
 * against: a new one starts at `full`, where nothing asks and so there is no gate to test.
 */
const atPublish = (state: WorkspaceState) =>
  Effect.gen(function* () {
    const orchestration = yield* Orchestration;
    yield* orchestration.setCharter(state.workspace.id, {
      ...DEFAULT_CHARTER,
      autonomy: "publish",
    });
  });

/** An orchestrator whose boot digest the agent has taken, idle, in a workspace at `publish`. */
export const openOrchestrator = (world: World) =>
  Effect.gen(function* () {
    const project = yield* openProject(world);
    const orchestration = yield* Orchestration;
    yield* atPublish(
      yield* orchestration.saveWorkspace({
        name: project.name,
        projectIds: [project.id],
        homeProjectId: project.id,
      }),
    );
    const thread = yield* orchestration.open({ projectId: project.id });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    return { project, thread, session, workspaceId: thread.workspaceId as WorkspaceId };
  });

/**
 * Moves the workspace to another level of autonomy and waits for the orchestrator's session to be
 * reopened under it, idle: the one to call tools through from then on. The level has to differ
 * from the one in force, or nothing reopens.
 */
export const atAutonomy = (
  orchestrator: Thread,
  autonomy: Autonomy,
  charter: Partial<OrchestratorCharter> = {},
) =>
  Effect.gen(function* () {
    const orchestration = yield* Orchestration;
    const fake = yield* FakeAgentControl;
    const opened = () => fake.sessions.filter((s) => s.options.threadId === orchestrator.id);
    const before = opened().length;
    yield* orchestration.setCharter(orchestrator.workspaceId as WorkspaceId, {
      ...DEFAULT_CHARTER,
      ...charter,
      autonomy,
    });
    const session = yield* waitReal(
      `the orchestrator's session at ${autonomy}`,
      Effect.sync(() => (opened().length > before ? opened().at(-1) : undefined)),
    );
    yield* waitStatus(orchestrator.id, "idle");
    yield* settle;
    return session;
  });

/**
 * An orchestrator over two repos, booted and idle: `shop` (its home, `world.repo`) and a second
 * repo, `warehouse`, whose `origin` names `acme/warehouse` so a PR there can be matched to it.
 */
export const openOrchestratorAcross = (world: World) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const orchestration = yield* Orchestration;
    const project = yield* openProject(world);
    const root = makeRepo(nodePath.join(world.dir, "other"));
    run(root, "remote", "add", "origin", "https://github.com/acme/warehouse.git");
    // A new worktree fetches its base from `origin` first, which would be github.com from a unit
    // test: four round trips here, each refused, and on Windows by way of the credential manager.
    // Rewritten to a path with nothing at it the fetch fails at once and offline, while
    // `remote.origin.url` still reads as the GitHub repo.
    const nowhere = `${nodePath.join(world.dir, "no-remote").replaceAll("\\", "/")}/`;
    run(root, "config", `url.${nowhere}.insteadOf`, "https://github.com/");
    const other = yield* store.ensureProject({ root, name: "warehouse" });
    const state = yield* orchestration.saveWorkspace({
      name: "platform",
      projectIds: [project.id, other.id],
      homeProjectId: project.id,
    });
    yield* atPublish(state);
    const thread = yield* orchestration.open({ workspaceId: state.workspace.id });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    return { project, other, thread, session, workspaceId: state.workspace.id };
  });

/** Spawns a worker through the orchestrator's own tool and waits for its brief to be sent. */
export const spawn = (
  orchestrator: FakeSession,
  input: { readonly feature: string; readonly title?: string } & Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const result = (yield* orchestrator.callTool("spawn_worker", {
      project: "shop",
      title: input.title ?? `Build ${input.feature}`,
      brief: `Do the ${input.feature} work.`,
      ...input,
    })) as { readonly threadId: ThreadId; readonly warning?: string };
    const session = yield* waitSent(result.threadId, 1);
    return { result, session, thread: yield* store.getThread(result.threadId) };
  });

/** `publishGit` without waiting for the service to handle it. */
export const offerGit = (world: World, thread: Thread, state: Partial<GitState>) =>
  Effect.gen(function* () {
    const full: GitState = {
      repo: true,
      worktree: thread.checkout.kind === "worktree",
      head: "a".repeat(40),
      changesToken: "t0",
      changedFiles: 0,
      behindBase: 0,
      aheadBase: 0,
      conflicts: false,
      ...state,
    };
    world.states.set(thread.checkout.path, full);
    for (const observer of world.observers) yield* observer.onState(thread, full);
  });

/** Publishes a git state for a thread's checkout the way the real publisher would. */
export const publishGit = (world: World, thread: Thread, state: Partial<GitState>) =>
  offerGit(world, thread, state).pipe(Effect.andThen(settle));

/**
 * Holds the service's signal fiber in its handling of a git state for `worker`, until the effect it
 * returns is run, so whatever is offered meanwhile queues behind it the way it does under load.
 */
export const stallGit = (world: World, worker: Thread) =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    let stalled = 0;
    world.stall = Effect.sync(() => void stalled++).pipe(Effect.andThen(Deferred.await(gate)));
    yield* offerGit(world, worker, {});
    yield* waitReal(
      "the signal fiber to stall",
      Effect.sync(() => stalled > 0),
    );
    return Effect.suspend(() => {
      world.stall = undefined;
      return Deferred.succeed(gate, undefined);
    }).pipe(Effect.asVoid);
  });

export const prBadge = (overrides: Partial<PrStatus> = {}): PrStatus => ({
  number: 12,
  state: "OPEN",
  url: "https://github.com/acme/shop/pull/12",
  title: "t",
  isDraft: false,
  checks: "pending",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: "a".repeat(40),
  mergeState: "BLOCKED",
  ...overrides,
});

export const outboxOf = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return decodeOutbox(yield* store.getOutbox(workspaceId));
  });

/** Collects server events of the types named until the scope closes. */
export const collectEvents = (types: ReadonlyArray<ServerEvent["type"]>) =>
  Effect.gen(function* () {
    const hub = yield* EventHub;
    const seen: Array<ServerEvent> = [];
    yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
      Stream.filter((event) => types.includes(event.type)),
      Stream.runForEach((event) => Effect.sync(() => void seen.push(event))),
      Effect.forkScoped,
    );
    yield* settle;
    return seen;
  });
