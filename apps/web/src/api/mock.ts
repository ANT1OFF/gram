import type {
  CompactionActivity,
  GitState,
  HeldBrief,
  LimitWait,
  ThreadError,
  ThreadRecap,
  PlanEdit,
  PlanItem,
  PlanStepId,
  ThreadPlan,
  RespondManyResult,
  SettingsPatch,
  McpTarget,
  RestartMidTurn,
  SessionRestartReason,
  RestartSessionResult,
  StartSessionResult,
  RestoreWorktreeResult,
  BackgroundOutput,
  BackgroundTask,
  ClosedThread,
  ReopenedClosedThread,
  PanelKind,
  TerminalProcess,
  AgentModel,
  ModelRef,
  PendingRequest,
  PermissionMode,
  Project,
  PrStatus,
  QueueItemId,
  RequestAnswer,
  RequestId,
  OwnPr,
  ReviewRequest,
  GramUIMessage,
  GramUIMessageChunk,
  MessageId,
  TaskId,
  Thread,
  ThreadFeedEvent,
  ThreadHistoryPage,
  ThreadId,
  ThreadLabels,
  ThreadSearchResult,
  ThreadSummary,
  UserInput,
  WorkspaceId,
  AskInput,
  WorkerQuestion,
} from "@gram/contracts";
import {
  effectiveCheckout,
  mcpTargetOf,
  normalizeThreadPrs,
  NotFound,
  ThreadNotFound,
  FEED_WINDOW_TURNS,
  recentTurns,
  applyUserEdit,
  withoutCompletion,
} from "@gram/contracts";

import { createThreadFeed, syncScheduler } from "@/stores/thread-feed";

import { createChannel, type Channel } from "./channel";
import { createConnectionMonitor, resubscribing } from "./connection";
import { isThreadNotFound } from "./errors";
import { MOCK_DEPS_RECAP } from "./mock-assist";
import { createMockBabysit } from "./mock-babysit";
import {
  createMockOrchestration,
  type MockBoardSimulation,
  type MockFinishedSimulation,
  type MockReleaseSimulation,
  type MockQuietBusySimulation,
  type MockWaitsSimulation,
  type MockOrchestrationScenario,
  type MockOrchestrationSimulation,
  type MockStageTarget,
  type MockClosedWorker,
  type MockReopenFields,
} from "./mock-orchestration";
import {
  type MockAsksSimulation,
  type MockFailuresSimulation,
  type MockOneThreadSimulation,
} from "./mock-asks";
import type { MockReachingSimulation } from "./mock-reaching";
import type { MockWorkersSimulation } from "./mock-workers";

import { createMockClosedThreads } from "./mock-closed";
import { createMockDreams } from "./mock-dreams";
import { createAgentRuntimeMock } from "./agent-runtime/mock";
import { agentSupportMock } from "./agent-support/mock";
import { createAppMock } from "./app/mock";
import { createBranchesMock } from "./branches/mock";
import { createComposerMock } from "./composer/mock";
import { createConnectorsMock } from "./connectors/mock";
import { createPrPeopleMock } from "./pr-people/mock";
import { createOrchestrationMock } from "./orchestration/mock";
import { createProfilesMock } from "./profiles/mock";
import { createProjectsMock } from "./projects/mock";
import { createPullRequestsMock } from "./pull-requests/mock";
import { createReviewRequestsMock } from "./review-requests/mock";
import { createSessionsMock } from "./sessions/mock";
import { createSettingsMock } from "./settings/mock";
import { createAgentBrowseMock } from "./mock-agent-browse";
import { createSpeechMock } from "./speech/mock";
import { createDreamsMock } from "./dreams/mock";
import { createFilesMock } from "./files/mock";
import { createLabelsMock } from "./labels/mock";
import { createKeybindingsMock } from "./keybindings/mock";
import { createTerminalMock } from "./terminal/mock";
import { createThreadWakesMock } from "./thread-wakes/mock";
import { createWaitsMock } from "./mock-waits";
import { createLimitsMock } from "./mock-limits";
import {
  seedBusyThreads,
  stopBusyThreads,
  seedLongThreads,
  seedInFlightTurn,
  seedPrStates,
  seedSidebarLoad,
  seedClaudeAccountModels,
} from "./mock-seeds";
import {
  simulateRequest,
  simulateQueued,
  simulateLastActivity,
  simulateTurnPlan,
  simulatePlan,
  simulateBackground,
  simulateBackgroundOutput,
  simulateMessage,
  simulateChunks,
  simulateStatus,
  simulateTurnError,
  simulateLimitWait,
  simulateLimitCleared,
  simulateTerminalProcesses,
  simulatePorts,
  simulateWrittenFile,
  simulateShowPanel,
} from "./mock-thread-sims";
import {
  simulateAddRepoRequest,
  simulateAskUser,
  simulateCloseQuestion,
  simulateAsks,
  simulateFinishedWork,
  simulateLiveCards,
  simulateWorkers,
  simulateOneThread,
  simulateReachingWorkers,
  simulateWorkerQuestions,
  simulateQuietBusy,
  simulateWorkerWaits,
  simulateReleaseGroup,
  simulateArchivedGroups,
  simulateMissingFolder,
  simulateUnpushed,
  simulateFailures,
  simulateChecks,
  simulateRecap,
  simulateReviewRequest,
  replacePrLists,
  simulateOpenPr,
} from "./mock-scenarios";
import {
  IDENTITY,
  MOCK_CAPABILITIES,
  identityFor,
  type MockCoreScenes,
  type MockFeedEvent,
  type ThreadRuntime,
} from "./mock-thread-runtime";
import type { ThreadsApi } from "./threads/types";
import { createWorktreesMock, PENDING_RULES } from "./worktrees/mock";
import type { DataPart, MockWorld } from "./mock-world";
import { isMockRepo, MockInvalidState, mockProject, resolveMockFolder } from "./mock-fs";
import { MockPreview } from "./mock-preview";
import { mockAgents, mockSessionExpired, mockStartsWithBoard } from "./mock-overrides";
import { mockGitState, mockPrDetail } from "./mock-git";
import { searchMessages } from "./mock-search";
import {
  AUTOPLAY,
  PROJECTS,
  backgroundSubagentScript,
  compactScript,
  docsScript,
  echoScript,
  flakyScript,
  isCompactCommand,
  modelCommand,
  modelSwitchedScript,
  orchestratorScript,
  planAnswered,
  questionAnswered,
  seedMessages,
  seedSummaries,
  type Script,
  type Step,
} from "./mock-scripts";
import type {
  Api,
  ApiServerEvent,
  ApiThreadFeedEvent,
  FeedResume,
  CloseThreadOptions,
  CreateThreadInput,
  ForkThreadOptions,
  SearchThreadsOptions,
} from "./types";

export interface MockApiOptions {
  /** Multiplier for scripted delays; 0 runs scripts as fast as the event loop allows. */
  speed?: number;
  /** Start scripted turns when a seeded thread is first opened. */
  autoplay?: boolean;
  /** Agents with a registered adapter; `models.list` fails for the others. Claude by default. */
  agents?: readonly AgentKindOption[];
  /** Keeps closed threads in `localStorage` across page loads, as the server keeps them. */
  persist?: boolean;
}

type AgentKindOption = Parameters<Api["listModels"]>[0];

class Interrupted extends Error {}

const stampSubagentStart = (
  starts: Map<string, number>,
  chunk: GramUIMessageChunk,
): GramUIMessageChunk => {
  if (chunk.type !== "data-subagent-usage" || chunk.data.startedAt !== undefined) return chunk;
  const { toolCallId } = chunk.data;
  const startedAt = starts.get(toolCallId) ?? Date.now();
  starts.set(toolCallId, startedAt);
  return { ...chunk, data: { ...chunk.data, startedAt } };
};

/** The `messages` head the server sends for `messages`: their last `FEED_WINDOW_TURNS` turns. */
const windowed = (messages: readonly GramUIMessage[]): ThreadFeedEvent => {
  const recent = recentTurns(messages, FEED_WINDOW_TURNS);
  return {
    type: "messages",
    messages: [...recent.messages],
    ...(recent.earlier ? { earlier: true } : {}),
  };
};

/** The server's `samePath` without the filesystem: separators, trailing slashes and case. */
const pathKey = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

const SCRIPTS: Record<string, Script> = {
  "t-flaky": flakyScript,
  "t-docs": docsScript,
  "t-background": backgroundSubagentScript,
};

/** Points a draft's staged attachments at the new thread's folder, as the server moves them there. */
const adoptDraft = (
  input: UserInput,
  draftId: string | undefined,
  threadId: ThreadId,
): UserInput => {
  if (draftId === undefined || input.attachments === undefined) return input;
  const staged = `/mock/attachments/_drafts/${draftId}/`;
  const attachments = input.attachments.map((attachment) =>
    attachment.path.startsWith(staged)
      ? {
          ...attachment,
          path: `/mock/attachments/${threadId}/${attachment.path.slice(staged.length)}`,
        }
      : attachment,
  );
  return { ...input, attachments };
};

/** The mock's own state and the threads slice; `createMockApi` adds every other domain's slice. */
export class MockCore implements Pick<Api, "kind" | "connection">, ThreadsApi {
  readonly kind = "mock";
  readonly #speed: number;
  readonly #threads = new Map<string, ThreadRuntime>();
  readonly #events = new Set<Channel<ApiServerEvent>>();
  readonly #waiters = new Map<string, (answer: RequestAnswer) => void>();
  /** Scripts held at a gate, by gate name. */
  readonly #gates = new Map<string, () => void>();
  /** Gates released before a script reached them. */
  readonly #released = new Set<string>();
  /**
   * Threads whose folder `simulateMissingFolder` deleted, by id, with the PR that can bring back a
   * branch gone everywhere (`branchGone`).
   */
  readonly #missingFolders = new Map<string, { branchGone?: { repo: string; number: number } }>();
  readonly #autoplay: Map<string, string>;
  #seq = 0;
  #projects: Project[] = [...PROJECTS];
  readonly #profiles: ReturnType<typeof createProfilesMock>;
  readonly #closed: ReturnType<typeof createMockClosedThreads>;
  readonly #composer: ReturnType<typeof createComposerMock>;

  constructor(options: MockApiOptions = {}) {
    this.#speed = options.speed ?? 1;
    const agents = options.agents ?? mockAgents();
    this.#profiles = createProfilesMock(this.world, agents);
    this.#autoplay = new Map(options.autoplay === false ? [] : Object.entries(AUTOPLAY));
    this.#closed = createMockClosedThreads(options.persist === true);
    this.#composer = createComposerMock(this.world, options.persist === true);
    const closedEarlier = this.#closed.ids();
    for (const summary of seedSummaries()) {
      if (closedEarlier.has(summary.thread.id)) continue;
      // `t-flaky`'s worktree has uncommitted work, so closing it with removal needs a force.
      const git = mockGitState(
        summary.thread.id,
        this.#pullRequests.reviewState(summary.thread.id),
      );
      // Sessions that have run report their identity; cold ones haven't started yet.
      const runtime = this.#add({
        ...summary,
        capabilities: MOCK_CAPABILITIES,
        ...(summary.status === "cold" ? {} : { identity: IDENTITY }),
        ...(git ? { git } : {}),
      });
      // `messages` starts a subscription in the fold, so it's caught up again afterwards.
      runtime.fold.apply({ type: "messages", messages: seedMessages(summary.thread.id) });
      runtime.fold.apply({ type: "caughtUp", rev: this.#rev });
    }
    // Seeded pending requests resume the conversation when answered.
    this.#waiters.set(
      "r-question",
      (answer) =>
        void this.#continue("t-question" as ThreadId, questionAnswered(answer, this.#ids)),
    );
    this.#waiters.set(
      "r-plan",
      (answer) => void this.#continue("t-plan" as ThreadId, planAnswered(answer, this.#ids)),
    );
  }

  /** The core's threads and pace, for the domain slices. */
  readonly world: MockWorld = {
    delay: (ms) => this.#delay(ms),
    summary: (threadId) => this.#runtime(threadId).summary,
    threads: () => [...this.#threads.values()].map((runtime) => runtime.summary),
    messages: (threadId) => this.#runtime(threadId).fold.store.getState().messages,
    settled: (threadId) => this.#runtime(threadId).fold.whenSettled(),
    running: (threadId) => this.#runtime(threadId).running,
    send: (threadId, input) => this.send(threadId, input),
    steer: (threadId, input) => this.steer(threadId, input),
    projects: () => this.#projects,
    updateProjects: (update) => {
      this.#projects = update(this.#projects);
    },
    ids: () => this.#ids(),
    gate: async (name) => {
      if (this.#released.delete(name)) return;
      await new Promise<void>((resolve) => this.#gates.set(name, resolve));
    },
    replaceThread: (thread) => this.#replaceThread(thread),
    publishGit: (threadId, state) => {
      const runtime = this.#runtime(threadId);
      runtime.summary = { ...runtime.summary, git: state };
      this.#emit({ type: "git.state", threadId, state });
    },
    publishLapsedConnectors: (threadId, names) => {
      const runtime = this.#runtime(threadId);
      const { lapsedConnectors: _previous, ...rest } = runtime.summary;
      runtime.summary = names.length === 0 ? rest : { ...rest, lapsedConnectors: names };
      this.#emit({ type: "thread.lapsedConnectors", threadId, names });
    },
    updateThread: (threadId, patch) => this.#update(this.#runtime(threadId), patch),
    setCodexRuntime: (source) => this.#settings.setCodexRuntime(source),
    settings: () => this.#settings.get(),
    emit: (event) => this.#emit(event),
    setWaits: (threadId, waits, helperResolved = []) => {
      const runtime = this.#runtime(threadId);
      const { waits: _, helperResolved: _resolved, ...rest } = runtime.summary;
      const resolved = helperResolved.length === 0 ? {} : { helperResolved: [...helperResolved] };
      runtime.summary = {
        ...rest,
        ...(waits.length === 0 ? {} : { waits: [...waits] }),
        ...resolved,
      };
      this.#emit({ type: "thread.waits", threadId, waits: [...waits], ...resolved });
    },
    putDataPart: (threadId, part, messageId) => this.#putDataPart(threadId, part, messageId),
    mcpConfigChanged: (agent, folder) => this.#mcpConfigChanged(agent, folder),
  };

  /**
   * Like the server's `mcpConfigChanged`: each live thread on `agent` (in `folder`, when given) is
   * marked, and restarts once it has no turn, queue or background task.
   */
  async #mcpConfigChanged(agent: McpTarget, folder: string | undefined) {
    if ((await this.#settings.get()).agents.restartOnMcpChange === false) return;
    for (const runtime of this.#threads.values()) {
      const { thread, status } = runtime.summary;
      if (status === "cold" || mcpTargetOf(thread.model.agent) !== agent) continue;
      if (folder !== undefined && pathKey(effectiveCheckout(thread).path) !== pathKey(folder)) {
        continue;
      }
      runtime.summary = { ...runtime.summary, pendingRestart: "mcpConfig" };
      this.#emit({ type: "thread.pendingRestart", threadId: thread.id, reason: "mcpConfig" });
      await this.#restartIfPending(runtime);
    }
  }

  async #restartIfPending(runtime: ThreadRuntime) {
    const { pendingRestart, queue, background, pendingRequests, thread } = runtime.summary;
    if (pendingRestart === undefined || runtime.running) return;
    if (queue.length > 0 || (background?.length ?? 0) > 0 || pendingRequests.length > 0) return;
    const { pendingRestart: _, ...rest } = runtime.summary;
    runtime.summary = rest;
    this.#emit({ type: "thread.pendingRestart", threadId: thread.id });
    await this.#restart(runtime, pendingRestart);
  }

  #putDataPart(threadId: ThreadId, part: DataPart, messageId?: string): string {
    const runtime = this.#runtime(threadId);
    const messages = runtime.fold.store.getState().messages;
    const target =
      messageId === undefined
        ? messages.findLast((m) => m.role === "assistant")
        : messages.find((m) => m.id === messageId);
    if (target === undefined) {
      const id = `app-${this.#ids()}`;
      this.#putMessage(runtime, {
        id,
        role: "assistant",
        metadata: { createdAt: Date.now() },
        parts: [part],
      });
      return id;
    }
    const index = target.parts.findIndex(
      (p) => p.type === part.type && "id" in p && p.id === part.id,
    );
    this.#putMessage(runtime, {
      ...target,
      parts: index === -1 ? [...target.parts, part] : target.parts.with(index, part),
    });
    return target.id;
  }

  readonly #prPeople = createPrPeopleMock(this.world);

  readonly #projectsMock = createProjectsMock(this.world);

  /** The `Api` of the slices the core builds itself, because its controls reach into them. */
  ownedApis() {
    const orchestration = createOrchestrationMock(this.world, {
      orchestration: this.#orchestration,
      adoptDraft: (input, draftId, threadId) => {
        // As the server does, the draft's files move into the thread that takes the task.
        const adopted = adoptDraft(input, draftId, threadId);
        this.#composer.moveUploads(input.attachments, adopted.attachments);
        return adopted;
      },
    });
    return {
      ...this.#prPeople.api,
      ...this.#profiles.api,
      ...this.#projectsMock.api,
      ...this.#pullRequests.api,
      ...this.#composer.api,
      ...this.#waits.api,
      ...this.#waits.controls,
      ...this.#limits.controls,
      ...createDreamsMock(this.world, {
        dreams: this.#dreams,
        orchestration: this.#orchestration,
      }),
      ...orchestration,
      // A workspace the mock starts with is listed once it is there, as a relaunch would find it.
      listWorkspaces: async () => {
        await this.#startingBoard;
        return orchestration.listWorkspaces();
      },
      ...this.#reviewRequests.api,
      ...this.#settings.api,
      ...this.#worktrees.api,
    };
  }

  #ids = () => `mock-${++this.#seq}`;

  #scenesMade: MockCoreScenes | undefined;
  /** The handle `mock-seeds.ts`, `mock-thread-sims.ts` and `mock-scenarios.ts` reach the core by. */
  get #scenes(): MockCoreScenes {
    return (this.#scenesMade ??= {
      mock: this,
      threads: this.#threads,
      projects: () => this.#projects,
      rev: () => this.#rev,
      nextSeq: () => ++this.#seq,
      ids: () => this.#ids(),
      busy: [],
      missingFolders: this.#missingFolders,
      runtime: (threadId) => this.#runtime(threadId),
      add: (summary) => this.#add(summary),
      emit: (event) => this.#emit(event),
      feed: (runtime, event) => this.#feed(runtime, event),
      update: (runtime, patch) => this.#update(runtime, patch),
      setStatus: (runtime, status, detail, compaction) =>
        this.#setStatus(runtime, status, detail, compaction),
      setPlans: (runtime, patch) => this.#setPlans(runtime, patch),
      setQueue: (runtime, queue) => this.#setQueue(runtime, queue),
      setBackground: (runtime, tasks) => this.#setBackground(runtime, tasks),
      putMessage: (runtime, message) => this.#putMessage(runtime, message),
      abortInflight: (runtime) => this.#abortInflight(runtime),
      replaceThread: (edited) => this.#replaceThread(edited),
      ask: (threadId, request, onAnswer) => this.#ask(threadId, request, onAnswer),
      orchestration: this.#orchestration,
      dreams: this.#dreams,
      composer: this.#composer,
      profiles: this.#profiles,
      projectsMock: this.#projectsMock,
      pullRequests: this.#pullRequests,
      reviewRequests: this.#reviewRequests,
    });
  }

  #add(summary: ThreadSummary): ThreadRuntime {
    const fold = createThreadFeed({ scheduler: syncScheduler });
    fold.apply({ type: "caughtUp", rev: this.#rev });
    const runtime: ThreadRuntime = {
      summary,
      fold,
      inflight: new Map(),
      subagentStarts: new Map(),
      subscribers: new Set(),
      revs: new Map(),
      resetRev: 0,
      running: false,
      steer: undefined,
      interrupted: false,
      restartAfterTurn: false,
    };
    this.#threads.set(summary.thread.id, runtime);
    return runtime;
  }

  #runtime(threadId: string): ThreadRuntime {
    const runtime = this.#threads.get(threadId);
    if (!runtime) throw new ThreadNotFound({ threadId: threadId as ThreadId });
    return runtime;
  }

  /** What else hears every event: the mock's own ledger streams. */
  readonly #listeners = new Set<(event: ApiServerEvent) => void>();

  #emit(event: ApiServerEvent) {
    for (const channel of this.#events) channel.push(event);
    for (const listener of this.#listeners) listener(event);
  }

  /** The last feed revision issued, for every thread, as the server's counter. */
  #rev = 0;

  /** Stamps the revisions the server would, then applies `event` and sends it to subscribers. */
  #feed(runtime: ThreadRuntime, event: MockFeedEvent) {
    const events: ThreadFeedEvent[] = [];
    switch (event.type) {
      case "message": {
        const rev = ++this.#rev;
        runtime.revs.set(event.message.id, rev);
        events.push({ ...event, rev });
        break;
      }
      case "messages": {
        const rev = ++this.#rev;
        runtime.resetRev = rev;
        runtime.revs = new Map(event.messages.map((m) => [m.id, rev]));
        // Like the server: a live replace-all is a head of its own, ending with `caughtUp`.
        events.push(event, { type: "caughtUp", rev });
        break;
      }
      case "chunk":
        // The server stores a message as it streams; its end is the write that counts here.
        if (event.chunk.type === "finish" || event.chunk.type === "abort") {
          runtime.revs.set(event.messageId, ++this.#rev);
        }
        events.push(event);
        break;
    }
    for (const e of events) {
      runtime.fold.apply(e);
      // The mock's own fold keeps everything; subscribers get the window, as from the server.
      const sent = e.type === "messages" ? windowed(e.messages) : e;
      for (const channel of runtime.subscribers) channel.push(sent);
    }
  }

  #update(runtime: ThreadRuntime, patch: Partial<Thread>) {
    runtime.summary = { ...runtime.summary, thread: { ...runtime.summary.thread, ...patch } };
    this.#emit({ type: "thread.upsert", thread: runtime.summary.thread });
  }

  /** Like the server: every status states the compaction under way, so one without it ends it. */
  #setStatus(
    runtime: ThreadRuntime,
    status: ThreadSummary["status"],
    detail?: string,
    compaction?: CompactionActivity,
  ) {
    const { compaction: _was, ...rest } = runtime.summary;
    runtime.summary = { ...rest, status, ...(compaction === undefined ? {} : { compaction }) };
    const threadId = runtime.summary.thread.id;
    this.#emit({
      type: "thread.status",
      threadId,
      status,
      ...(detail === undefined ? {} : { detail }),
      ...(compaction === undefined ? {} : { compaction }),
    });
  }

  /** Like the server's plan writer: the summary keeps both, and `thread.plan` carries both. */
  #setPlans(
    runtime: ThreadRuntime,
    patch: {
      readonly plan?: ThreadPlan | undefined;
      readonly turnPlan?: ThreadSummary["turnPlan"] | undefined;
    },
  ) {
    const { plan: _plan, turnPlan: _turnPlan, ...rest } = runtime.summary;
    const plan = "plan" in patch ? patch.plan : runtime.summary.plan;
    const turnPlan = "turnPlan" in patch ? patch.turnPlan : runtime.summary.turnPlan;
    runtime.summary = {
      ...rest,
      ...(plan === undefined ? {} : { plan }),
      ...(turnPlan === undefined ? {} : { turnPlan }),
    };
    this.#emit({
      type: "thread.plan",
      threadId: runtime.summary.thread.id,
      items: turnPlan ?? [],
      ...(plan === undefined ? {} : { plan }),
    });
  }

  #setQueue(runtime: ThreadRuntime, queue: ThreadSummary["queue"]) {
    runtime.summary = { ...runtime.summary, queue };
    this.#emit({ type: "thread.queue", threadId: runtime.summary.thread.id, queue });
  }

  /** The session reports its identity when it first starts, as `system/init` does. */
  #ensureIdentity(runtime: ThreadRuntime) {
    if (runtime.summary.identity) return;
    const identity = identityFor(runtime.summary.thread.model);
    runtime.summary = { ...runtime.summary, identity };
    this.#emit({ type: "thread.identity", threadId: runtime.summary.thread.id, identity });
  }

  #delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms * this.#speed));
  }

  #putMessage(runtime: ThreadRuntime, message: GramUIMessage) {
    this.#feed(runtime, { type: "message", message });
  }

  async #runSteps(runtime: ThreadRuntime, steps: Step[]): Promise<void> {
    for (const step of steps) {
      if (runtime.steer || runtime.interrupted) throw new Interrupted();
      switch (step.kind) {
        case "chunk": {
          const event: ThreadFeedEvent = {
            type: "chunk",
            messageId: step.messageId as never,
            chunk: stampSubagentStart(runtime.subagentStarts, step.chunk),
          };
          const log = runtime.inflight.get(step.messageId) ?? [];
          log.push(event);
          runtime.inflight.set(step.messageId, log);
          this.#feed(runtime, event);
          if (step.chunk.type === "finish" || step.chunk.type === "abort") {
            void runtime.fold.whenSettled().then(() => runtime.inflight.delete(step.messageId));
          }
          break;
        }
        case "wait":
          await this.#delay(step.ms);
          break;
        case "gate":
          // Only a page that opted in holds; dev use and unit tests run straight through.
          if (typeof window === "undefined" || window.gramMockHoldGates !== true) break;
          if (this.#released.delete(step.name)) break;
          await new Promise<void>((resolve) => this.#gates.set(step.name, resolve));
          break;
        case "status":
          this.#setStatus(runtime, step.status, step.detail, step.compaction);
          break;
        case "plan":
          this.#setPlans(runtime, { turnPlan: step.items });
          break;
        case "background": {
          // A task keeps the start it was first listed with, as the adapter stamps it.
          const since = new Map((runtime.summary.background ?? []).map((t) => [t.taskId, t]));
          this.#setBackground(
            runtime,
            step.tasks.map((task) => ({
              ...task,
              startedAt: since.get(task.taskId)?.startedAt ?? Date.now(),
            })),
          );
          break;
        }
        case "usage":
          runtime.summary = { ...runtime.summary, usage: step.usage };
          this.#emit({
            type: "thread.usage",
            threadId: runtime.summary.thread.id,
            usage: step.usage,
          });
          break;
        case "request": {
          const threadId = runtime.summary.thread.id;
          runtime.summary = {
            ...runtime.summary,
            pendingRequests: [...runtime.summary.pendingRequests, step.request],
          };
          this.#setStatus(
            runtime,
            step.request.kind === "approval" ? "needsApproval" : "needsInput",
          );
          this.#emit({ type: "thread.request", threadId, request: step.request });
          const answer = await new Promise<RequestAnswer>((resolve) =>
            this.#waiters.set(step.request.id, resolve),
          );
          this.#setStatus(runtime, "running");
          await this.#runSteps(runtime, step.onAnswer(answer));
          break;
        }
      }
    }
  }

  /** Aborts every still-streaming message, as the server does on interrupt. */
  #abortInflight(runtime: ThreadRuntime) {
    for (const messageId of runtime.inflight.keys()) {
      this.#feed(runtime, {
        type: "chunk",
        messageId: messageId as never,
        chunk: { type: "abort", reason: "interrupted" },
      });
      runtime.inflight.delete(messageId);
    }
  }

  /** `seedBusyThreads` (`mock-seeds.ts`). */
  seedBusyThreads(options: { streaming: number; idle: number }): ThreadId[] {
    return seedBusyThreads(this.#scenes, options);
  }

  /** `stopBusyThreads` (`mock-seeds.ts`). */
  stopBusyThreads() {
    return stopBusyThreads(this.#scenes);
  }

  /** `seedLongThreads` (`mock-seeds.ts`). */
  seedLongThreads(options: { count: number; turns: number }): ThreadId[] {
    return seedLongThreads(this.#scenes, options);
  }

  /** `seedInFlightTurn` (`mock-seeds.ts`). */
  seedInFlightTurn(options: { steps: number }): ThreadId {
    return seedInFlightTurn(this.#scenes, options);
  }

  async #turn(threadId: ThreadId, input: UserInput) {
    const runtime = this.#runtime(threadId);
    this.#ensureIdentity(runtime);
    // As the server's `withWaitNote`: the user's own message tells a plain thread or a worker.
    const waitNote =
      input.origin === undefined &&
      input.notice === undefined &&
      !input.text.trimStart().startsWith("/") &&
      runtime.summary.thread.role !== "orchestrator"
        ? this.#waits.takeNote(threadId)
        : undefined;
    const id = this.#ids();
    this.#putMessage(runtime, {
      id,
      role: "user",
      metadata: { createdAt: Date.now() },
      parts: [
        { type: "text", text: input.text },
        ...(input.attachments ?? []).map((attachment) => ({
          type: "file" as const,
          mediaType: attachment.mediaType ?? "application/octet-stream",
          filename: attachment.name ?? attachment.path,
          url: `file://${attachment.path}`,
        })),
        ...(waitNote === undefined
          ? []
          : [{ type: "data-wait-note" as const, id, data: { text: waitNote } }]),
      ],
    });
    this.#update(runtime, { lastActivityAt: Date.now() });
    // The real agent runs `/model` itself and the server moves the thread's model to follow it.
    const switched = modelCommand(input.text);
    if (switched !== undefined) {
      await this.setModel(threadId, { ...runtime.summary.thread.model, model: switched });
      await this.#continue(threadId, modelSwitchedScript(switched, this.#ids));
      return;
    }
    if (isCompactCommand(input.text)) {
      await this.#continue(threadId, compactScript(runtime.summary.usage, this.#ids));
      return;
    }
    // A seeded thread plays its script on the first turn; later turns get the echo reply.
    const answered = runtime.fold.store.getState().messages.some((m) => m.role === "assistant");
    const script =
      (!answered && SCRIPTS[threadId]) ||
      (runtime.summary.thread.role === "orchestrator" &&
      input.origin === undefined &&
      input.notice === undefined
        ? orchestratorScript
        : echoScript);
    await this.#continue(threadId, script(input, this.#ids));
  }

  async #continue(threadId: ThreadId, steps: Step[]) {
    const runtime = this.#runtime(threadId);
    runtime.running = true;
    try {
      await this.#runSteps(runtime, steps);
    } catch (error) {
      if (!(error instanceof Interrupted)) throw error;
      this.#abortInflight(runtime);
    } finally {
      runtime.running = false;
    }
    const steer = runtime.steer;
    const interrupted = runtime.interrupted;
    runtime.steer = undefined;
    runtime.interrupted = false;
    this.#setStatus(runtime, "idle");
    this.#update(runtime, { lastActivityAt: Date.now() });
    if (runtime.restartAfterTurn) {
      runtime.restartAfterTurn = false;
      await this.#restart(runtime);
    }
    if (steer) return this.#turn(threadId, steer);
    const [next, ...rest] = runtime.summary.queue;
    if (next) {
      this.#setQueue(runtime, rest);
      return this.#turn(threadId, next.input);
    }
    if (!interrupted) this.#composer.suggest(threadId);
    await this.#restartIfPending(runtime);
  }

  /**
   * Has every turn of `threadId` that ends from now on come back with `replies`, the design's three
   * by default, as the server's `thread.suggestions` does for the focused thread. Off unless a spec
   * asks, since a ghost in the composer would sit under what other specs type.
   */
  simulateSuggestions(threadId: ThreadId, replies: readonly string[] = MOCK_DEPS_RECAP.replies) {
    this.#composer.armSuggestions(threadId, replies);
  }

  #queueItem(runtime: ThreadRuntime, itemId: QueueItemId) {
    if (!runtime.summary.queue.some((q) => q.id === itemId)) {
      throw new Error(`NotFound: queueItem ${itemId}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Api

  readonly #connection = createConnectionMonitor();

  /** Lets a script held at gate `name` go on; a release before the script gets there is kept. */
  release(name: string) {
    const resume = this.#gates.get(name);
    if (resume === undefined) {
      this.#released.add(name);
      return;
    }
    this.#gates.delete(name);
    resume();
  }

  /** Ends every open feed as a dropped socket would; feeds reconnect after a backoff. */
  simulateDisconnect() {
    for (const channel of this.#events) channel.close();
    for (const runtime of this.#threads.values()) {
      for (const channel of runtime.subscribers) channel.close();
    }
  }

  events(signal: AbortSignal): AsyncIterable<ApiServerEvent> {
    if (mockSessionExpired()) this.#connection.expire();
    return resubscribing((s) => this.#openEvents(s), this.#connection, signal);
  }

  threadFeed(
    threadId: ThreadId,
    signal: AbortSignal,
    resume?: () => FeedResume | undefined,
  ): AsyncIterable<ApiThreadFeedEvent> {
    return resubscribing((s) => this.#openFeed(threadId, s, resume?.()), this.#connection, signal, {
      marker: { type: "subscribed" },
      final: isThreadNotFound,
    });
  }

  async threadHistory(threadId: ThreadId, before: string): Promise<ThreadHistoryPage> {
    const { messages, earlier } = recentTurns(
      this.#runtime(threadId).fold.store.getState().messages,
      FEED_WINDOW_TURNS,
      before,
    );
    return { messages: [...messages], earlier };
  }

  #openEvents(signal: AbortSignal): AsyncIterable<ApiServerEvent> {
    const channel = createChannel<ApiServerEvent>(signal, () => this.#events.delete(channel));
    channel.push({
      type: "threads.snapshot",
      threads: [...this.#threads.values()].map((r) => r.summary),
    });
    channel.push(this.#limits.snapshot());
    this.#events.add(channel);
    return channel;
  }

  #openFeed(
    threadId: ThreadId,
    signal: AbortSignal,
    resume: FeedResume | undefined,
  ): AsyncIterable<ApiThreadFeedEvent> {
    const runtime = this.#runtime(threadId);
    const channel = createChannel<ApiThreadFeedEvent>(signal, () =>
      runtime.subscribers.delete(channel),
    );
    const inflight = runtime.inflight;
    const all = runtime.fold.store.getState().messages;
    const stored = all.filter((m) => !inflight.has(m.id));
    // Resumes as the server does: from a revision it issued, after the history was last replaced,
    // from the oldest message the client holds.
    const afterRev = resume?.afterRev;
    const from = resume?.from === undefined ? 0 : all.findIndex((m) => m.id === resume.from);
    if (
      afterRev !== undefined &&
      afterRev >= runtime.resetRev &&
      afterRev <= this.#rev &&
      from !== -1
    ) {
      const held = new Set(all.slice(from).map((m) => m.id));
      const changed = stored.filter(
        (m) => held.has(m.id) && (runtime.revs.get(m.id) ?? 0) > afterRev,
      );
      channel.push({ type: "resumed", messages: changed });
    } else {
      channel.push(windowed(stored));
    }
    for (const events of inflight.values()) for (const event of events) channel.push(event);
    channel.push({ type: "caughtUp", rev: this.#rev });
    runtime.subscribers.add(channel);

    const prompt = this.#autoplay.get(threadId);
    if (prompt !== undefined) {
      this.#autoplay.delete(threadId);
      void this.#turn(threadId, { text: prompt });
    }
    return channel;
  }

  /** The project for `root`, recorded as just opened (and created on first use), as the server does. */
  #openProject(input: string): Project {
    // Like the server, a missing or unreadable folder rejects with NotFound / InvalidState.
    const root = resolveMockFolder(input);
    const existing = this.#projects.find((p) => p.root === root);
    const project = existing
      ? { ...existing, lastOpenedAt: Date.now() }
      : mockProject(root, `p-${this.#ids()}`);
    this.#projects = [project, ...this.#projects.filter((p) => p.root !== root)];
    return project;
  }

  async checkoutUsers(path: string) {
    const threads = [...this.#threads.values()]
      .map((runtime) => runtime.summary.thread)
      .filter((thread) => pathKey(thread.checkout.path) === pathKey(path))
      .map((thread) => ({ threadId: thread.id, title: thread.title, parked: thread.parked }));
    return { threads };
  }

  async createThread(input: CreateThreadInput): Promise<Thread> {
    const model = input.model ??
      (await this.#settings.get()).agents.defaultModel ?? {
        agent: "claude" as const,
        model: "opus",
      };
    if (input.checkout.kind === "existingWorktree") {
      const { threads } = await this.checkoutUsers(input.checkout.path);
      if (threads.length > 0) {
        // The server's one-thread-per-worktree refusal.
        throw Object.assign(new Error("a thread is already open in that checkout"), {
          _tag: "CheckoutInUse",
          path: input.checkout.path,
        });
      }
    }
    const project = this.#openProject(input.projectRoot);
    if (input.checkout.kind === "newWorktree" && !isMockRepo(project.root)) {
      // The server's `worktrees.create` answer for a folder without git.
      throw Object.assign(new Error("repoPath is not a git repository"), { _tag: "GitError" });
    }
    const branch = input.checkout.kind === "newWorktree" ? input.checkout.branch : "main";
    const path =
      input.checkout.kind === "existingWorktree"
        ? input.checkout.path
        : input.checkout.kind === "newWorktree"
          ? `${project.root}/.worktrees/${branch.replaceAll("/", "-")}`
          : project.root;
    const thread: Thread = {
      id: `t-${this.#ids()}` as ThreadId,
      projectId: project.id,
      title: input.title ?? (input.input?.text.slice(0, 48) || "New thread"),
      userNamed: input.title !== undefined,
      model,
      mode: input.mode ?? "default",
      checkout: {
        kind: input.checkout.kind === "current" ? "main" : "worktree",
        path,
        branch,
        base: "main",
      },
      labels: [],
      pinned: false,
      parked: false,
      unread: false,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      ...(input.resumeSessionId ? { agentSessionId: input.resumeSessionId } : {}),
      ...(input.resumeSessionId && input.codexHome ? { codexHome: input.codexHome } : {}),
    };
    this.#add({
      thread,
      status: "idle",
      pendingRequests: [],
      queue: [],
      capabilities: MOCK_CAPABILITIES,
    });
    this.#emit({ type: "thread.upsert", thread });
    this.#emit({ type: "thread.status", threadId: thread.id, status: "idle" });
    if (input.input) {
      const adopted = adoptDraft(input.input, input.draftId, thread.id);
      this.#composer.moveUploads(input.input.attachments, adopted.attachments);
      void this.#turn(thread.id, adopted);
    }
    return thread;
  }

  async send(threadId: ThreadId, input: UserInput) {
    const runtime = this.#runtime(threadId);
    if (this.#missingFolders.has(threadId)) {
      const path = runtime.summary.thread.checkout.path;
      throw new MockInvalidState(`This thread's folder no longer exists: ${path}`, undefined, {
        path,
      });
    }
    // As the server's `userTyped`: a notice or another thread's message is not the user stepping in.
    if (input.origin === undefined && input.notice === undefined) {
      this.#orchestration.userTyped(threadId);
    }
    if (runtime.running) {
      this.#setQueue(runtime, [
        ...runtime.summary.queue,
        { id: this.#ids() as QueueItemId, input },
      ]);
      return { queued: true };
    }
    void this.#turn(threadId, input);
    return { queued: false };
  }

  async steer(threadId: ThreadId, input: UserInput) {
    const runtime = this.#runtime(threadId);
    if (input.origin === undefined && input.notice === undefined) {
      this.#orchestration.userTyped(threadId);
    }
    if (!runtime.running) {
      void this.#turn(threadId, input);
      return;
    }
    runtime.steer = input;
  }

  async interrupt(threadId: ThreadId) {
    const runtime = this.#runtime(threadId);
    if (runtime.running) runtime.interrupted = true;
  }

  /**
   * As the server answers: at rest it restarts now, mid-turn after the turn or by interrupting it,
   * and a thread with no conversation has nothing to restart.
   */
  async restartSession(
    threadId: ThreadId,
    midTurn: RestartMidTurn = "afterTurn",
  ): Promise<RestartSessionResult> {
    const runtime = this.#runtime(threadId);
    if (runtime.running) {
      runtime.restartAfterTurn = true;
      if (midTurn === "afterTurn") return "afterTurn";
      runtime.interrupted = true;
      return "restarting";
    }
    if (runtime.fold.store.getState().messages.length === 0) return "noSession";
    void this.#restart(runtime);
    return "restarting";
  }

  /** Every thread `startSession` opened a session for, in order, for specs to count. */
  readonly sessionStarts: ThreadId[] = [];

  /** As the server answers: a cold thread opens with no turn, and one open already is left be. */
  async startSession(threadId: ThreadId): Promise<StartSessionResult> {
    const runtime = this.#runtime(threadId);
    const { thread, status } = runtime.summary;
    if (this.#missingFolders.has(threadId)) {
      const path = thread.checkout.path;
      throw new MockInvalidState(`This thread's folder no longer exists: ${path}`, undefined, {
        path,
      });
    }
    if (thread.parked) throw new MockInvalidState("the thread is archived");
    if (thread.role === "dream")
      throw new MockInvalidState("a dream's session opens only for its run");
    if (status !== "cold" && status !== "error") return "open";
    this.sessionStarts.push(threadId);
    this.#setStatus(runtime, "starting");
    void this.#delay(400).then(() => {
      if (runtime.summary.status !== "starting") return;
      this.#ensureIdentity(runtime);
      this.#setStatus(runtime, "idle");
    });
    return "starting";
  }

  /** The session stops, opens again, and marks the transcript once it is up. */
  async #restart(runtime: ThreadRuntime, reason?: SessionRestartReason) {
    this.#setStatus(runtime, "starting");
    await this.#delay(150);
    const at = Date.now();
    this.#putMessage(runtime, {
      id: `restart-${this.#ids()}`,
      role: "assistant",
      metadata: { createdAt: at },
      parts: [
        {
          type: "data-session-restart",
          id: this.#ids(),
          data: reason === undefined ? { at } : { at, reason },
        },
      ],
    });
    this.#setStatus(runtime, "idle");
  }

  /** Adds a pending request; `onAnswer` runs once `respond` answers it. */
  #ask(threadId: ThreadId, request: PendingRequest, onAnswer: (answer: RequestAnswer) => void) {
    const runtime = this.#runtime(threadId);
    runtime.summary = {
      ...runtime.summary,
      pendingRequests: [...runtime.summary.pendingRequests, request],
    };
    this.#setStatus(runtime, request.kind === "approval" ? "needsApproval" : "needsInput");
    this.#emit({ type: "thread.request", threadId, request });
    this.#waiters.set(request.id, onAnswer);
  }

  /** `simulateRequest` (`mock-thread-sims.ts`). */
  simulateRequest(
    threadId: ThreadId,
    request: PendingRequest,
    onAnswer?: (answer: RequestAnswer) => void,
  ) {
    return simulateRequest(this.#scenes, threadId, request, onAnswer);
  }

  async stopTask(threadId: ThreadId, taskId: string) {
    const runtime = this.#runtime(threadId);
    const background = runtime.summary.background ?? [];
    if (!background.some((task) => task.taskId === taskId)) {
      throw new NotFound({ entity: "backgroundTask", id: taskId });
    }
    this.#setBackground(
      runtime,
      background.filter((task) => task.taskId !== taskId),
    );
  }

  /** `simulateQueued` (`mock-thread-sims.ts`). */
  simulateQueued(threadId: ThreadId, inputs: readonly UserInput[]) {
    return simulateQueued(this.#scenes, threadId, inputs);
  }

  /** `simulateLastActivity` (`mock-thread-sims.ts`). */
  simulateLastActivity(threadId: ThreadId, at: number) {
    return simulateLastActivity(this.#scenes, threadId, at);
  }

  /** `simulateTurnPlan` (`mock-thread-sims.ts`). */
  simulateTurnPlan(threadId: ThreadId, items: readonly PlanItem[]) {
    return simulateTurnPlan(this.#scenes, threadId, items);
  }

  /** `simulatePlan` (`mock-thread-sims.ts`). */
  simulatePlan(threadId: ThreadId, plan: ThreadPlan | undefined) {
    return simulatePlan(this.#scenes, threadId, plan);
  }

  /** `simulateBackground` (`mock-thread-sims.ts`). */
  simulateBackground(threadId: ThreadId, tasks: readonly BackgroundTask[]) {
    return simulateBackground(this.#scenes, threadId, tasks);
  }

  /** `simulateBackgroundOutput` (`mock-thread-sims.ts`). */
  simulateBackgroundOutput(threadId: ThreadId, output: BackgroundOutput) {
    return simulateBackgroundOutput(this.#scenes, threadId, output);
  }

  /** `simulateMessage` (`mock-thread-sims.ts`). */
  simulateMessage(threadId: ThreadId, message: GramUIMessage) {
    return simulateMessage(this.#scenes, threadId, message);
  }

  /** `simulateChunks` (`mock-thread-sims.ts`). */
  simulateChunks(threadId: ThreadId, messageId: MessageId, chunks: readonly GramUIMessageChunk[]) {
    return simulateChunks(this.#scenes, threadId, messageId, chunks);
  }

  /** `simulateStatus` (`mock-thread-sims.ts`). */
  simulateStatus(
    threadId: ThreadId,
    status: ThreadSummary["status"],
    detail?: string,
    compaction?: CompactionActivity,
  ) {
    return simulateStatus(this.#scenes, threadId, status, detail, compaction);
  }

  /** `simulateTurnError` (`mock-thread-sims.ts`). */
  simulateTurnError(threadId: ThreadId, error: Omit<ThreadError, "turnId" | "at">, text: string) {
    return simulateTurnError(this.#scenes, threadId, error, text);
  }

  /** `simulateLimitWait` (`mock-thread-sims.ts`). */
  simulateLimitWait(
    threadId: ThreadId,
    wait: Omit<LimitWait, "account" | "since" | "turnId">,
    text: string,
  ) {
    return simulateLimitWait(this.#scenes, threadId, wait, text);
  }

  /** `simulateLimitCleared` (`mock-thread-sims.ts`). */
  async simulateLimitCleared(threadId: ThreadId, resumeAt?: number) {
    return simulateLimitCleared(this.#scenes, threadId, resumeAt);
  }

  async resumeLimitWait(threadId: ThreadId) {
    const runtime = this.#runtime(threadId);
    if (runtime.summary.thread.limitWait === undefined) return;
    const { limitWait: _, ...thread } = runtime.summary.thread;
    this.#replaceThread(thread);
    await this.send(threadId, { text: "The usage limit has reset. Continue where you left off." });
  }

  async cancelLimitWait(threadId: ThreadId) {
    const runtime = this.#runtime(threadId);
    const wait = runtime.summary.thread.limitWait;
    if (wait === undefined || wait.cancelled === true) return;
    this.#replaceThread({
      ...runtime.summary.thread,
      limitWait: { ...wait, cancelled: true },
      lastError: {
        kind: "rateLimit",
        retryable: wait.kind === "backoff",
        text: "The usage limit is reached. It resets on the provider's schedule.",
        at: Date.now(),
        ...(wait.turnId === undefined ? {} : { turnId: wait.turnId }),
      },
    });
    this.#setStatus(runtime, "error");
  }

  /** `simulateTerminalProcesses` (`mock-thread-sims.ts`). */
  simulateTerminalProcesses(threadId: ThreadId, processes: readonly TerminalProcess[]) {
    return simulateTerminalProcesses(this.#scenes, threadId, processes);
  }

  /** `simulatePorts` (`mock-thread-sims.ts`). */
  simulatePorts(threadId: ThreadId, ports: readonly number[]) {
    return simulatePorts(this.#scenes, threadId, ports);
  }

  /** `simulateWrittenFile` (`mock-thread-sims.ts`). */
  simulateWrittenFile(threadId: ThreadId, path: string, content: string) {
    return simulateWrittenFile(this.#scenes, threadId, path, content);
  }

  /** `simulateShowPanel` (`mock-thread-sims.ts`). */
  simulateShowPanel(threadId: ThreadId, panel: PanelKind, target?: string, driven?: boolean) {
    return simulateShowPanel(this.#scenes, threadId, panel, target, driven);
  }

  #setBackground(runtime: ThreadRuntime, tasks: readonly BackgroundTask[]) {
    const { background: _previous, backgroundOutput: outputs, ...rest } = runtime.summary;
    // A task's output goes with it, as on the server.
    const kept = (outputs ?? []).filter((each) =>
      tasks.some((task) => task.taskId === each.taskId),
    );
    runtime.summary = {
      ...rest,
      ...(tasks.length === 0 ? {} : { background: tasks }),
      ...(kept.length === 0 ? {} : { backgroundOutput: kept }),
    };
    this.#emit({ type: "thread.background", threadId: runtime.summary.thread.id, tasks });
  }

  async respond(threadId: ThreadId, requestId: RequestId, answer: RequestAnswer) {
    const runtime = this.#runtime(threadId);
    const waiter = this.#waiters.get(requestId);
    if (!waiter) throw new Error(`RequestNotFound: ${requestId}`);
    this.#waiters.delete(requestId);
    runtime.summary = {
      ...runtime.summary,
      pendingRequests: runtime.summary.pendingRequests.filter((r) => r.id !== requestId),
    };
    this.#emit({ type: "thread.requestResolved", threadId, requestId });
    if (answer.kind === "plan" && answer.decision === "approve" && answer.mode) {
      this.#update(runtime, { mode: answer.mode });
    }
    waiter(answer);
  }

  /** Each answer on its own, in order: one that fails says so in its row and the rest still go out. */
  async respondMany(...[answers]: Parameters<Api["respondMany"]>) {
    const results: RespondManyResult[] = [];
    for (const { threadId, requestId, answer } of answers) {
      try {
        await this.respond(threadId, requestId, answer);
        results.push({ threadId, requestId, ok: true });
      } catch (error) {
        results.push({
          threadId,
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  async setMode(threadId: ThreadId, mode: PermissionMode) {
    this.#update(this.#runtime(threadId), { mode });
  }

  async setModel(threadId: ThreadId, model: ModelRef) {
    const runtime = this.#runtime(threadId);
    this.#update(runtime, { model });
    if (runtime.summary.identity) {
      const identity = { ...runtime.summary.identity, model: model.model };
      runtime.summary = { ...runtime.summary, identity };
      this.#emit({ type: "thread.identity", threadId, identity });
    }
  }

  async rename(threadId: ThreadId, title: string) {
    this.#update(this.#runtime(threadId), { title, userNamed: true });
  }

  /** The mock's filesystem has every folder; a relative path is from the checkout. */
  async addDirectory(threadId: ThreadId, path: string): Promise<string> {
    const runtime = this.#runtime(threadId);
    const trimmed = path.trim().replace(/\/+$/, "");
    const folder = trimmed.startsWith("/")
      ? trimmed
      : `${effectiveCheckout(runtime.summary.thread).path}/${trimmed}`;
    const granted = runtime.summary.thread.additionalDirectories ?? [];
    if (!granted.includes(folder)) {
      this.#update(runtime, { additionalDirectories: [...granted, folder] });
    }
    return folder;
  }

  async setPlan(threadId: ThreadId, edit: PlanEdit): Promise<ThreadPlan | null> {
    const runtime = this.#runtime(threadId);
    const plan = applyUserEdit(runtime.summary.plan, edit, {
      now: Date.now(),
      newId: () => this.#ids() as PlanStepId,
    });
    this.#setPlans(runtime, { plan });
    return plan ?? null;
  }

  /** The mock has no helper: its plans are seeded, and a refresh only says when it looked. */
  async refreshPlan(threadId: ThreadId): Promise<ThreadPlan | null> {
    const runtime = this.#runtime(threadId);
    const plan = runtime.summary.plan;
    if (plan === undefined) return null;
    this.#setPlans(runtime, { plan: { ...plan, updatedAt: Date.now() } });
    return runtime.summary.plan ?? null;
  }

  async pin(threadId: ThreadId, pinned: boolean) {
    this.#update(this.#runtime(threadId), { pinned });
  }

  async park(threadId: ThreadId, parked: boolean) {
    this.#update(this.#runtime(threadId), { parked });
    this.#orchestration.parkChanged(threadId, parked);
  }

  async markCompleted(threadId: ThreadId, completed: boolean) {
    const runtime = this.#runtime(threadId);
    const open = withoutCompletion(runtime.summary.thread);
    const thread = completed
      ? { ...open, completedAt: Date.now(), completedReason: "user" as const }
      : open;
    runtime.summary = { ...runtime.summary, thread };
    this.#emit({ type: "thread.upsert", thread });
  }

  async reorderThreads(threadIds: readonly ThreadId[]) {
    threadIds.forEach((threadId, sortOrder) => {
      const runtime = this.#threads.get(threadId);
      if (runtime && runtime.summary.thread.sortOrder !== sortOrder) {
        this.#update(runtime, { sortOrder });
      }
    });
  }

  async label(threadId: ThreadId, labels: ThreadLabels) {
    this.#update(this.#runtime(threadId), { labels });
  }

  async markUnread(threadId: ThreadId, unread: boolean) {
    this.#update(this.#runtime(threadId), { unread });
  }

  readonly #babysit = createMockBabysit({
    thread: (threadId) => this.#runtime(threadId).summary.thread,
    pr: (threadId) => {
      const git = this.#runtime(threadId).summary.git;
      return git?.pr && git.origin ? { repo: git.origin, number: git.pr.number } : undefined;
    },
    replace: (thread) => this.#replaceThread(thread),
    putMessage: (threadId, message) => this.#putMessage(this.#runtime(threadId), message),
    delay: (ms) => this.#delay(ms),
    ids: () => this.#ids(),
  });

  async threadSetBabysit(...[threadId, enabled, budget]: Parameters<Api["threadSetBabysit"]>) {
    if (enabled) this.#pullRequests.refuseOrchestratorPr(threadId);
    return this.#babysit.set(threadId, enabled, budget);
  }

  async threadSetReviewMonitor(threadId: ThreadId, enabled: boolean) {
    if (enabled) this.#pullRequests.refuseOrchestratorPr(threadId);
    return this.#babysit.setReviewMonitor(threadId, enabled);
  }

  /** Waiting on you, whose note the core's turns carry as the server's sends do. */
  readonly #waits = createWaitsMock(this.world);

  /** The agents' subscription limit readings, for the title bar's usage meter. */
  readonly #limits = createLimitsMock(this.world);

  readonly #orchestration = createMockOrchestration({
    gate: (name) => this.world.gate(name),
    projects: () => this.#projects,
    threads: () => [...this.#threads.values()].map((runtime) => runtime.summary.thread),
    summary: (threadId) => this.#threads.get(threadId)?.summary,
    settings: () => this.#settings.get(),
    createThread: ({ projectRoot, title, mode, branch }) =>
      this.createThread({
        projectRoot,
        checkout:
          branch === undefined
            ? { kind: "current" }
            : { kind: "newWorktree", branch, base: "main" },
        title,
        mode,
      }),
    replace: (thread) => this.#replaceThread(thread),
    putMessage: (threadId, message) => this.#putMessage(this.#runtime(threadId), message),
    setStatus: (threadId, status, detail) =>
      this.#setStatus(this.#runtime(threadId), status, detail),
    setGit: (threadId, given) => {
      // Like the server's publisher, an orchestrator is sent its checkout's state without the PR.
      const orchestrator = this.#runtime(threadId).summary.thread.role === "orchestrator";
      const { pr: _pr, extraPrs: _extras, prElsewhere: _elsewhere, ...rest } = given;
      const state = orchestrator ? rest : given;
      this.#runtime(threadId).summary = { ...this.#runtime(threadId).summary, git: state };
      this.#emit({ type: "git.state", threadId, state });
    },
    setUsage: (threadId, usage) => {
      this.#runtime(threadId).summary = { ...this.#runtime(threadId).summary, usage };
      this.#emit({ type: "thread.usage", threadId, usage });
    },
    ask: (threadId, request, onAnswer) => this.#ask(threadId, request, onAnswer),
    emit: (event) => this.#emit(event),
    ids: () => this.#ids(),
    onEvent: (listener) => {
      this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    },
    seedMemory: (workspaceId, projectIds) => this.#dreams.seed(workspaceId, projectIds),
    deliver: async (threadId, text) => {
      if (this.world.running(threadId)) {
        await this.world.steer(threadId, { text });
        return "steered";
      }
      await this.world.send(threadId, { text });
      return "sent";
    },
  });

  /** The board's workspace when the e2e flag asks the mock to start with it; settled otherwise. */
  readonly #startingBoard: Promise<unknown> = mockStartsWithBoard()
    ? Promise.resolve().then(() => this.simulateOrchestration("board"))
    : Promise.resolve();

  readonly #dreams = createMockDreams({
    workspace: (workspaceId) =>
      this.#orchestration.peek().find((state) => state.workspace.id === workspaceId),
    projects: () => this.#projects,
    createThread: ({ projectRoot, title, mode }) =>
      this.createThread({ projectRoot, checkout: { kind: "current" }, title, mode }),
    replace: (thread) => this.#replaceThread(thread),
    putMessage: (threadId, message) => this.#putMessage(this.#runtime(threadId), message),
    setStatus: (threadId, status, detail) =>
      this.#setStatus(this.#runtime(threadId), status, detail),
    setUsage: (threadId, usage) => {
      this.#runtime(threadId).summary = { ...this.#runtime(threadId).summary, usage };
      this.#emit({ type: "thread.usage", threadId, usage });
    },
    closeThread: async (threadId) => {
      if (this.#threads.has(threadId)) await this.closeThread(threadId);
    },
    emit: (event) => this.#emit(event),
    ids: () => this.#ids(),
  });

  /**
   * Dev and e2e hook: an orchestrator at work, so every orchestration surface has something to show.
   * `report` (the default) is one worker in the `api` project that reported back, with both digests,
   * a memory write and a handoff; `board` is a workspace across all three projects with a cross-repo
   * feature whose workers are working, waiting on the same `git push` and in review, and a second
   * feature just briefed. Adds threads rather than seeding them, so the sidebar's seeded counts stay
   * what specs assert.
   */
  simulateOrchestration(scenario?: "report"): Promise<MockOrchestrationSimulation>;
  simulateOrchestration(scenario: "board"): Promise<MockBoardSimulation>;
  simulateOrchestration(
    scenario: MockOrchestrationScenario = "report",
  ): Promise<MockOrchestrationSimulation | MockBoardSimulation> {
    return scenario === "board"
      ? this.#orchestration.simulateBoard(PROJECTS.map((project) => project.id))
      : this.#orchestration.simulate(PROJECTS[0]!.id);
  }

  /**
   * Dev and e2e hook: the workspace's orchestrator briefs a worker for `feature`, as `spawn_worker`
   * does, so its feature card arrives.
   */
  simulateBrief(workspaceId: WorkspaceId, feature: string, title: string): Promise<Thread> {
    return this.#orchestration.simulateBrief(workspaceId, feature, title);
  }

  /**
   * Dev and e2e hook: the workspace's orchestrator asks for a low-priority brief near a usage
   * limit, so it is held until `until` (epoch ms) and its feature card shows it held.
   */
  simulateHeldBrief(
    workspaceId: WorkspaceId,
    input: {
      readonly feature: string;
      readonly title: string;
      readonly agent?: string;
      readonly usedPct?: number;
      readonly reason?: string;
      readonly until: number;
    },
  ): HeldBrief {
    return this.#orchestration.simulateHeldBrief(workspaceId, input);
  }

  /** `simulateAddRepoRequest` (`mock-scenarios.ts`). */
  async simulateAddRepoRequest(workspaceId: WorkspaceId, root: string): Promise<RequestId> {
    return simulateAddRepoRequest(this.#scenes, workspaceId, root);
  }

  /** `simulateAskUser` (`mock-scenarios.ts`). */
  simulateAskUser(workspaceId: WorkspaceId, input: AskInput): string {
    return simulateAskUser(this.#scenes, workspaceId, input);
  }

  /** `simulateCloseQuestion` (`mock-scenarios.ts`). */
  simulateCloseQuestion(workspaceId: WorkspaceId, id: string, answer: string): void {
    return simulateCloseQuestion(this.#scenes, workspaceId, id, answer);
  }

  /** `simulateAsks` (`mock-scenarios.ts`). */
  simulateAsks(): Promise<MockAsksSimulation> {
    return simulateAsks(this.#scenes);
  }

  /** Dev and e2e hook: the title the helper "suggests" for `requestId`'s notification. */
  armNoticeTitle(requestId: RequestId, title: string): void {
    this.#composer.armNoticeTitle(requestId, title);
  }

  /** Dev and e2e hook: the helper's one sentence for `feature`'s card, from its next version on. */
  simulateFeatureSummary(feature: string, text: string): void {
    this.#orchestration.simulateFeatureSummary(feature, text);
  }

  /** `simulateFinishedWork` (`mock-scenarios.ts`). */
  async simulateFinishedWork(): Promise<MockFinishedSimulation> {
    return simulateFinishedWork(this.#scenes);
  }

  /** `simulateLiveCards` (`mock-scenarios.ts`). */
  async simulateLiveCards(): Promise<MockFinishedSimulation> {
    return simulateLiveCards(this.#scenes);
  }

  /** `simulateWorkers` (`mock-scenarios.ts`). */
  async simulateWorkers(): Promise<MockWorkersSimulation> {
    return simulateWorkers(this.#scenes);
  }

  /** `simulateOneThread` (`mock-scenarios.ts`). */
  async simulateOneThread(): Promise<MockOneThreadSimulation> {
    return simulateOneThread(this.#scenes);
  }

  /** `simulateReachingWorkers` (`mock-scenarios.ts`). */
  async simulateReachingWorkers(): Promise<MockReachingSimulation> {
    return simulateReachingWorkers(this.#scenes);
  }

  /** `simulateWorkerQuestions` (`mock-scenarios.ts`). */
  async simulateWorkerQuestions(): Promise<
    MockBoardSimulation & { readonly questions: readonly WorkerQuestion[] }
  > {
    return simulateWorkerQuestions(this.#scenes);
  }

  /** `simulateQuietBusy` (`mock-scenarios.ts`). */
  simulateQuietBusy(): Promise<MockQuietBusySimulation> {
    return simulateQuietBusy(this.#scenes);
  }

  /** `simulateWorkerWaits` (`mock-scenarios.ts`). */
  async simulateWorkerWaits(): Promise<
    MockFinishedSimulation & { readonly waits: MockWaitsSimulation }
  > {
    return simulateWorkerWaits(this.#scenes);
  }

  /** `simulateReleaseGroup` (`mock-scenarios.ts`). */
  async simulateReleaseGroup(): Promise<
    MockFinishedSimulation & { readonly release: MockReleaseSimulation }
  > {
    return simulateReleaseGroup(this.#scenes);
  }

  /** `simulateArchivedGroups` (`mock-scenarios.ts`). */
  async simulateArchivedGroups(): Promise<
    MockFinishedSimulation & {
      readonly archivedGroups: readonly ThreadId[];
      readonly nightly: ThreadId;
    }
  > {
    return simulateArchivedGroups(this.#scenes);
  }

  /** `seedPrStates` (`mock-seeds.ts`). */
  seedPrStates(): void {
    return seedPrStates(this.#scenes);
  }

  /** `seedSidebarLoad` (`mock-seeds.ts`). */
  async seedSidebarLoad(): Promise<void> {
    return seedSidebarLoad(this.#scenes);
  }

  /** Dev and e2e hook: the next step of a feature's or a group's plan, as `set_stage` would set it. */
  advanceOrchestrationStage(
    workspaceId: Parameters<Api["orchestratorLedger"]>[0],
    target: MockStageTarget,
  ) {
    return this.#orchestration.advanceStage(workspaceId, target);
  }

  async restoreWorktree(threadId: ThreadId, fromPr?: boolean): Promise<RestoreWorktreeResult> {
    const runtime = this.#runtime(threadId);
    const missing = this.#missingFolders.get(threadId);
    if (missing === undefined) {
      throw new MockInvalidState("This thread's folder is there, so there is nothing to restore.");
    }
    const { checkout } = runtime.summary.thread;
    const branch = checkout.branch ?? "";
    if (missing.branchGone !== undefined && fromPr !== true) {
      return { _tag: "branchGone", branch, pr: missing.branchGone };
    }
    this.#missingFolders.delete(threadId);
    this.#goneFolders.delete(pathKey(checkout.path));
    const { missing: _gone, ...git } = runtime.summary.git ?? {
      repo: true,
      worktree: true,
      head: "",
      changesToken: "",
      changedFiles: 0,
      behindBase: 0,
      aheadBase: 0,
      conflicts: false,
    };
    // Restored from the branch's commits: what was uncommitted is gone.
    const restored: GitState = { ...git, changedFiles: 0 };
    runtime.summary = { ...runtime.summary, git: restored };
    this.#emit({ type: "git.state", threadId, state: restored });
    return {
      _tag: "restored",
      path: checkout.path,
      branch,
      source: missing.branchGone === undefined ? "local" : "pr",
    };
  }

  /** Calls from the last `closeThread`, for tests. */
  lastClose: { threadId: ThreadId; options: CloseThreadOptions } | undefined;

  async closeThread(threadId: ThreadId, options: CloseThreadOptions = {}) {
    const runtime = this.#runtime(threadId);
    this.lastClose = { threadId, options };
    const { checkout } = runtime.summary.thread;
    const { status, queue, pendingRequests, background } = runtime.summary;
    const resting = status === "idle" || status === "cold" || status === "ended";
    if (
      options.onlyAtRest &&
      (!resting || queue.length > 0 || pendingRequests.length > 0 || (background?.length ?? 0) > 0)
    ) {
      throw new MockInvalidState("the thread is working, so it was left open");
    }
    const dirty = runtime.summary.git?.changedFiles ?? 0;
    if (options.removeWorktree && !options.removeWorktree.force && dirty > 0) {
      throw Object.assign(new Error(`${checkout.path} has uncommitted changes`), {
        _tag: "WorktreeDirty",
        path: checkout.path,
        changedFiles: dirty,
      });
    }
    this.#closed.remember(runtime.summary.thread);
    if (options.removeWorktree || this.#missingFolders.has(threadId)) {
      this.#goneFolders.add(pathKey(checkout.path));
    }
    this.#missingFolders.delete(threadId);
    // Like the server, the conversation stays while the thread is on the closed list.
    this.#closedHistory.set(threadId, runtime.fold.store.getState().messages);
    const listed = this.#closed.ids();
    for (const id of this.#closedHistory.keys())
      if (!listed.has(id)) this.#closedHistory.delete(id);
    this.#threads.delete(threadId);
    this.#emit({ type: "thread.removed", threadId });
    const workers = this.#orchestration.threadClosed(threadId);
    if (workers.length > 0) this.#closedWorkers.set(threadId, workers);
    else this.#closedWorkers.delete(threadId);
    const branch = checkout.kind === "worktree" ? checkout.branch : undefined;
    return options.removeWorktree?.deleteBranch && branch
      ? { branch: { name: branch, deleted: true } }
      : {};
  }

  readonly #closedHistory = new Map<string, readonly GramUIMessage[]>();
  /** The workers a closed orchestrator had, which its reopen links again, as the server's list. */
  readonly #closedWorkers = new Map<string, readonly MockClosedWorker[]>();
  /** Checkouts a close removed, or that were gone when it closed: a reopen finds them missing. */
  readonly #goneFolders = new Set<string>();

  /** A closed thread marked as the server marks it: its session shown elsewhere, or its folder gone. */
  #withProblem(entry: ClosedThread): ClosedThread {
    const session = entry.thread.agentSessionId;
    const open =
      session === undefined
        ? undefined
        : [...this.#threads.values()].find((r) => r.summary.thread.agentSessionId === session);
    if (open) return { ...entry, problem: "sessionOpen", openThreadId: open.summary.thread.id };
    return this.#goneFolders.has(pathKey(entry.thread.checkout.path))
      ? { ...entry, problem: "folderMissing" }
      : entry;
  }

  /** The closed thread again from its stored record, as the server's `threads.closed.reopen` makes it. */
  #reopenThread(closed: ClosedThread, fields: MockReopenFields): Thread {
    const stored = closed.thread;
    const { checkout } = stored;
    const holder = [...this.#threads.values()].find(
      (r) => pathKey(r.summary.thread.checkout.path) === pathKey(checkout.path),
    );
    if (holder !== undefined && checkout.kind === "worktree") {
      throw Object.assign(new Error("a thread is already open in that checkout"), {
        _tag: "CheckoutInUse",
        path: checkout.path,
      });
    }
    const thread: Thread = {
      id: stored.id,
      projectId: stored.projectId,
      title: stored.title,
      userNamed: stored.userNamed,
      model: stored.model,
      mode: stored.mode,
      checkout,
      labels: stored.labels,
      pinned: stored.pinned,
      parked: false,
      unread: false,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      ...(stored.agentNamed === undefined ? {} : { agentNamed: stored.agentNamed }),
      ...(stored.boundPr === undefined ? {} : { boundPr: stored.boundPr }),
      ...(stored.extraPrs === undefined ? {} : { extraPrs: stored.extraPrs }),
      ...(stored.additionalDirectories === undefined
        ? {}
        : { additionalDirectories: stored.additionalDirectories }),
      ...(stored.extraCheckouts === undefined ? {} : { extraCheckouts: stored.extraCheckouts }),
      ...(stored.agentSessionId === undefined || stored.agentSessionUnused === true
        ? {}
        : {
            agentSessionId: stored.agentSessionId,
            ...(stored.codexHome === undefined ? {} : { codexHome: stored.codexHome }),
          }),
      ...fields,
    };
    const missing = closed.problem === "folderMissing";
    const runtime = this.#add({
      thread,
      status: missing ? "cold" : "idle",
      pendingRequests: [],
      queue: [],
      capabilities: MOCK_CAPABILITIES,
    });
    const history = this.#closedHistory.get(thread.id);
    if (history) {
      this.#feed(runtime, { type: "messages", messages: [...history] });
      this.#closedHistory.delete(thread.id);
    }
    this.#emit({ type: "thread.upsert", thread });
    this.#emit({ type: "thread.status", threadId: thread.id, status: runtime.summary.status });
    if (missing) this.simulateMissingFolder(thread.id);
    return thread;
  }

  async listClosedThreads() {
    await this.#delay(10);
    return this.#closed.list().map((entry) => this.#withProblem(entry));
  }

  async reopenClosedThread(): Promise<ReopenedClosedThread | null> {
    await this.#delay(10);
    const newest = this.#closed.take();
    if (newest === undefined) return null;
    const closed = this.#withProblem(newest);
    if (closed.problem === "sessionOpen") return { closed };
    const workers = this.#closedWorkers.get(newest.thread.id) ?? [];
    try {
      const { thread, membership } = this.#orchestration.reopen(closed.thread, workers, (fields) =>
        this.#reopenThread(closed, fields),
      );
      this.#closedWorkers.delete(thread.id);
      return { closed, thread, ...(membership === undefined ? {} : { membership }) };
    } catch (error) {
      // As the server: a reopen that fails puts the entry back for the next try.
      this.#closed.restore(newest.thread, newest.closedAt);
      throw error;
    }
  }

  async pendingPermissions(threadId: ThreadId) {
    return this.#runtime(threadId).summary.thread.checkout.kind === "worktree" ? PENDING_RULES : [];
  }

  async forkThread(threadId: ThreadId, options: ForkThreadOptions = {}): Promise<Thread> {
    const source = this.#runtime(threadId);
    if (source.running) throw new Error("InvalidState: can't fork while the agent is working");
    const messages = source.fold.store.getState().messages;
    let cut = messages.length;
    if (options.fromMessageId !== undefined) {
      const index = messages.findIndex((m) => m.id === options.fromMessageId);
      if (index === -1) throw new Error(`NotFound: message ${options.fromMessageId}`);
      // Like the server, a fork point is a reply the agent has reported its own ids for.
      if ((messages[index]!.metadata?.agentMessageIds?.length ?? 0) === 0) {
        throw new Error("InvalidState: that message can't be forked from");
      }
      cut = index + 1;
    }
    const origin = source.summary.thread;
    const project = this.#projects.find((p) => p.id === origin.projectId);
    const created = await this.createThread({
      projectRoot: project?.root ?? origin.checkout.path,
      checkout: options.checkout ?? { kind: "current" },
      model: origin.model,
      mode: origin.mode,
      title: options.title ?? `Fork of ${origin.title}`,
    });
    const runtime = this.#runtime(created.id);
    this.#update(runtime, {
      forkedFrom: { threadId },
      ...(options.checkout ? {} : { checkout: origin.checkout }),
    });
    this.#feed(runtime, { type: "messages", messages: messages.slice(0, cut) });
    return runtime.summary.thread;
  }

  async searchThreads(
    query: string,
    options: SearchThreadsOptions = {},
  ): Promise<ThreadSearchResult> {
    if (options.threadId !== undefined) this.#runtime(options.threadId);
    const scope = [...this.#threads.values()].filter(
      (r) => options.threadId === undefined || r.summary.thread.id === options.threadId,
    );
    return searchMessages(
      scope.map((r) => ({ thread: r.summary.thread, messages: r.fold.store.getState().messages })),
      query,
      options.limit ?? 50,
    );
  }

  async queueEdit(threadId: ThreadId, itemId: QueueItemId, input: UserInput) {
    const runtime = this.#runtime(threadId);
    this.#queueItem(runtime, itemId);
    this.#setQueue(
      runtime,
      runtime.summary.queue.map((q) => (q.id === itemId ? { ...q, input } : q)),
    );
  }

  async queueReorder(threadId: ThreadId, itemIds: readonly QueueItemId[]) {
    const runtime = this.#runtime(threadId);
    const byId = new Map(runtime.summary.queue.map((q) => [q.id, q]));
    if (itemIds.length !== byId.size || itemIds.some((id) => !byId.has(id))) {
      throw new Error("InvalidState: reorder must list every queued item");
    }
    this.#setQueue(
      runtime,
      itemIds.map((id) => byId.get(id)!),
    );
  }

  async queueRemove(threadId: ThreadId, itemId: QueueItemId) {
    const runtime = this.#runtime(threadId);
    this.#queueItem(runtime, itemId);
    this.#setQueue(
      runtime,
      runtime.summary.queue.filter((q) => q.id !== itemId),
    );
  }

  async queueSteer(threadId: ThreadId, itemId: QueueItemId) {
    const runtime = this.#runtime(threadId);
    this.#queueItem(runtime, itemId);
    const item = runtime.summary.queue.find((q) => q.id === itemId);
    // As the server: with nothing running there is nothing to steer into, so it goes now.
    if (!runtime.running) {
      this.#setQueue(
        runtime,
        runtime.summary.queue.filter((q) => q.id !== itemId),
      );
      if (item) void this.#turn(threadId, item.input);
      return;
    }
    runtime.steer = item?.input;
    this.#setQueue(
      runtime,
      runtime.summary.queue.filter((q) => q.id !== itemId),
    );
  }

  #setChipStatus(runtime: ThreadRuntime, taskId: TaskId, status: "accepted" | "dismissed") {
    for (const message of runtime.fold.store.getState().messages) {
      const index = message.parts.findIndex(
        (p) => p.type === "data-task-chip" && p.data.id === taskId,
      );
      const part = message.parts[index];
      if (part?.type !== "data-task-chip") continue;
      this.#putMessage(runtime, {
        ...message,
        parts: message.parts.with(index, { ...part, data: { ...part.data, status } }),
      });
      return part.data;
    }
    throw new Error(`NotFound: task ${taskId}`);
  }

  async acceptTask(threadId: ThreadId, taskId: TaskId) {
    const runtime = this.#runtime(threadId);
    const chip = this.#setChipStatus(runtime, taskId, "accepted");
    const project =
      this.#projects.find((p) => p.id === runtime.summary.thread.projectId) ?? PROJECTS[0]!;
    return this.createThread({
      projectRoot: project.root,
      // As the server does: a worktree of its own unless the chip asks to share this one.
      checkout:
        chip.checkout === "current"
          ? { kind: "current" }
          : {
              kind: "newWorktree",
              branch: chip.branch ?? `task/${taskId}`,
              ...(chip.base === undefined ? {} : { base: chip.base }),
            },
      title: chip.title,
      input: { text: chip.prompt },
    });
  }

  async dismissTask(threadId: ThreadId, taskId: TaskId) {
    this.#setChipStatus(this.#runtime(threadId), taskId, "dismissed");
  }

  get connection() {
    return this.#connection;
  }
  readonly #settings = createSettingsMock();

  async rewind(threadId: ThreadId, toMessageId: string, files: boolean) {
    const runtime = this.#runtime(threadId);
    if (runtime.running) throw new Error("InvalidState: a turn is running");
    const messages = runtime.fold.store.getState().messages;
    const index = messages.findIndex((m) => m.id === toMessageId);
    if (index === -1) throw new Error(`NotFound: message ${toMessageId}`);
    // An assistant target is kept; a user target is dropped, since an edit replaces it.
    const kept = messages.slice(0, messages[index]!.role === "user" ? index : index + 1);
    runtime.inflight.clear();
    this.#feed(runtime, { type: "messages", messages: kept });
    this.#update(runtime, { lastActivityAt: Date.now() });
    if (files) {
      this.#emit({
        type: "notify",
        kind: "info",
        title: "Files restored",
        body: "The working tree matches this point in the conversation.",
        threadId,
      });
    }
  }

  /** The seeded PR is #412; any other number checks out a `pr-<n>` branch. */
  async prCheckout(projectRoot: string, number: number, repo?: string) {
    await this.#delay(50);
    const seeded = number === 412 ? mockPrDetail("t-flaky" as ThreadId).detail : undefined;
    const thread = await this.createThread({
      projectRoot,
      checkout: { kind: "newWorktree", branch: seeded?.headRefName ?? `pr-${number}` },
      title: `#${number} ${seeded?.title ?? "Pull request"}`,
    });
    const boundPr = await this.#worktrees.bind(thread.id, repo ?? "example/api", number);
    return { ...thread, boundPr };
  }

  /** `simulateMissingFolder` (`mock-scenarios.ts`). */
  simulateMissingFolder(
    threadId: ThreadId,
    options: { branchGone?: { repo: string; number: number } } = {},
  ) {
    return simulateMissingFolder(this.#scenes, threadId, options);
  }

  /** `simulateUnpushed` (`mock-scenarios.ts`). */
  simulateUnpushed(threadId: ThreadId, commits: number) {
    return simulateUnpushed(this.#scenes, threadId, commits);
  }

  /** Dev and e2e hook: the PR's checks settle to `checks`, with the server's toast when they do. */
  /** `simulateFailures` (`mock-scenarios.ts`). */
  async simulateFailures(): Promise<MockFailuresSimulation> {
    return simulateFailures(this.#scenes);
  }

  /** Synthetic notification injection for dev/browser tests; no provider payload is involved. */
  simulateNotification(event: Extract<ApiServerEvent, { type: "notify" }>) {
    this.#emit(event);
  }

  /**
   * Settings changed behind the window's back, as an approved `settings_propose` changes them: saved,
   * then `settings.changed`, which every window answers by pulling them again.
   */
  async simulateSettingsChange(patch: SettingsPatch) {
    await this.#settings.api.updateSettings(patch);
    this.#emit({ type: "settings.changed" });
  }

  /** `simulateChecks` (`mock-scenarios.ts`). */
  simulateChecks(threadId: ThreadId, checks: PrStatus["checks"]) {
    return simulateChecks(this.#scenes, threadId, checks);
  }

  /** `seedClaudeAccountModels` (`mock-seeds.ts`). */
  seedClaudeAccountModels(models: readonly AgentModel[]) {
    return seedClaudeAccountModels(this.#scenes, models);
  }

  /** How many times a composer has told the server the user is typing. */
  get helperTypingReports(): number {
    return this.#profiles.helperPresence.typing;
  }

  /** Holds every clone until `release("clone")`, so a spec can see one under way. */
  holdClones() {
    this.#projectsMock.holdClones();
  }

  /** `simulateRecap` (`mock-scenarios.ts`). */
  simulateRecap(
    threadId: ThreadId,
    options: { recap?: ThreadRecap; git?: GitState; plan?: ThreadPlan; delayMs?: number } = {},
  ) {
    return simulateRecap(this.#scenes, threadId, options);
  }

  /** What `recordHelperEvent` was told, oldest first. */
  helperEvents() {
    return this.#composer.assist.events();
  }

  readonly #worktrees = createWorktreesMock(this.world);

  readonly #pullRequests = createPullRequestsMock(this.world, {
    peopleDetail: (threadId, detail) => this.#prPeople.detail(threadId, detail),
    bind: (threadId, repo, number, monitor) =>
      this.#worktrees.bind(threadId, repo, number, monitor),
    unbind: (threadId) => this.#worktrees.unbind(threadId),
    setMonitor: (threadId, monitor) => this.#worktrees.setMonitor(threadId, monitor),
  });

  /**
   * Stores the thread and emits `thread.upsert`. Like the server's store, every write lists a
   * followed PR once, whichever path (bind, babysit, the review monitor) made it the main one.
   */
  #replaceThread(edited: Thread) {
    const thread = normalizeThreadPrs(edited);
    const runtime = this.#runtime(thread.id);
    runtime.summary = { ...runtime.summary, thread };
    this.#emit({ type: "thread.upsert", thread });
  }

  /** Calls from the last `removeWorktree`, for tests. */
  get lastRemove() {
    return this.#worktrees.lastRemove();
  }

  readonly #reviewRequests = createReviewRequestsMock(this.world);

  /** `simulateReviewRequest` (`mock-scenarios.ts`). */
  simulateReviewRequest(request: ReviewRequest) {
    return simulateReviewRequest(this.#scenes, request);
  }

  /** Dev and e2e hook: the user opens `pr`, or it changes on GitHub, as the poll finds it. */
  /** `replacePrLists` (`mock-scenarios.ts`). */
  replacePrLists(lists: { requests: readonly ReviewRequest[]; prs: readonly OwnPr[] }) {
    return replacePrLists(this.#scenes, lists);
  }

  /** `simulateOpenPr` (`mock-scenarios.ts`). */
  simulateOpenPr(pr: OwnPr) {
    return simulateOpenPr(this.#scenes, pr);
  }
}

/**
 * An in-memory server with scripted agent turns, for dev and tests: the core, with each domain's
 * slice added. `satisfies Api` checks that together they serve all of it.
 */
export function createMockApi(options: MockApiOptions = {}) {
  const core = new MockCore(options);
  const { world } = core;
  const speech = createSpeechMock();
  const agentBrowse = createAgentBrowseMock((threadId, request, onAnswer) =>
    core.simulateRequest(threadId, request, onAnswer),
  );
  // One spread object and a two-argument `Object.assign`: past three sources `Object.assign` falls
  // back to an overload returning `any`, which would pass `satisfies Api` unchecked.
  const slices = {
    ...core.ownedApis(),
    ...createAgentRuntimeMock(world),
    ...agentSupportMock(),
    ...createAppMock(world),
    ...createBranchesMock(world),
    ...createConnectorsMock(world),
    ...createFilesMock(world),
    ...createKeybindingsMock(world),
    ...createLabelsMock(world),
    ...createSessionsMock(world),
    ...speech,
    /** Local browser-shell stand-ins; hosted flags never change available bridge members. */
    shell: {
      ...agentBrowse.shell,
      preview: new MockPreview(),
    },
    agentBrowseHosts: agentBrowse.agentBrowseHosts,
    simulateBrowseApproval: agentBrowse.simulateBrowseApproval,
    ...createTerminalMock(world),
    ...createThreadWakesMock(world),
  };
  return Object.assign(core, slices) satisfies Api;
}
export type MockApi = ReturnType<typeof createMockApi>;

/** What `window.gramMock` offers beyond `Api`: the dev and e2e scenario controls. */
export type MockControls = Omit<MockApi, keyof Api>;
