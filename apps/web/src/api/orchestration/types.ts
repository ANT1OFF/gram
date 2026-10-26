import type {
  AnswerWorkerQuestionInput,
  DismissWorkerQuestionInput,
  WorkerQuestion,
  FinishedWorker,
  FinishedWorkerDetail,
  JoinTarget,
  ModelRef,
  OrchestratorCharter,
  FeatureCards,
  FeatureCardSummary,
  OrchestratorLedger,
  StartTaskInput,
  TaskModelSelection,
  Thread,
  ThreadId,
  WorkspaceId,
  WorkspaceState,
} from "@gram/contracts";

import type { RpcPayload } from "../rpc-types";
import type { OpenOrchestratorTarget, SaveWorkspaceInput, SetStageInput } from "../types";

/** `workspace.*`, `orchestrator.*` and `thread.detach`/`joinWorkspace`: workspaces, their orchestrator and workers. */
export interface OrchestrationApi {
  /** Every workspace with its charter and pause; empty until orchestration has been used. */
  listWorkspaces(): Promise<readonly WorkspaceState[]>;
  /**
   * Creates a workspace with the default charter, or changes the name and projects of `input.id`.
   * Rejects with `NotFound` for an unknown workspace or project, `InvalidState` when the home
   * project isn't among the projects.
   */
  saveWorkspace(input: SaveWorkspaceInput): Promise<WorkspaceState>;
  /** Rejects with `InvalidState` while an orchestrator holds the workspace's slot. */
  removeWorkspace(workspaceId: WorkspaceId): Promise<void>;
  /**
   * The workspace's orchestrator thread: the one holding the slot, else a new one that takes it.
   * A `projectId` means that project's own one-project workspace, made on first use.
   */
  openOrchestrator(target: OpenOrchestratorTarget): Promise<Thread>;
  /**
   * ⌘N's New task: opens the target's orchestrator as `openOrchestrator` does and hands it the
   * input as the user's message, steered while it runs, or with `direct` starts one worker from
   * it, held as the user's. Resolves to the thread to open: the orchestrator, or the worker.
   * Rejects with `InvalidState` for a repo not in the target.
   */
  startTask(input: StartTaskInput): Promise<Thread>;
  taskPreflight(
    input: Pick<StartTaskInput, "target" | "direct" | "autonomy">,
  ): Promise<TaskModelSelection>;
  /** Replaces the budgets the workspace's orchestrator works inside. */
  setOrchestratorCharter(
    workspaceId: WorkspaceId,
    charter: OrchestratorCharter,
  ): Promise<WorkspaceState>;
  /** Pauses the orchestrator as the user, or resumes it whatever paused it. */
  setOrchestratorPaused(workspaceId: WorkspaceId, paused: boolean): Promise<WorkspaceState>;
  /** The workspace's workers by feature with the budget meters, built when asked for. */
  orchestratorLedger(workspaceId: WorkspaceId): Promise<OrchestratorLedger>;
  /**
   * The user's answer to a worker's question (docs/design/worker-questions.md), sent straight to
   * the worker. Rejects with `InvalidState` for one already closed, `NotFound` for none by that id.
   */
  answerWorkerQuestion(input: AnswerWorkerQuestionInput): Promise<WorkerQuestion>;
  /** The user's dismissal of a worker's question, with a reason or without; the worker is told. */
  dismissWorkerQuestion(input: DismissWorkerQuestionInput): Promise<WorkerQuestion>;
  /**
   * The ledger now, then again whenever it changes. Ends quietly, without the reconnect banner,
   * for a workspace that no longer exists.
   */
  watchLedger(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<OrchestratorLedger>;
  /** The workspace's live feature cards, oldest first, each feature once at its newest version. */
  featureCards(workspaceId: WorkspaceId): Promise<FeatureCards>;
  /** The cards now, then again whenever one changes; ends quietly for a workspace that is gone. */
  watchFeatureCards(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<FeatureCards>;
  /**
   * A feature card's helper sentence for its current version, set on the card as well; `null` with
   * helpers off, without consent, or when the call failed.
   */
  featureSummary(workspaceId: WorkspaceId, feature: string): Promise<FeatureCardSummary | null>;
  /**
   * Sets a feature's or a group's stage as the user. Rejects with `InvalidState` saying why: a
   * stage that isn't in the plan, a plan of more than eight, a name too long.
   */
  setOrchestratorStage(workspaceId: WorkspaceId, input: SetStageInput): Promise<WorkspaceState>;
  /** Puts a feature in a group, making the group if need be; without `group`, takes it out of its group. */
  setOrchestratorGroup(
    workspaceId: WorkspaceId,
    feature: string,
    group?: string | undefined,
  ): Promise<WorkspaceState>;
  /**
   * Archives a feature: parks each of its workers. Rejects with `InvalidState` saying why while one
   * runs or waits on the user. Resolves to the threads parked.
   */
  archiveFeature(workspaceId: WorkspaceId, feature: string): Promise<readonly ThreadId[]>;
  /**
   * Pauses a feature (its running workers stop; the orchestrator neither wakes for, messages nor
   * spawns for it) or resumes it. Rejects with `InvalidState` for a feature the workspace doesn't know.
   */
  setFeaturePaused(
    workspaceId: WorkspaceId,
    feature: string,
    paused: boolean,
  ): Promise<WorkspaceState>;
  /**
   * Renames a feature everywhere it keys at once; branches keep their names. Rejects with
   * `InvalidState` for a name that isn't a slug or one another feature has. Resolves to the new slug.
   */
  renameFeature(workspaceId: WorkspaceId, feature: string, to: string): Promise<string>;
  /**
   * Replaces the orchestrator's agent session with a fresh one under the same thread, the memory as
   * the bridge. Resolves once it is under way. Rejects with `InvalidState` without an orchestrator
   * and while another handoff runs.
   */
  orchestratorHandoff(workspaceId: WorkspaceId): Promise<Thread>;
  switchOrchestrator(workspaceId: WorkspaceId, model: ModelRef): Promise<Thread>;
  retryOrchestratorSwitch(workspaceId: WorkspaceId): Promise<Thread>;
  cancelOrchestratorSwitch(workspaceId: WorkspaceId): Promise<void>;
  /**
   * Makes a worker a plain thread again: its orchestrator stops seeing and steering it. The change
   * arrives as `thread.upsert`. Rejects with `InvalidState` for a thread that isn't a worker.
   */
  threadDetach(threadId: ThreadId): Promise<Thread>;
  /**
   * Add to workspace… and Move to workspace…: makes the thread a worker of the workspace's
   * orchestrator, leaving any workspace it was a worker of. The change arrives as `thread.upsert`.
   * Rejects with `InvalidState` saying why it can't join, a repo outside the workspace among them
   * unless `addRepos`.
   */
  threadJoinWorkspace(input: RpcPayload<"thread.joinWorkspace">): Promise<Thread>;
  /**
   * The workspaces the thread can join or move to, each with the names of the thread's repos
   * joining would add, matched as the server's join matches them. Empty while workspaces are off.
   */
  threadJoinTargets(threadId: ThreadId): Promise<readonly JoinTarget[]>;
  /**
   * Starts a low-priority brief held until a usage limit resets (`OrchestratorLedger.held`) now.
   * Resolves to the worker made; rejects with `InvalidState` saying why it couldn't start.
   */
  releaseHeldBrief(workspaceId: WorkspaceId, id: string): Promise<Thread>;
  /**
   * Hands a worker the user wrote to back to its orchestrator, which hears it in its next digest;
   * nothing is sent to the worker. The ledger follows as `orchestration.changed`. Rejects with
   * `InvalidState` for a thread that isn't a worker with an orchestrator listening.
   */
  releaseWorker(threadId: ThreadId): Promise<void>;
  /**
   * "Take over": holds the worker as a message typed into it would, sending it nothing. The ledger
   * follows as `orchestration.changed`.
   */
  takeOverWorker(threadId: ThreadId): Promise<void>;
  /** The workspace's workers closed with their worktree, newest first; live ones are the ledger's. */
  finishedWorkers(workspaceId: WorkspaceId): Promise<readonly FinishedWorker[]>;
  /**
   * One closed worker, read-only, from what Gram kept of it. Rejects with `ThreadNotFound` once
   * nothing is kept.
   */
  finishedWorker(threadId: ThreadId): Promise<FinishedWorkerDetail>;
}
