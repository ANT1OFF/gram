import {
  connectorEntryProblem,
  autonomyOf,
  availableWorkspaceName,
  newWorkspaceCharter,
  orchestrationMode,
  featureState,
  workerHasOngoingWork,
  serializeDigest,
  cardShown,
  featureCardsText,
  reconcileFeatureCards,
  type FeatureCard,
  type FeatureCards,
  type FeatureCardSummary,
  type Autonomy,
  type ModelRef,
  type BudgetMeters,
  type CatchUpView,
  type FeatureGroupLedgerEntry,
  type HeldBrief,
  FEATURE_PLAN_MAX_STAGES,
  FEATURE_STAGE_MAX,
  FEATURE_STAGE_NOTE_MAX,
  type FeatureGroup,
  type FeatureStage,
  type FinishedWorker,
  type FinishedWorkerDetail,
  type GitState,
  type OrchestrationDigest,
  type OrchestratorCharter,
  type OrchestratorLedger,
  type PendingRequest,
  type PermissionMode,
  type Project,
  type ProjectId,
  type ReopenedMembership,
  type RequestAnswer,
  type Settings,
  type StuckView,
  type GramUIMessage,
  type JoinTarget,
  type Thread,
  ThreadNotFound,
  type ThreadId,
  type ThreadSummary,
  type UsageSummary,
  type WorkerRepo,
  type WorkerReport,
  type WorkspaceId,
  type WorkspaceState,
  type AnswerWorkerQuestionInput,
  type DismissWorkerQuestionInput,
  type WorkerQuestion,
  isOpenQuestion,
  workerAnswerMessage,
  workerDismissMessage,
} from "@gram/contracts";

import { createChannel } from "./channel";
import { MockInvalidState } from "./mock-fs";
import {
  simulateBoard,
  simulateLiveCards,
  simulateWorkerQuestions,
  simulateFinished,
  simulateArchivedGroups,
} from "./mock-board";
import { simulateWaits } from "./mock-board-waits";
import { simulateQuietBusy, simulateQuietWorkspaces } from "./mock-quiet";
import { simulateRelease } from "./mock-release";
import { simulate } from "./mock-orchestration-report";
import { ledgerEntry, slugOf, groupByFeature } from "./mock-ledger";
import { simulateReaching, type MockReachingSimulation } from "./mock-reaching";
import { simulateWorkersList, type MockWorkersSimulation } from "./mock-workers";
import type {
  ApiServerEvent,
  OpenOrchestratorTarget,
  SaveWorkspaceInput,
  SetStageInput,
} from "./types";

// Threaded orchestration for MockApi: workspaces, the orchestrator slot, the charter and pause.
// Nothing here spawns workers or wakes anyone by itself; the ledger is what the mock's threads say
// it is. `simulate` scripts one orchestrator with one worker so every card can be seen, and
// `simulateBoard` a workspace across repos so the tree, the board and the inbox have work to show:
// two features run as a staged group, a third on its own, and one worker that spans three repos.

export { groupByFeature, mockWorkerState } from "./mock-ledger";

/** One of a closed orchestrator's workers, as the server's closed list keeps it. */
export interface MockClosedWorker {
  readonly threadId: ThreadId;
  readonly feature: string;
}

/** What `reopen` asks `make` to put on a reopened thread. */
export type MockReopenFields = Partial<Pick<Thread, "role" | "workspaceId" | "spawnedBy">>;

export interface MockOrchestrationHost {
  projects(): readonly Project[];
  /** Every open thread; a closed one is gone from here, which is what frees its slot. */
  threads(): readonly Thread[];
  /** The thread with its status, requests, usage and git state. */
  summary(threadId: ThreadId): ThreadSummary | undefined;
  settings(): Promise<Settings>;
  /** A new idle thread in the project's main checkout, or with `branch` in a new worktree of it. */
  createThread(input: {
    projectRoot: string;
    title: string;
    mode: PermissionMode;
    branch?: string | undefined;
  }): Promise<Thread>;
  /** Stores the thread and emits `thread.upsert`. */
  replace(thread: Thread): void;
  putMessage(threadId: ThreadId, message: GramUIMessage): void;
  setStatus(threadId: ThreadId, status: ThreadSummary["status"], detail?: string): void;
  setGit(threadId: ThreadId, state: GitState): void;
  setUsage(threadId: ThreadId, usage: UsageSummary): void;
  /** Adds a pending request; `onAnswer` runs once `respond` answers it. */
  ask(threadId: ThreadId, request: PendingRequest, onAnswer: (answer: RequestAnswer) => void): void;
  emit(event: ApiServerEvent): void;
  ids(): string;
  /** Waits for the spec to release a held mock operation. */
  gate(name: string): Promise<void>;
  /** Runs `listener` after every event the mock emits, until the returned function is called. */
  onEvent(listener: (event: ApiServerEvent) => void): () => void;
  /** The board scenario's memory and dreams, which live in `mock-dreams.ts`. */
  seedMemory(workspaceId: WorkspaceId, projectIds: readonly ProjectId[]): Promise<void>;
  /** A server notice to a thread: steered into its running turn, else sent as its next turn. */
  deliver(threadId: ThreadId, text: string): Promise<"steered" | "sent">;
}

/**
 * What the scenario files (`mock-board.ts`, `mock-board-waits.ts`, `mock-quiet.ts`, `mock-release.ts`
 * and `mock-orchestration-report.ts`) read and change of the orchestration mock's state.
 */
export interface MockScenes {
  readonly host: MockOrchestrationHost;
  /** The workspaces now; `put` replaces the list. */
  readonly workspaces: () => readonly WorkspaceState[];
  /** Each worker's latest report. */
  readonly reports: Map<ThreadId, WorkerReport>;
  readonly askedAt: Map<string, number>;
  readonly overlaps: Map<ThreadId, readonly ThreadId[]>;
  /** Workers the user typed into since their last report. */
  readonly intervened: Set<ThreadId>;
  readonly closedWorkers: Map<ThreadId, FinishedWorkerDetail>;
  /** The other repos of a worker that spans several. */
  readonly alsoIn: Map<ThreadId, readonly WorkerRepo[]>;
  readonly find: (workspaceId: WorkspaceId) => WorkspaceState;
  readonly project: (projectId: ProjectId) => Project;
  /** The thread holding the slot, if it is still open. */
  readonly holder: (state: WorkspaceState) => Thread | undefined;
  readonly put: (next: WorkspaceState) => WorkspaceState;
  /** A new workspace, on the charter it was given, else the one the server would give it. */
  readonly create: (
    input: Omit<SaveWorkspaceInput, "id" | "charter">,
    given?: OrchestratorCharter | undefined,
  ) => Promise<WorkspaceState>;
  /** The slot's holder, or a new orchestrator thread in the home project that takes the slot. */
  readonly fillSlot: (state: WorkspaceState, settings: Settings) => Promise<Thread>;
  readonly oneProjectWorkspace: (
    projectId: ProjectId,
    autonomy?: Autonomy | undefined,
  ) => Promise<WorkspaceState>;
  readonly buildLedger: (state: WorkspaceState) => OrchestratorLedger;
  /** Each workspace's worker questions, oldest first. */
  readonly questionsOf: Map<WorkspaceId, readonly WorkerQuestion[]>;
  /** The question's card in its worker's transcript, in place of the one before. */
  readonly showQuestion: (question: WorkerQuestion) => void;
  /** The user's answer or dismissal: to the worker now, the card and the ledger moved on. */
  readonly closeQuestion: (
    workspaceId: WorkspaceId,
    questionId: string,
    close: { readonly answer: string } | { readonly dismissed: true; readonly reason?: string },
  ) => Promise<WorkerQuestion>;
  /** Each workspace's low-priority briefs held until a usage limit resets. */
  readonly heldOf: Map<WorkspaceId, readonly HeldBrief[]>;
  /** The timer that releases each held brief at its reset. */
  readonly heldTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Helper sentences armed per feature. */
  readonly summaries: Map<string, string>;
  readonly digestMessage: (digest: OrchestrationDigest) => GramUIMessage;
  readonly assistantMessage: (parts: GramUIMessage["parts"]) => GramUIMessage;
  /** The server's NotFound for a workspace or project. */
  readonly notFound: (entity: "workspace" | "project", id: string) => Error;
}

/** Which story `simulateOrchestration` tells. */
export type MockOrchestrationScenario = "report" | "board";

/** What `simulateOrchestration` made, for a spec to navigate by. */
export interface MockOrchestrationSimulation {
  readonly workspaceId: WorkspaceId;
  readonly orchestratorThreadId: ThreadId;
  readonly workerThreadId: ThreadId;
}

/** What the `board` scenario made: the workers of its cross-repo feature by what they are doing. */
export interface MockBoardSimulation {
  readonly workspaceId: WorkspaceId;
  readonly orchestratorThreadId: ThreadId;
  readonly working: ThreadId;
  /** Both wait on the same `git push`, with equal inputs. */
  readonly waiting: readonly [ThreadId, ThreadId];
  /** Waits on that command too, with a `timeout` the other two don't pass. */
  readonly waitingApart: ThreadId;
  readonly inReview: ThreadId;
  /** The second feature's only worker. */
  readonly briefed: ThreadId;
  /** The only worker of `docs-refresh`, the feature in no group; it waits on a question. */
  readonly ungrouped: ThreadId;
}

/** What `simulateFinished` added to the board scenario. */
/** The workers `simulateWaits` makes, by what each waits on. */
export interface MockWaitsSimulation {
  readonly ci: ThreadId;
  readonly reviewing: ThreadId;
  readonly owners: ThreadId;
  readonly yours: ThreadId;
  readonly merging: ThreadId;
  readonly changes: ThreadId;
  readonly running: ThreadId;
  readonly asking: ThreadId;
  readonly merged: ThreadId;
}

/** The workers `simulateQuietBusy` makes: some at work, some waiting on automation, one stopped. */
export interface MockQuietBusySimulation {
  readonly workspaceId: WorkspaceId;
  readonly orchestratorThreadId: ThreadId;
  readonly editing: ThreadId;
  readonly testing: ThreadId;
  readonly ci: ThreadId;
  readonly reviewing: ThreadId;
  readonly stacked: ThreadId;
  readonly conflicts: ThreadId;
}

export interface MockFinishedSimulation extends MockBoardSimulation {
  /** The two of `auth-refresh`, the one of `flaky-ci`, and `mail-trigger`'s schema worker. */
  readonly merged: readonly ThreadId[];
  readonly delivered: ThreadId;
  readonly archived: ThreadId;
}

/** The workers `simulateRelease` makes: what is still going, and what isn't. */
export interface MockReleaseSimulation {
  readonly running: ThreadId;
  readonly inReview: ThreadId;
  readonly asking: ThreadId;
  /** `0-8-notes`'s worker still writing, beside its two merged ones. */
  readonly notesRunning: ThreadId;
  readonly merged: readonly ThreadId[];
  readonly archived: ThreadId;
}

/** How long the mock waits after a change before it sends the ledger again, as the server debounces. */
const WATCH_DEBOUNCE_MS = 40;
/** How long a mock handoff takes to bring the fresh session up. */
const HANDOFF_MS = 600;

/** What `advanceStage` moves: a feature's stage, or that of a group of them. */
export type MockStageTarget = { readonly feature: string } | { readonly group: string };

const notFound = (entity: "workspace" | "project", id: string) =>
  Object.assign(new Error(`That ${entity} no longer exists.`), { _tag: "NotFound", entity, id });

/** The `workspace.*`, `orchestrator.*`, `thread.detach` and `thread.joinWorkspace` RPCs for the mock. */
export function createMockOrchestration(host: MockOrchestrationHost) {
  let workspaces: WorkspaceState[] = [];
  /** Each worker's latest report; only `simulate` files any. */
  const reports = new Map<ThreadId, WorkerReport>();
  const askedAt = new Map<string, number>();
  const overlaps = new Map<ThreadId, readonly ThreadId[]>();
  /** Workers the user typed into since their last report. */
  const intervened = new Set<ThreadId>();
  const closedWorkers = new Map<ThreadId, FinishedWorkerDetail>();
  /** The other repos of a worker that spans several. */
  const alsoIn = new Map<ThreadId, readonly WorkerRepo[]>();
  /** Workspaces whose orchestrator is between two agent sessions. */
  const handingOff = new Set<WorkspaceId>();

  const find = (workspaceId: WorkspaceId): WorkspaceState => {
    const state = workspaces.find((w) => w.workspace.id === workspaceId);
    if (!state) throw notFound("workspace", workspaceId);
    return state;
  };

  const project = (projectId: ProjectId): Project => {
    const found = host.projects().find((p) => p.id === projectId);
    if (!found) throw notFound("project", projectId);
    return found;
  };

  /** The thread holding the slot, if it is still open; like the server, a stale slot is empty. */
  const holder = (state: WorkspaceState): Thread | undefined =>
    host.threads().find((t) => t.id === state.workspace.orchestratorThreadId);

  const put = (next: WorkspaceState): WorkspaceState => {
    workspaces = workspaces.some((w) => w.workspace.id === next.workspace.id)
      ? workspaces.map((w) => (w.workspace.id === next.workspace.id ? next : w))
      : [...workspaces, next];
    return next;
  };

  /** A new workspace, on the charter it was given, else the one the server would give it (`newWorkspaceCharter`). */
  const create = async (
    input: Omit<SaveWorkspaceInput, "id" | "charter">,
    given?: OrchestratorCharter | undefined,
  ): Promise<WorkspaceState> => {
    const charter = given ?? newWorkspaceCharter((await host.settings()).agents);
    return put({
      workspace: {
        id: `w-${host.ids()}` as WorkspaceId,
        name: input.name,
        projectIds: input.projectIds,
        homeProjectId: input.homeProjectId,
        createdAt: Date.now(),
      },
      charter,
    });
  };

  /** The slot's holder, or a new orchestrator thread in the home project that takes the slot. */
  const fillSlot = async (state: WorkspaceState, settings: Settings): Promise<Thread> => {
    const existing = holder(state);
    if (existing) return existing;
    const created = await host.createThread({
      projectRoot: project(state.workspace.homeProjectId).root,
      title: `Orchestrator · ${state.workspace.name}`,
      mode: orchestrationMode(settings),
    });
    const own = state.charter.orchestratorModel;
    const thread: Thread = {
      ...created,
      role: "orchestrator",
      workspaceId: state.workspace.id,
      ...(own === undefined ? {} : { model: own }),
    };
    host.replace(thread);
    put({ ...state, workspace: { ...state.workspace, orchestratorThreadId: thread.id } });
    host.emit({ type: "workspaces.changed" });
    return thread;
  };

  const oneProjectWorkspace = async (
    projectId: ProjectId,
    autonomy?: Autonomy | undefined,
  ): Promise<WorkspaceState> => {
    const made = newWorkspaceCharter((await host.settings()).agents);
    const charter = autonomy === undefined ? made : { ...made, autonomy };
    const existing = workspaces.find(
      (w) => w.workspace.projectIds.length === 1 && w.workspace.homeProjectId === projectId,
    );
    if (existing !== undefined) {
      // As the server: a level the draft promised can't be kept by a workspace made meanwhile.
      if (autonomy !== undefined && autonomyOf(existing.charter) !== autonomy) {
        throw new MockInvalidState(
          `${existing.workspace.name} already has a workspace, at ${autonomyOf(existing.charter)} autonomy, which it keeps. Send again to start the task there.`,
        );
      }
      return existing;
    }
    // No await between choosing the name and create's synchronous put with this charter.
    return create(
      {
        name: availableWorkspaceName(
          project(projectId).name,
          workspaces.map(({ workspace }) => workspace.name),
        ),
        projectIds: [projectId],
        homeProjectId: projectId,
      },
      charter,
    );
  };

  const buildLedger = (state: WorkspaceState): OrchestratorLedger => {
    const orchestrator = holder(state);
    const workers = host
      .threads()
      .filter((t) => orchestrator !== undefined && t.spawnedBy?.threadId === orchestrator.id)
      .flatMap((t) => {
        const summary = host.summary(t.id);
        return summary === undefined || t.spawnedBy === undefined
          ? []
          : [
              ledgerEntry(
                summary,
                t.spawnedBy.feature,
                host.projects().find((p) => p.id === t.projectId)?.name ?? t.projectId,
                {
                  lastReport: reports.get(t.id),
                  askedAt,
                  overlapsWith: (overlaps.get(t.id) ?? []).filter((other) =>
                    host.threads().some((open) => open.id === other),
                  ),
                  userIntervened: intervened.has(t.id),
                  alsoIn: alsoIn.get(t.id),
                  now: Date.now(),
                },
              ),
            ];
      });
    const budget: BudgetMeters = {
      liveWorkers: workers.filter(
        (w) => !["archived", "merged", "delivered"].includes(w.state) || workerHasOngoingWork(w),
      ).length,
      maxConcurrentWorkers: state.charter.maxConcurrentWorkers,
      costUsdToday:
        workers.reduce((sum, w) => sum + (w.costUsd ?? 0), 0) +
        (orchestrator === undefined ? 0 : (host.summary(orchestrator.id)?.usage?.costUsd ?? 0)),
    };
    const groupOf = new Map(
      Object.entries(state.groups ?? {}).flatMap(([group, { features: slugs }]) =>
        slugs.map((slug) => [slug, group] as const),
      ),
    );
    const features = groupByFeature(workers).map((feature) => ({
      ...feature,
      ...(groupOf.has(feature.feature) ? { group: groupOf.get(feature.feature)! } : {}),
      ...(state.stages?.[feature.feature] === undefined
        ? {}
        : { stage: state.stages[feature.feature]! }),
      ...(state.pausedFeatures?.includes(feature.feature) === true
        ? { paused: true as const }
        : {}),
    }));
    const groups: FeatureGroupLedgerEntry[] = Object.entries(state.groups ?? {}).flatMap(
      ([group, { features: slugs, stage }]) => {
        const members = features.filter((feature) => slugs.includes(feature.feature));
        return members.length === 0
          ? []
          : [
              {
                group,
                features: slugs,
                state: featureState(members.map((member) => member.state)),
                ...(stage === undefined ? {} : { stage }),
              },
            ];
      },
    );
    const held = (heldOf.get(state.workspace.id) ?? []).toSorted((a, b) => a.until - b.until);
    const asked = questionsOf.get(state.workspace.id) ?? [];
    // As the server lists them: the open ones oldest first, then the closed ones newest first.
    const questions = [
      ...asked.filter(isOpenQuestion),
      ...asked
        .filter((question) => !isOpenQuestion(question))
        .toSorted((a, b) => (b.closedAt ?? b.askedAt) - (a.closedAt ?? a.askedAt)),
    ];
    return {
      workspaceId: state.workspace.id,
      ...(orchestrator === undefined ? {} : { orchestratorThreadId: orchestrator.id }),
      features,
      ...(groups.length === 0 ? {} : { groups }),
      budget,
      orchestratorEdits: 0,
      ...(state.paused === undefined ? {} : { paused: state.paused }),
      ...(held.length === 0 ? {} : { held }),
      ...(questions.length === 0 ? {} : { questions }),
      builtAt: Date.now(),
    };
  };

  /** Each workspace's worker questions (`ask_question`), oldest first; only the simulations ask any. */
  const questionsOf = new Map<WorkspaceId, readonly WorkerQuestion[]>();
  /** The message holding each question's card in its worker's transcript, replaced as it moves. */
  const questionCards = new Map<string, string>();

  /** The question's card in its worker's transcript, in place of the one before. */
  const showQuestion = (question: WorkerQuestion) => {
    const id = questionCards.get(question.id) ?? host.ids();
    questionCards.set(question.id, id);
    host.putMessage(question.threadId, {
      id,
      role: "assistant",
      metadata: { createdAt: question.askedAt },
      parts: [
        { type: "data-worker-question", id: `worker-question:${question.id}`, data: question },
      ],
    });
  };

  /** The user's answer or dismissal: to the worker now, the card and the ledger moved on. */
  const closeQuestion = async (
    workspaceId: WorkspaceId,
    questionId: string,
    close: { readonly answer: string } | { readonly dismissed: true; readonly reason?: string },
  ): Promise<WorkerQuestion> => {
    const all = questionsOf.get(workspaceId) ?? [];
    const question = all.find((each) => each.id.toLowerCase() === questionId.toLowerCase());
    if (question === undefined) {
      throw Object.assign(new Error(`There is no question ${questionId} in this workspace.`), {
        _tag: "NotFound",
        entity: "question",
        id: questionId,
      });
    }
    if (!isOpenQuestion(question)) {
      throw new MockInvalidState(`${question.id} is ${question.stage} already.`);
    }
    const text =
      "answer" in close
        ? workerAnswerMessage(question, close.answer, { closedBy: "user" })
        : workerDismissMessage(question, close.reason);
    const delivered = await host.deliver(question.threadId, text);
    const closed: WorkerQuestion = {
      ...question,
      stage: "answer" in close ? "answered" : "dismissed",
      ...("answer" in close ? { answer: close.answer } : {}),
      ...("dismissed" in close && close.reason !== undefined ? { reason: close.reason } : {}),
      closedBy: "user",
      closedAt: Date.now(),
      delivered,
    };
    questionsOf.set(
      workspaceId,
      all.map((each) => (each.id === closed.id ? closed : each)),
    );
    showQuestion(closed);
    host.emit({ type: "orchestration.changed", workspaceId });
    return closed;
  };

  /** Each workspace's low-priority briefs held until a usage limit resets (`simulateHeldBrief`). */
  const heldOf = new Map<WorkspaceId, readonly HeldBrief[]>();
  /** The timer that releases each held brief at its reset, as the server's alarm does. */
  const heldTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Each workspace's cards, as the server persists them. */
  const cardsOf = new Map<WorkspaceId, readonly FeatureCard[]>();

  /** The workers the workspace's orchestrator spawned for `feature`, parked ones aside. */
  const workersOfFeature = (state: WorkspaceState, feature: string): readonly Thread[] => {
    const orchestrator = holder(state);
    return host
      .threads()
      .filter(
        (t) =>
          orchestrator !== undefined &&
          t.spawnedBy?.threadId === orchestrator.id &&
          t.spawnedBy.feature === feature &&
          !t.parked,
      );
  };
  /** Whether a brief of `feature` is held in the workspace. */
  const heldIn = (workspaceId: WorkspaceId, feature: string): boolean =>
    (heldOf.get(workspaceId) ?? []).some((brief) => brief.feature === feature);
  /** Helper sentences armed per feature; none unless a scenario asks. */
  const summaries = new Map<string, string>();

  const syncCards = (state: WorkspaceState): FeatureCards => {
    const ledger = buildLedger(state);
    const threads = new Map(host.threads().map((thread) => [thread.id, thread]));
    const workers = ledger.features.flatMap((feature) => feature.workers);
    const { cards } = reconcileFeatureCards(cardsOf.get(state.workspace.id) ?? [], {
      workspaceId: state.workspace.id,
      features: ledger.features,
      models: new Map(
        workers.flatMap((worker) => {
          const model = threads.get(worker.threadId)?.model.model;
          return model === undefined ? [] : [[worker.threadId, model] as const];
        }),
      ),
      activity: new Map(
        workers.flatMap((worker) =>
          worker.activity === undefined ? [] : [[worker.threadId, worker.activity] as const],
        ),
      ),
      spawnedAt: new Map(
        workers.flatMap((worker) => {
          const at = threads.get(worker.threadId)?.createdAt;
          return at === undefined ? [] : [[worker.threadId, at] as const];
        }),
      ),
      held: ledger.held,
      now: Date.now(),
    });
    cardsOf.set(state.workspace.id, cards);
    return { workspaceId: state.workspace.id, cards };
  };

  const digestMessage = (digest: OrchestrationDigest): GramUIMessage => ({
    id: host.ids(),
    role: "user",
    metadata: { createdAt: Date.now() },
    parts: [
      { type: "text", text: serializeDigest(digest) },
      { type: "data-orchestration-digest", id: host.ids(), data: digest },
    ],
  });

  const assistantMessage = (parts: GramUIMessage["parts"]): GramUIMessage => ({
    id: host.ids(),
    role: "assistant",
    metadata: { createdAt: Date.now() },
    parts,
  });

  /** What the scenario files (`mock-board.ts` and the rest) read and change of this mock's state. */
  const scenes: MockScenes = {
    host,
    workspaces: () => workspaces,
    reports,
    askedAt,
    overlaps,
    intervened,
    closedWorkers,
    alsoIn,
    find,
    project,
    holder,
    put,
    create,
    fillSlot,
    oneProjectWorkspace,
    buildLedger,
    questionsOf,
    showQuestion,
    closeQuestion,
    heldOf,
    heldTimers,
    summaries,
    digestMessage,
    assistantMessage,
    notFound,
  };

  return {
    async list(): Promise<readonly WorkspaceState[]> {
      return workspaces;
    },

    /** The workspaces as they are now, for the mock's other halves. */
    peek(): readonly WorkspaceState[] {
      return workspaces;
    },

    async save(input: SaveWorkspaceInput): Promise<WorkspaceState> {
      input.projectIds.forEach(project);
      if (!input.projectIds.includes(input.homeProjectId)) {
        throw new MockInvalidState("The home project must be one of the workspace's projects.");
      }
      const { id, charter, ...rest } = input;
      const fields = { ...rest, name: input.name.trim() };
      if (charter !== undefined && id !== undefined) {
        throw new MockInvalidState(
          "A saved workspace's charter changes through orchestrator.setCharter.",
        );
      }
      const given =
        charter ??
        (id === undefined ? newWorkspaceCharter((await host.settings()).agents) : undefined);
      if (fields.name === "") throw new MockInvalidState("A workspace needs a name.");
      if (
        workspaces.some(
          ({ workspace }) =>
            workspace.id !== id &&
            workspace.name.trim().toLowerCase() === fields.name.toLowerCase(),
        )
      ) {
        throw new MockInvalidState("A workspace with that name already exists.");
      }
      const saved =
        id === undefined
          ? await create(fields, given)
          : put({ ...find(id), workspace: { ...find(id).workspace, ...fields } });
      host.emit({ type: "workspaces.changed" });
      return saved;
    },

    async remove(workspaceId: WorkspaceId): Promise<void> {
      const state = find(workspaceId);
      if (holder(state)) {
        throw new MockInvalidState(
          `Close the orchestrator of ${state.workspace.name} before removing the workspace.`,
        );
      }
      workspaces = workspaces.filter((w) => w.workspace.id !== workspaceId);
      host.emit({ type: "workspaces.changed" });
    },

    /** As the server's: `autonomy` is the level a workspace this makes for `projectId` starts at. */
    async open(target: OpenOrchestratorTarget, autonomy?: Autonomy | undefined): Promise<Thread> {
      const settings = await host.settings();
      const state =
        "workspaceId" in target
          ? find(target.workspaceId)
          : await oneProjectWorkspace(target.projectId, autonomy);
      return fillSlot(state, settings);
    },

    async setCharter(
      workspaceId: WorkspaceId,
      charter: OrchestratorCharter,
    ): Promise<WorkspaceState> {
      const set = charter.connectors;
      for (const entry of set === undefined ? [] : "allow" in set ? set.allow : set.deny) {
        const problem = connectorEntryProblem(entry);
        if (problem !== undefined) throw new MockInvalidState(`“${entry.trim()}”: ${problem}`);
      }
      const next = put({ ...find(workspaceId), charter });
      host.emit({ type: "orchestration.changed", workspaceId });
      return next;
    },

    async setPaused(workspaceId: WorkspaceId, paused: boolean): Promise<WorkspaceState> {
      const { paused: was, ...rest } = find(workspaceId);
      if (paused && was !== undefined) return find(workspaceId);
      const next = put(paused ? { ...rest, paused: { reason: "user", at: Date.now() } } : rest);
      // As the server: resuming unparks the orchestrator.
      const parkedHolder = holder(next);
      if (!paused && was !== undefined && parkedHolder?.parked === true) {
        host.replace({ ...parkedHolder, parked: false });
      }
      host.emit({ type: "orchestration.changed", workspaceId });
      return next;
    },

    async ledger(workspaceId: WorkspaceId): Promise<OrchestratorLedger> {
      return buildLedger(find(workspaceId));
    },

    /**
     * The ledger now, and again a beat after any event that could change it, unless it reads the
     * same as the last one sent (`builtAt` aside), as the server's stream behaves.
     */
    watchLedger(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<OrchestratorLedger> {
      find(workspaceId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let last = "";
      // Set after the channel exists: a signal that has aborted already closes it at once.
      let stop: (() => void) | undefined;
      const channel = createChannel<OrchestratorLedger>(signal, () => {
        clearTimeout(timer);
        stop?.();
      });
      const send = () => {
        timer = undefined;
        const state = workspaces.find((w) => w.workspace.id === workspaceId);
        if (state === undefined) return channel.close();
        const ledger = buildLedger(state);
        const { builtAt: _builtAt, ...rest } = ledger;
        const signature = JSON.stringify(rest);
        if (signature === last) return;
        last = signature;
        channel.push(ledger);
      };
      if (channel.closed) return channel;
      stop = host.onEvent((event) => {
        if (event.type === "notify" || event.type === "thread.identity") return;
        timer ??= setTimeout(send, WATCH_DEBOUNCE_MS);
      });
      send();
      return channel;
    },

    /** Each feature's card at its newest version, reconciled with the ledger as the server does. */
    async featureCards(workspaceId: WorkspaceId): Promise<FeatureCards> {
      return syncCards(find(workspaceId));
    },

    /**
     * The helper's sentence for a card's current version: one a scenario armed with
     * `simulateFeatureSummary`, else none, as with helpers off.
     */
    async featureSummary(
      workspaceId: WorkspaceId,
      feature: string,
    ): Promise<FeatureCardSummary | null> {
      const text = summaries.get(feature);
      const card = syncCards(find(workspaceId)).cards.find((each) => each.feature === feature);
      if (text === undefined || card === undefined) return null;
      const summary = { text, version: card.version };
      cardsOf.set(
        workspaceId,
        (cardsOf.get(workspaceId) ?? []).map((each) =>
          each.feature === feature && each.version === card.version ? { ...each, summary } : each,
        ),
      );
      return summary;
    },

    /** Arms the helper's sentence for a feature's card. */
    simulateFeatureSummary(feature: string, text: string) {
      summaries.set(feature, text);
    },

    /** The cards now, and again a beat after any event that changes one, as the server's stream. */
    watchFeatureCards(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<FeatureCards> {
      find(workspaceId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let last = "";
      let stop: (() => void) | undefined;
      const channel = createChannel<FeatureCards>(signal, () => {
        clearTimeout(timer);
        stop?.();
      });
      const send = () => {
        timer = undefined;
        const state = workspaces.find((w) => w.workspace.id === workspaceId);
        if (state === undefined) return channel.close();
        const cards = syncCards(state);
        const signature = featureCardsText(cards.cards);
        if (signature === last) return;
        last = signature;
        channel.push(cards);
      };
      if (channel.closed) return channel;
      stop = host.onEvent((event) => {
        if (event.type === "notify" || event.type === "thread.identity") return;
        timer ??= setTimeout(send, WATCH_DEBOUNCE_MS);
      });
      send();
      return channel;
    },

    async setStage(workspaceId: WorkspaceId, input: SetStageInput): Promise<WorkspaceState> {
      const state = find(workspaceId);
      if ((input.feature === undefined) === (input.group === undefined)) {
        throw new MockInvalidState(
          "Name a feature or a group to set the stage of, one and not both.",
        );
      }
      const onGroup = input.feature === undefined;
      const slug = slugOf(input.feature ?? input.group ?? "");
      const group = slug === undefined ? undefined : state.groups?.[slug];
      if (slug === undefined || (onGroup && group === undefined)) {
        throw new MockInvalidState(
          `No ${onGroup ? "group" : "feature"} is called ${slug ?? "that"}.`,
        );
      }
      const stage = input.stage.trim();
      const given =
        input.plan === undefined ? undefined : [...new Set(input.plan.map((name) => name.trim()))];
      const names = [stage, ...(given ?? [])];
      if (names.some((name) => name === "")) throw new MockInvalidState("A stage needs a name.");
      if (names.some((name) => name.length > FEATURE_STAGE_MAX)) {
        throw new MockInvalidState(`A stage's name is at most ${FEATURE_STAGE_MAX} characters.`);
      }
      if (given !== undefined && given.length > FEATURE_PLAN_MAX_STAGES) {
        throw new MockInvalidState(
          `A plan has at most ${FEATURE_PLAN_MAX_STAGES} stages; this one has ${given.length}.`,
        );
      }
      const current = onGroup ? group?.stage : state.stages?.[slug];
      const plan = given === undefined ? current?.plan : given.length === 0 ? undefined : given;
      if (plan !== undefined && !plan.includes(stage)) {
        throw new MockInvalidState(`"${stage}" isn't in this plan (${plan.join(" → ")}).`);
      }
      const note = input.note?.trim();
      if (note !== undefined && note.length > FEATURE_STAGE_NOTE_MAX) {
        throw new MockInvalidState(
          `A stage's note is at most ${FEATURE_STAGE_NOTE_MAX} characters; this one has ${note.length}.`,
        );
      }
      const stored: FeatureStage = {
        ...(plan === undefined ? {} : { plan }),
        stage,
        ...(note === undefined || note === "" ? {} : { note }),
        setBy: "user",
        setAt: Date.now(),
      };
      const next = put(
        onGroup && group !== undefined
          ? { ...state, groups: { ...state.groups, [slug]: { ...group, stage: stored } } }
          : { ...state, stages: { ...state.stages, [slug]: stored } },
      );
      host.emit({ type: "workspaces.changed" });
      host.emit({ type: "orchestration.changed", workspaceId });
      return next;
    },

    async setGroup(
      workspaceId: WorkspaceId,
      feature: string,
      group?: string | undefined,
    ): Promise<WorkspaceState> {
      const state = find(workspaceId);
      const target = group === undefined ? undefined : slugOf(group);
      if (group !== undefined && target === undefined) {
        throw new MockInvalidState(
          `"${group}" isn't a usable group name. Use a short slug such as release-0-4.`,
        );
      }
      const groups: Record<string, FeatureGroup> = {};
      for (const [name, each] of Object.entries(state.groups ?? {})) {
        const features = each.features.filter((slug) => slug !== feature);
        // A group left with nothing in it goes, unless somebody's word is still on it.
        if (features.length > 0 || each.stage !== undefined) groups[name] = { ...each, features };
      }
      if (target !== undefined) {
        const joined = groups[target] ?? { features: [] };
        groups[target] = { ...joined, features: [...joined.features, feature] };
      }
      const next = put({ ...state, groups });
      host.emit({ type: "workspaces.changed" });
      host.emit({ type: "orchestration.changed", workspaceId });
      return next;
    },

    /** As the server: parks every worker of the feature, refused while one runs or waits on you. */
    async archiveFeature(workspaceId: WorkspaceId, feature: string): Promise<readonly ThreadId[]> {
      const orchestrator = holder(find(workspaceId));
      const workers = host
        .threads()
        .filter(
          (t) =>
            orchestrator !== undefined &&
            t.spawnedBy?.threadId === orchestrator.id &&
            t.spawnedBy.feature === feature &&
            !t.parked,
        );
      if (workers.length === 0) {
        throw new MockInvalidState(`No feature called ${feature} has a worker left to archive.`);
      }
      const busy = workers.filter((t) => {
        const summary = host.summary(t.id);
        return (
          summary !== undefined &&
          (summary.pendingRequests.length > 0 ||
            summary.status === "running" ||
            summary.status === "starting")
        );
      });
      if (busy.length > 0) {
        const names = busy.map((t) => t.title).join(", ");
        throw new MockInvalidState(
          `${names} ${busy.length === 1 ? "is" : "are"} still running or waiting on you. Stop ${busy.length === 1 ? "it" : "them"} first.`,
        );
      }
      for (const worker of workers) host.replace({ ...worker, parked: true });
      // As the server: a pause on it goes with it.
      const state = find(workspaceId);
      if (state.pausedFeatures?.includes(feature) === true) {
        const kept = state.pausedFeatures.filter((each) => each !== feature);
        const { pausedFeatures: _, ...rest } = state;
        put(kept.length === 0 ? rest : { ...rest, pausedFeatures: kept });
      }
      host.emit({ type: "orchestration.changed", workspaceId });
      return workers.map((t) => t.id);
    },

    /**
     * As the server: pauses a feature, stopping its running workers, or resumes it. Refused for a
     * feature the workspace doesn't know.
     */
    async setFeaturePaused(
      workspaceId: WorkspaceId,
      raw: string,
      paused: boolean,
    ): Promise<WorkspaceState> {
      const state = find(workspaceId);
      const feature = slugOf(raw);
      if (feature === undefined)
        throw new MockInvalidState(`"${raw}" isn't a usable feature name.`);
      const workers = workersOfFeature(state, feature);
      if (paused && workers.length === 0 && !heldIn(workspaceId, feature)) {
        throw new MockInvalidState(`No feature is called ${feature} here.`);
      }
      const list = state.pausedFeatures ?? [];
      if (list.includes(feature) === paused) return state;
      const after = paused ? [...list, feature] : list.filter((each) => each !== feature);
      const { pausedFeatures: _, ...rest } = state;
      const next = put(after.length === 0 ? rest : { ...rest, pausedFeatures: after });
      if (paused) {
        for (const worker of workers) {
          const status = host.summary(worker.id)?.status;
          if (status === "running" || status === "starting") host.setStatus(worker.id, "idle");
        }
      }
      host.emit({ type: "workspaces.changed" });
      host.emit({ type: "orchestration.changed", workspaceId });
      return next;
    },

    /**
     * As the server: the feature takes its new slug on its workers, stage, groups, pause, held
     * briefs and card at once; refused for a name that isn't a slug or one another feature has.
     */
    async renameFeature(workspaceId: WorkspaceId, raw: string, rawTo: string): Promise<string> {
      const state = find(workspaceId);
      const from = slugOf(raw);
      if (from === undefined) throw new MockInvalidState(`"${raw}" isn't a usable feature name.`);
      const to = slugOf(rawTo);
      if (to === undefined) {
        throw new MockInvalidState(
          `"${rawTo.trim()}" isn't a usable feature name. Use a short slug such as mail-trigger.`,
        );
      }
      if (to === from) throw new MockInvalidState(`The feature is called ${from} already.`);
      const cards = syncCards(state).cards;
      const inUse = (slug: string) =>
        workersOfFeature(state, slug).length > 0 ||
        heldIn(workspaceId, slug) ||
        state.stages?.[slug] !== undefined ||
        Object.values(state.groups ?? {}).some((group) => group.features.includes(slug)) ||
        cards.some((card) => card.feature === slug && cardShown(card));
      if (!inUse(from)) throw new MockInvalidState(`No feature is called ${from} here.`);
      if (inUse(to)) {
        throw new MockInvalidState(`A feature called ${to} exists already. Pick another name.`);
      }
      const swap = (feature: string) => (feature === from ? to : feature);
      const { [from]: stage, ...stages } = state.stages ?? {};
      put({
        ...state,
        ...(state.stages === undefined
          ? {}
          : { stages: stage === undefined ? stages : { ...stages, [to]: stage } }),
        ...(state.groups === undefined
          ? {}
          : {
              groups: Object.fromEntries(
                Object.entries(state.groups).map(([name, group]) => [
                  name,
                  { ...group, features: group.features.map(swap) },
                ]),
              ),
            }),
        ...(state.pausedFeatures === undefined
          ? {}
          : { pausedFeatures: state.pausedFeatures.map(swap) }),
      });
      for (const worker of workersOfFeature(state, from)) {
        host.replace({ ...worker, spawnedBy: { ...worker.spawnedBy!, feature: to } });
      }
      heldOf.set(
        workspaceId,
        (heldOf.get(workspaceId) ?? []).map((brief) =>
          brief.feature === from ? { ...brief, feature: to } : brief,
        ),
      );
      const card = cards.find((each) => each.feature === from);
      if (card !== undefined) {
        const { summary: _summary, held: _held, ...rest } = card;
        cardsOf.set(workspaceId, [
          ...cards.filter((each) => each.feature !== from && each.feature !== to),
          { ...card, feature: to },
          { ...rest, workers: [], version: card.version + 1, updatedAt: Date.now() },
        ]);
      }
      const summary = summaries.get(from);
      if (summary !== undefined) {
        summaries.delete(from);
        summaries.set(to, summary);
      }
      host.emit({ type: "workspaces.changed" });
      host.emit({ type: "orchestration.changed", workspaceId });
      return to;
    },

    /**
     * A fresh agent session under the orchestrator's thread: it runs a checkpoint turn, then the
     * divider lands and the thread carries a new `agentSessionId`, which is how the UI knows it is over.
     */
    async switchOrchestrator(workspaceId: WorkspaceId, model: ModelRef): Promise<Thread> {
      const state = find(workspaceId);
      const current = holder(state);
      if (
        current === undefined ||
        current.parked ||
        current.sessionSwitch !== undefined ||
        handingOff.has(workspaceId)
      )
        throw new MockInvalidState("This workspace is not ready for an orchestrator switch.");
      if (model.agent !== "codex" && model.agent !== "claude")
        throw new MockInvalidState("Choose Codex or Claude Code.");
      if (model.profileId !== undefined)
        throw new MockInvalidState("Choose the installed CLI subscription login.");
      const id = host.ids();
      const change = {
        id,
        previous: current.model,
        target: model,
        mode: current.mode,
        phase: "checkpoint" as const,
        oldExited: false,
      };
      const next = { ...current, sessionSwitch: change };
      host.replace(next);
      const finish = () => {
        const before = host.threads().find((thread) => thread.id === current.id);
        if (before?.sessionSwitch?.id !== id) return;
        host.replace({
          ...before,
          sessionSwitch: { ...change, phase: "starting", oldExited: true },
        });
        const { sessionSwitch: _switch, ...rest } = before;
        host.replace({ ...rest, model, agentSessionId: `mock-session-${host.ids()}` });
        workspaces = workspaces.map((each) =>
          each.workspace.id === workspaceId
            ? { ...each, charter: { ...each.charter, orchestratorModel: model } }
            : each,
        );
        host.emit({ type: "workspaces.changed" });
        host.setStatus(current.id, "idle");
      };
      if (typeof window !== "undefined" && window.gramMockHoldGates === true)
        void host.gate("orchestrator-switch").then(finish);
      else setTimeout(finish, HANDOFF_MS);
      return next;
    },
    async cancelSwitch(workspaceId: WorkspaceId): Promise<void> {
      const current = holder(find(workspaceId));
      if (current?.sessionSwitch?.phase !== "checkpoint")
        throw new MockInvalidState("The previous session is already stopping.");
      const { sessionSwitch: _switch, ...rest } = current;
      host.replace(rest);
    },

    async handoff(workspaceId: WorkspaceId): Promise<Thread> {
      const state = find(workspaceId);
      const orchestrator = holder(state);
      if (orchestrator === undefined) {
        throw new MockInvalidState("This workspace has no orchestrator to hand off.");
      }
      if (handingOff.has(workspaceId)) {
        throw new MockInvalidState("A handoff is already running for this workspace.");
      }
      if (orchestrator.parked) {
        throw new MockInvalidState(
          "The orchestrator is parked. Unpark it to start a fresh session.",
        );
      }
      handingOff.add(workspaceId);
      host.setStatus(orchestrator.id, "running", "writing what isn't in memory yet");
      const finish = () => {
        handingOff.delete(workspaceId);
        const current = host.threads().find((t) => t.id === orchestrator.id);
        if (current === undefined) return;
        host.putMessage(
          orchestrator.id,
          assistantMessage([
            { type: "text", text: "ready" },
            {
              type: "data-handoff",
              id: host.ids(),
              data: {
                ...(current.agentSessionId === undefined
                  ? {}
                  : { previousAgentSessionId: current.agentSessionId }),
                reason: "user",
                at: Date.now(),
              },
            },
          ]),
        );
        host.replace({ ...current, agentSessionId: `mock-session-${host.ids()}` });
        host.setStatus(orchestrator.id, "idle");
      };
      // Windows can take longer than the whole mock handoff to finish a click. A spec that checks
      // the intermediate state releases it explicitly, just like the scripted agent's gates.
      if (typeof window !== "undefined" && window.gramMockHoldGates === true) {
        void host.gate("handoff").then(finish);
      } else {
        setTimeout(finish, HANDOFF_MS);
      }
      return orchestrator;
    },

    async detach(threadId: ThreadId): Promise<Thread> {
      const current = host.threads().find((t) => t.id === threadId);
      if (!current) throw new ThreadNotFound({ threadId });
      const { spawnedBy, workspaceId, ...rest } = current;
      if (spawnedBy === undefined) {
        throw new MockInvalidState("Only a thread an orchestrator spawned can be detached.");
      }
      host.replace(rest);
      reports.delete(threadId);
      overlaps.delete(threadId);
      intervened.delete(threadId);
      if (workspaceId !== undefined) host.emit({ type: "orchestration.changed", workspaceId });
      return rest;
    },

    /** Each workspace with an orchestrator open the thread could join, and whether that adds its repo. */
    async joinTargets(threadId: ThreadId): Promise<readonly JoinTarget[]> {
      const current = host.threads().find((t) => t.id === threadId);
      if (!current) throw new ThreadNotFound({ threadId });
      if (current.role !== undefined) return [];
      return workspaces
        .filter(
          (state) =>
            holder(state) !== undefined &&
            !(current.spawnedBy !== undefined && state.workspace.id === current.workspaceId),
        )
        .map(({ workspace }) => ({
          workspaceId: workspace.id,
          name: workspace.name,
          adds: workspace.projectIds.includes(current.projectId)
            ? []
            : [host.projects().find((p) => p.id === current.projectId)?.name ?? current.projectId],
        }));
    },

    /**
     * Add to workspace… and Move to workspace…: the thread becomes a worker of the workspace's
     * orchestrator, on a feature named from its branch, as the server's `joinWorkspace` makes it.
     */
    async join(
      threadId: ThreadId,
      workspaceId: WorkspaceId,
      options: { feature?: string | undefined; addRepos?: boolean | undefined },
    ): Promise<Thread> {
      const current = host.threads().find((t) => t.id === threadId);
      if (!current) throw new ThreadNotFound({ threadId });
      const state = find(workspaceId);
      const orchestrator = holder(state);
      if (orchestrator === undefined) {
        throw new MockInvalidState("This workspace has no orchestrator open to follow it.");
      }
      if (current.role !== undefined) {
        throw new MockInvalidState("An orchestrator can't be added to a workspace.");
      }
      if (current.spawnedBy?.threadId === orchestrator.id) {
        throw new MockInvalidState("It is already a worker of this workspace.");
      }
      if (current.checkout.kind !== "worktree") {
        throw new MockInvalidState("It works in the repo's main checkout.");
      }
      if (!state.workspace.projectIds.includes(current.projectId)) {
        if (options.addRepos !== true)
          throw new MockInvalidState("Its repo isn't in the workspace.");
        put({
          ...state,
          workspace: {
            ...state.workspace,
            projectIds: [...state.workspace.projectIds, current.projectId],
          },
        });
        host.emit({ type: "workspaces.changed" });
      }
      const feature =
        options.feature ??
        (current.checkout.branch?.replace(/^[a-z]+\//, "") || current.title)
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, "-")
          .replaceAll(/^-+|-+$/g, "");
      const left = current.workspaceId;
      const joined: Thread = {
        ...current,
        workspaceId,
        spawnedBy: { threadId: orchestrator.id, feature },
      };
      host.replace(joined);
      if (left !== undefined && left !== workspaceId) {
        reports.delete(threadId);
        overlaps.delete(threadId);
        host.emit({ type: "orchestration.changed", workspaceId: left });
      }
      host.emit({ type: "orchestration.changed", workspaceId });
      return joined;
    },

    async release(threadId: ThreadId): Promise<void> {
      const current = host.threads().find((t) => t.id === threadId);
      if (!current) throw new ThreadNotFound({ threadId });
      if (current.spawnedBy === undefined || current.workspaceId === undefined) {
        throw new MockInvalidState("This thread isn't a worker with an orchestrator listening.");
      }
      if (intervened.delete(threadId)) {
        host.emit({ type: "orchestration.changed", workspaceId: current.workspaceId });
      }
    },

    /** Workers closed with their worktree, as the server keeps them; none unless a scenario adds. */
    finishedWorkers(workspaceId: WorkspaceId): readonly FinishedWorker[] {
      return [...closedWorkers.values()]
        .map((detail) => detail.worker)
        .filter((worker) => worker.workspaceId === workspaceId)
        .toSorted((a, b) => b.closedAt - a.closedAt);
    },

    finishedWorker(threadId: ThreadId): FinishedWorkerDetail {
      const detail = closedWorkers.get(threadId);
      if (detail === undefined) throw new ThreadNotFound({ threadId });
      return detail;
    },

    /** Keeps a closed worker as the server's closed list would. */
    addFinished(detail: FinishedWorkerDetail): void {
      closedWorkers.set(detail.worker.threadId, detail);
      host.emit({ type: "orchestration.changed", workspaceId: detail.worker.workspaceId });
    },

    /** "Take over": the hold `userTyped` puts on a worker, by the same path, sending nothing. */
    async takeOver(threadId: ThreadId): Promise<void> {
      const current = host.threads().find((t) => t.id === threadId);
      if (!current) throw new ThreadNotFound({ threadId });
      if (current.spawnedBy === undefined || current.workspaceId === undefined) {
        throw new MockInvalidState("This thread isn't a worker with an orchestrator listening.");
      }
      if (intervened.has(threadId)) return;
      intervened.add(threadId);
      host.emit({ type: "orchestration.changed", workspaceId: current.workspaceId });
    },

    /**
     * New task straight to a worker: a worker of `orchestrator` in a new worktree of `projectId`,
     * on a feature named from the first words of `text` and numbered past the ones taken, as the
     * server's `startWorker` makes it. The caller sends it `text`, which holds it as the user's.
     */
    async startWorker(orchestrator: Thread, projectId: ProjectId, text: string): Promise<Thread> {
      const workspaceId = orchestrator.workspaceId;
      const state = workspaces.find((w) => w.workspace.id === workspaceId);
      if (workspaceId === undefined || state === undefined) throw notFound("workspace", "(none)");
      if (!state.workspace.projectIds.includes(projectId)) {
        throw new MockInvalidState(
          `That repo isn't one of the "${state.workspace.name}" workspace's.`,
        );
      }
      const line = text.split("\n").find((each) => each.trim() !== "") ?? "";
      const base =
        line
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((word) => word !== "")
          .slice(0, 5)
          .join("-")
          .slice(0, 45) || "task";
      const taken = new Set(
        host
          .threads()
          .flatMap((t) => (t.workspaceId === workspaceId ? [t.spawnedBy?.feature] : [])),
      );
      let feature = base;
      for (let n = 2; taken.has(feature); n++) feature = `${base}-${n}`;
      const created = await host.createThread({
        projectRoot: project(projectId).root,
        title: line.trim().slice(0, 60) || "New thread",
        mode: orchestrationMode(await host.settings()),
        branch: `feat/${feature}`,
      });
      const worker: Thread = {
        ...created,
        userNamed: false,
        workspaceId,
        spawnedBy: { threadId: orchestrator.id, feature },
      };
      host.replace(worker);
      host.emit({ type: "orchestration.changed", workspaceId });
      return worker;
    },

    /**
     * Dev and e2e hook: moves a feature's or a group's stage to the next step of its plan, as the
     * orchestrator's `set_stage` would, and returns it; `undefined` with no plan, or at the last step.
     */
    advanceStage(workspaceId: WorkspaceId, target: MockStageTarget): FeatureStage | undefined {
      const state = find(workspaceId);
      const current =
        "group" in target ? state.groups?.[target.group]?.stage : state.stages?.[target.feature];
      const next = current?.plan?.[(current.plan.indexOf(current.stage) ?? -1) + 1];
      if (current === undefined || next === undefined) return undefined;
      const { note: _note, ...rest } = current;
      const stage: FeatureStage = {
        ...rest,
        stage: next,
        setBy: "orchestrator",
        setAt: Date.now(),
      };
      put(
        "group" in target
          ? {
              ...state,
              groups: {
                ...state.groups,
                [target.group]: { ...state.groups![target.group]!, stage },
              },
            }
          : { ...state, stages: { ...state.stages, [target.feature]: stage } },
      );
      host.emit({ type: "orchestration.changed", workspaceId });
      return stage;
    },

    /** As the server: a parked orchestrator pauses its workspace, and unparking it resumes it. */
    parkChanged(threadId: ThreadId, parked: boolean): void {
      const state = workspaces.find((w) => w.workspace.orchestratorThreadId === threadId);
      if (state === undefined) return;
      const { paused, ...rest } = state;
      if (parked && paused === undefined) {
        put({ ...rest, paused: { reason: "parked", at: Date.now() } });
      } else if (!parked && paused?.reason === "parked") put(rest);
      else return;
      host.emit({ type: "workspaces.changed" });
      host.emit({ type: "orchestration.changed", workspaceId: state.workspace.id });
    },

    /**
     * As the server: closing an orchestrator cuts its workers loose, keeping `workspaceId`, and ends
     * the pause its park put on the workspace. Returns the workers it cut, for a reopen to link.
     */
    threadClosed(threadId: ThreadId): ReadonlyArray<MockClosedWorker> {
      const held = workspaces.find((w) => w.workspace.orchestratorThreadId === threadId);
      if (held?.paused?.reason === "parked") {
        const { paused: _, ...rest } = held;
        put(rest);
        host.emit({ type: "workspaces.changed" });
      }
      const cut: Array<MockClosedWorker> = [];
      for (const thread of host.threads()) {
        if (thread.spawnedBy?.threadId !== threadId) continue;
        cut.push({ threadId: thread.id, feature: thread.spawnedBy.feature });
        const { spawnedBy: _, ...rest } = thread;
        host.replace(rest);
      }
      return cut;
    },

    /**
     * As the server's `Orchestration.reopen`, without its admission check: `make` reopens the
     * thread with what of its place in a workspace can come back.
     */
    reopen(
      stored: Thread,
      workers: ReadonlyArray<MockClosedWorker>,
      make: (fields: MockReopenFields) => Thread,
    ): { readonly thread: Thread; readonly membership?: ReopenedMembership } {
      if (stored.workspaceId === undefined || stored.role === "dream") return { thread: make({}) };
      const state = workspaces.find((w) => w.workspace.id === stored.workspaceId);
      if (state === undefined) return { thread: make({}), membership: "workspaceGone" };
      const workspaceId = state.workspace.id;
      const current = holder(state);
      if (stored.role === "orchestrator") {
        if (current !== undefined)
          return { thread: make({ workspaceId }), membership: "slotTaken" };
        const thread = make({ workspaceId, role: "orchestrator" });
        put({ ...state, workspace: { ...state.workspace, orchestratorThreadId: thread.id } });
        for (const { threadId, feature } of workers) {
          const worker = host.threads().find((t) => t.id === threadId);
          if (
            worker === undefined ||
            worker.workspaceId !== workspaceId ||
            worker.spawnedBy !== undefined ||
            worker.role !== undefined
          ) {
            continue;
          }
          host.replace({ ...worker, spawnedBy: { threadId: thread.id, feature } });
        }
        host.emit({ type: "workspaces.changed" });
        host.emit({ type: "orchestration.changed", workspaceId });
        return { thread, membership: "restored" };
      }
      const { spawnedBy } = stored;
      if (spawnedBy === undefined) return { thread: make({ workspaceId }), membership: "restored" };
      if (current?.id !== spawnedBy.threadId) {
        return { thread: make({ workspaceId }), membership: "orchestratorGone" };
      }
      const thread = make({ workspaceId, spawnedBy });
      host.emit({ type: "orchestration.changed", workspaceId });
      return { thread, membership: "restored" };
    },

    /** The user sent `threadId` a message: a worker is marked so its orchestrator holds off. */
    userTyped(threadId: ThreadId): void {
      const thread = host.threads().find((t) => t.id === threadId);
      if (thread?.spawnedBy === undefined || intervened.has(threadId)) return;
      intervened.add(threadId);
      if (thread.workspaceId !== undefined) {
        host.emit({ type: "orchestration.changed", workspaceId: thread.workspaceId });
      }
    },

    /** `simulateBoard` (`mock-board.ts`). */
    simulateBoard(projectIds: readonly ProjectId[]) {
      return simulateBoard(scenes, projectIds);
    },

    /** `simulateLiveCards` (`mock-board.ts`). */
    simulateLiveCards(finished: MockFinishedSimulation) {
      return simulateLiveCards(scenes, finished);
    },

    /**
     * The user's answer to a worker's question, as the server's `workerQuestion.answer`: sent to the
     * worker, steered while it runs, and the card in its transcript moved on.
     */
    async answerWorkerQuestion(input: AnswerWorkerQuestionInput): Promise<WorkerQuestion> {
      return closeQuestion(input.workspaceId, input.questionId, { answer: input.answer.trim() });
    },

    /** The user's dismissal of a worker's question, told to the worker. */
    async dismissWorkerQuestion(input: DismissWorkerQuestionInput): Promise<WorkerQuestion> {
      const reason = input.reason?.trim();
      return closeQuestion(input.workspaceId, input.questionId, {
        dismissed: true,
        ...(reason === undefined || reason === "" ? {} : { reason }),
      });
    },

    /** `simulateWorkerQuestions` (`mock-board.ts`). */
    simulateWorkerQuestions(board: MockBoardSimulation) {
      return simulateWorkerQuestions(scenes, board);
    },

    /** `simulateFinished` (`mock-board.ts`). */
    simulateFinished(board: MockBoardSimulation) {
      return simulateFinished(scenes, board);
    },

    /**
     * The workspace's orchestrator briefs one worker in its home repo for `feature`, as
     * `spawn_worker` does: the worker starts `briefed`, and the feature's card follows.
     */
    async simulateBrief(workspaceId: WorkspaceId, feature: string, title: string): Promise<Thread> {
      const state = find(workspaceId);
      const orchestratorThreadId = state.workspace.orchestratorThreadId;
      if (orchestratorThreadId === undefined) {
        throw new MockInvalidState("That workspace has no orchestrator open.");
      }
      const settings = await host.settings();
      const created = await host.createThread({
        projectRoot: project(state.workspace.homeProjectId).root,
        title,
        mode: orchestrationMode(settings),
        branch: `feat/${feature}`,
      });
      const worker: Thread = {
        ...created,
        workspaceId,
        spawnedBy: { threadId: orchestratorThreadId, feature },
      };
      host.replace(worker);
      host.emit({ type: "orchestration.changed", workspaceId });
      return worker;
    },

    /**
     * The workspace's orchestrator asks for a low-priority brief while `agent`'s 5-hour limit is at
     * `usedPct`: held, as `spawn_worker` holds it, until `until` (epoch ms), when it starts on its
     * own. Timers this long only fire in a spec that moves the page clock.
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
      const state = find(workspaceId);
      const brief: HeldBrief = {
        id: `held-${Math.random().toString(36).slice(2, 10)}`,
        feature: input.feature,
        title: input.title,
        project: project(state.workspace.homeProjectId).name,
        agent: input.agent ?? "codex",
        window: "fiveHour",
        usedPct: input.usedPct ?? 85,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        until: input.until,
        heldAt: Date.now(),
      };
      heldOf.set(workspaceId, [...(heldOf.get(workspaceId) ?? []), brief]);
      heldTimers.set(
        brief.id,
        setTimeout(
          () => void this.releaseHeldBrief(workspaceId, brief.id).catch(() => undefined),
          Math.max(0, input.until - Date.now()),
        ),
      );
      host.emit({ type: "orchestration.changed", workspaceId });
      return brief;
    },

    /** Starts a held brief now, as the server's release does: its worker is briefed for its feature. */
    async releaseHeldBrief(workspaceId: WorkspaceId, id: string): Promise<Thread> {
      const held = heldOf.get(workspaceId) ?? [];
      const brief = held.find((each) => each.id === id);
      if (brief === undefined) {
        throw new MockInvalidState("That brief isn't held any more: it may have started already.");
      }
      if (find(workspaceId).pausedFeatures?.includes(brief.feature) === true) {
        throw new MockInvalidState(
          `You paused ${brief.feature}, so “${brief.title}” waits. Resume the feature to start it.`,
        );
      }
      clearTimeout(heldTimers.get(id));
      heldTimers.delete(id);
      heldOf.set(
        workspaceId,
        held.filter((each) => each.id !== id),
      );
      return this.simulateBrief(workspaceId, brief.feature, brief.title);
    },

    /** The ⌘J Workers list scenario (`mock-workers.ts`) beside the finished-work board. */
    simulateWorkersList(
      board: MockFinishedSimulation,
      catchUp: (view: CatchUpView) => void,
      options?: { readonly liveTools?: boolean },
    ): Promise<MockWorkersSimulation> {
      return simulateWorkersList(
        {
          host,
          home: (workspaceId) => project(find(workspaceId).workspace.homeProjectId),
          fileReport: (report) => void reports.set(report.threadId, report),
          catchUp,
        },
        board,
        options,
      );
    },

    /** Reaching workers (`mock-reaching.ts`) beside the ⌘J scenario: a cleaned-up and a stuck one. */
    simulateReaching(
      workers: MockWorkersSimulation,
      stuck: (view: StuckView) => void,
    ): Promise<MockReachingSimulation> {
      return simulateReaching(
        {
          host,
          home: (workspaceId) => project(find(workspaceId).workspace.homeProjectId),
          fileReport: (report) => void reports.set(report.threadId, report),
          addFinished: (detail) => {
            closedWorkers.set(detail.worker.threadId, detail);
          },
          stuck,
        },
        workers,
      );
    },

    /** `simulateArchivedGroups` (`mock-board.ts`). */
    simulateArchivedGroups(board: MockBoardSimulation) {
      return simulateArchivedGroups(scenes, board);
    },

    /** `simulateWaits` (`mock-board-waits.ts`). */
    simulateWaits(board: MockBoardSimulation) {
      return simulateWaits(scenes, board);
    },

    /** `simulateQuietBusy` (`mock-quiet.ts`). */
    simulateQuietBusy(projectIds: readonly ProjectId[]) {
      return simulateQuietBusy(scenes, projectIds);
    },

    /** `simulateRelease` (`mock-release.ts`). */
    simulateRelease(board: MockBoardSimulation) {
      return simulateRelease(scenes, board);
    },

    /** `simulateQuietWorkspaces` (`mock-quiet.ts`). */
    simulateQuietWorkspaces(projectIds: readonly ProjectId[]) {
      return simulateQuietWorkspaces(scenes, projectIds);
    },

    /** `simulate` (`mock-orchestration-report.ts`). */
    simulate(projectId: ProjectId) {
      return simulate(scenes, projectId);
    },
  };
}
