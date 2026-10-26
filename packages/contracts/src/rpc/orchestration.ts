import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { ModelRef, Thread } from "../domain.ts";
import { AgentUnavailable, InvalidState, NotFound, ThreadNotFound } from "../errors.ts";
import { ProjectId, ThreadId, WorkspaceId } from "../ids.ts";
import { FeatureCards } from "../feature-cards.ts";
import { OrchestratorLedger } from "../orchestration.ts";
import { FinishedWorker, FinishedWorkerDetail } from "../reaching-workers.ts";
import { TaskModelSelection } from "../task-preflight.ts";
import {
  AnswerWorkerQuestionInput,
  DismissWorkerQuestionInput,
  WorkerQuestion,
} from "../worker-questions.ts";
import {
  JoinTarget,
  OrchestratorCharter,
  StartTaskInput,
  Workspace,
  WorkspaceState,
} from "../workspaces.ts";
import { errors, threadRef } from "./shared.ts";

/**
 * Threaded orchestration: workspaces, their orchestrator, its ledger and its workers.
 */
export const OrchestrationRpcs = RpcGroup.make(
  Rpc.make("workspace.list", { success: Schema.Array(WorkspaceState), error: errors() }),
  /**
   * Creates a workspace, or with `id` renames one and replaces its projects. A new workspace takes
   * `charter` whole, or starts with the default charter and the app's roster; with `id` a charter is
   * refused, since `orchestrator.setCharter` is what changes one.
   * Names must be unique after trimming and ignoring case; a conflict is `InvalidState`.
   */
  Rpc.make("workspace.save", {
    payload: {
      id: Schema.optionalKey(WorkspaceId),
      name: Workspace.fields.name,
      projectIds: Workspace.fields.projectIds,
      homeProjectId: Workspace.fields.homeProjectId,
      charter: Schema.optionalKey(OrchestratorCharter),
    },
    success: WorkspaceState,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * Refused while an orchestrator holds the workspace's slot. The workspace's memory directory is
   * left on disk, under the data dir's `orchestration/<workspaceId>`: what an orchestrator
   * learned is the user's, and removing a workspace is no request to delete it.
   */
  Rpc.make("workspace.remove", {
    payload: { workspaceId: WorkspaceId },
    error: errors(NotFound, InvalidState),
  }),
  /**
   * The workspace's orchestrator thread, created if nobody holds the slot. Exactly one of the two:
   * `projectId` names the one-project workspace of that project, made on first use.
   * An automatically created workspace uses the project's name with a numbered suffix if taken.
   */
  Rpc.make("orchestrator.open", {
    payload: {
      workspaceId: Schema.optionalKey(WorkspaceId),
      projectId: Schema.optionalKey(ProjectId),
    },
    success: Thread,
    error: errors(NotFound, InvalidState, AgentUnavailable),
  }),
  /**
   * ⌘N's New task. Opens the target's orchestrator as `orchestrator.open` does, then hands it the
   * input as the user's message, steered while it runs; with `direct`, starts a worker from it
   * instead, held as the user's. The thread to open: the orchestrator,
   * or the new worker.
   */
  Rpc.make("workspace.startTask", {
    payload: StartTaskInput,
    success: Thread,
    error: errors(NotFound, InvalidState, AgentUnavailable, ThreadNotFound),
  }),
  Rpc.make("workspace.taskPreflight", {
    payload: {
      target: StartTaskInput.fields.target,
      direct: StartTaskInput.fields.direct,
      autonomy: StartTaskInput.fields.autonomy,
    },
    success: TaskModelSelection,
    error: errors(NotFound, InvalidState, AgentUnavailable),
  }),
  Rpc.make("orchestrator.setCharter", {
    payload: { workspaceId: WorkspaceId, charter: OrchestratorCharter },
    success: WorkspaceState,
    error: errors(NotFound, InvalidState),
  }),
  /** Pausing is the user's (`reason: "user"`); resuming clears a pause of any reason. */
  Rpc.make("orchestrator.setPaused", {
    payload: { workspaceId: WorkspaceId, paused: Schema.Boolean },
    success: WorkspaceState,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.ledger", {
    payload: { workspaceId: WorkspaceId },
    success: OrchestratorLedger,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * The ledger now, then again whenever it changes: a worker's status, requests, report, git or
   * PR state, a stage or a group. Debounced, and a ledger that reads the same as the last one sent
   * (its `builtAt` aside) is not sent again. Ends when the client unsubscribes.
   */
  Rpc.make("orchestrator.watchLedger", {
    payload: { workspaceId: WorkspaceId },
    success: OrchestratorLedger,
    error: errors(NotFound),
    stream: true,
  }),
  /**
   * The workspace's live feature cards, oldest first, brought up to date with the ledger: each
   * feature once, its `version` grown whenever anything it shows changed. Persisted, so they
   * survive a reload.
   */
  Rpc.make("orchestrator.featureCards", {
    payload: { workspaceId: WorkspaceId },
    success: FeatureCards,
    error: errors(NotFound, InvalidState),
  }),
  /** The cards now, then again whenever one changes. Debounced; ends when the client unsubscribes. */
  Rpc.make("orchestrator.watchFeatureCards", {
    payload: { workspaceId: WorkspaceId },
    success: FeatureCards,
    error: errors(NotFound),
    stream: true,
  }),
  /**
   * The user sets a feature's or a group's stage: exactly one of `feature` and `group`. Without a
   * `plan` the target keeps the plan it has, and `stage` must then be one of it. The orchestrator
   * reads the change in its next digest. `InvalidState` carries why a stage was refused.
   */
  Rpc.make("orchestrator.setStage", {
    payload: {
      workspaceId: WorkspaceId,
      feature: Schema.optionalKey(Schema.String),
      group: Schema.optionalKey(Schema.String),
      stage: Schema.String,
      plan: Schema.optionalKey(Schema.Array(Schema.String)),
      note: Schema.optionalKey(Schema.String),
    },
    success: WorkspaceState,
    error: errors(NotFound, InvalidState),
  }),
  /** Puts a feature in a group, making the group if need be; without `group`, takes it out of its group. */
  Rpc.make("orchestrator.setGroup", {
    payload: {
      workspaceId: WorkspaceId,
      feature: Schema.String,
      group: Schema.optionalKey(Schema.String),
    },
    success: WorkspaceState,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * The user archives a feature: each of its workers is parked, so the ledger reads it archived and
   * it leaves the Board. `InvalidState` while one of them runs or waits on the user, or when it has
   * no worker left to park. The orchestrator reads it in its next digest. The threads parked.
   */
  Rpc.make("orchestrator.archiveFeature", {
    payload: { workspaceId: WorkspaceId, feature: Schema.String },
    success: Schema.Array(ThreadId),
    error: errors(NotFound, InvalidState),
  }),
  /**
   * The user pauses a feature, or resumes it. Paused, its running workers are interrupted, the
   * orchestrator isn't woken for them, can't message them and spawns none for it; the Board and the
   * sheet say "Paused". The orchestrator reads either in its next digest. `InvalidState` for a name
   * that isn't a slug or a feature the workspace doesn't know. The workspace as it is now.
   */
  Rpc.make("orchestrator.setFeaturePaused", {
    payload: { workspaceId: WorkspaceId, feature: Schema.String, paused: Schema.Boolean },
    success: WorkspaceState,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * The user renames a feature: its slug changes at once everywhere it keys (its workers, stage,
   * group, pause, card, held briefs and the orchestrator's last snapshot), and the orchestrator is
   * told the new name in its next digest. Branches keep their names. `InvalidState` for a name that
   * isn't a slug or one another feature has. The new slug.
   */
  Rpc.make("orchestrator.renameFeature", {
    payload: { workspaceId: WorkspaceId, feature: Schema.String, to: Schema.String },
    success: Schema.String,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * Replaces the orchestrator's agent session with a fresh one under the same thread, the memory
   * as the bridge. Returns once it is under way. `InvalidState` while the setting is off, without
   * an orchestrator, and while another handoff is running.
   */
  Rpc.make("orchestrator.handoff", {
    payload: { workspaceId: WorkspaceId },
    success: Thread,
    error: errors(NotFound, InvalidState),
  }),
  /** Explicit user action. Completes asynchronously after checkpoint, graceful exit and target acknowledgement. */
  Rpc.make("orchestrator.switch", {
    payload: { workspaceId: WorkspaceId, model: ModelRef },
    success: Thread,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.retrySwitch", {
    payload: { workspaceId: WorkspaceId },
    success: Thread,
    error: errors(NotFound, InvalidState),
  }),
  /** Cancels a requested switch only before shutdown starts. */
  Rpc.make("orchestrator.cancelSwitch", {
    payload: { workspaceId: WorkspaceId },
    error: errors(NotFound, InvalidState),
  }),
  /**
   * Hands a worker the user wrote to back to its orchestrator: clears its `userIntervened`, and
   * the orchestrator's next digest says so. Nothing is sent to the worker. `InvalidState` for a
   * thread that isn't a worker with an orchestrator listening.
   */
  Rpc.make("orchestrator.releaseWorker", {
    payload: threadRef,
    error: errors(ThreadNotFound, InvalidState),
  }),
  /**
   * Spawns a low-priority brief held until a usage limit resets (`OrchestratorLedger.held`) now,
   * without waiting for the reset; the orchestrator reads it in its next digest. The worker made.
   * `InvalidState` for a brief no longer held, or when the spawn itself is refused.
   */
  /**
   * The user's answer to a worker's question (docs/design/worker-questions.md), from any surface:
   * sent straight to the worker, steered while it runs and queued while it is idle, with a copy in
   * the orchestrator's next digest. The user may answer one still in triage too: their word outranks
   * the orchestrator's. `InvalidState` for a question already closed; `NotFound` for none by that id.
   */
  Rpc.make("workerQuestion.answer", {
    payload: AnswerWorkerQuestionInput,
    success: WorkerQuestion,
    error: errors(NotFound, InvalidState, ThreadNotFound, AgentUnavailable),
  }),
  /** The user's dismissal of a worker's question, with an optional reason; the worker is told too. */
  Rpc.make("workerQuestion.dismiss", {
    payload: DismissWorkerQuestionInput,
    success: WorkerQuestion,
    error: errors(NotFound, InvalidState, ThreadNotFound, AgentUnavailable),
  }),
  Rpc.make("orchestrator.releaseHeldBrief", {
    payload: { workspaceId: WorkspaceId, id: Schema.String },
    success: Thread,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * The explicit "Take over": holds a worker for the user exactly as a message they type into it
   * does (`userIntervened`, lapsing as that hold lapses), without sending it anything. `InvalidState`
   * for a thread that isn't a worker with an orchestrator listening.
   */
  Rpc.make("orchestrator.takeOverWorker", {
    payload: threadRef,
    error: errors(ThreadNotFound, InvalidState),
  }),
  /**
   * The workspace's workers that were closed with their worktree, newest first: those still on the
   * reopen list, then those only its transcript archive keeps. Live workers are the ledger's.
   */
  Rpc.make("orchestrator.finishedWorkers", {
    payload: { workspaceId: WorkspaceId },
    success: Schema.Array(FinishedWorker),
    error: errors(),
  }),
  /**
   * One closed worker, read-only, from what Gram kept of it: its record, reports and conversation,
   * or the archived transcript alone. `ThreadNotFound` once neither has it.
   */
  Rpc.make("orchestrator.finishedWorker", {
    payload: threadRef,
    success: FinishedWorkerDetail,
    error: errors(ThreadNotFound),
  }),
  /**
   * Makes a thread a worker of the workspace's orchestrator: a plain
   * thread joins, and a worker of another workspace moves, leaving that one. `feature` is the one
   * it goes under, else it is named from its branch or title. `addRepos` adds the thread's repos to
   * the workspace when they aren't in it, which without it is `InvalidState` naming them. So is a
   * workspace with no orchestrator, an orchestrator or dream thread, one already a worker there, and
   * one in a repo's main checkout or outside git.
   */
  /**
   * The workspaces the thread can join or move to: each with an orchestrator open, its own left out
   * for a worker, none for an orchestrator or a dream or while workspaces are off. `adds` names the
   * thread's repos, its extra worktrees' included, that joining would add.
   */
  Rpc.make("thread.joinTargets", {
    payload: threadRef,
    success: Schema.Array(JoinTarget),
    error: errors(ThreadNotFound),
  }),
  Rpc.make("thread.joinWorkspace", {
    payload: {
      threadId: ThreadId,
      workspaceId: WorkspaceId,
      feature: Schema.optionalKey(Schema.String),
      group: Schema.optionalKey(Schema.String),
      addRepos: Schema.optionalKey(Schema.Boolean),
    },
    success: Thread,
    error: errors(ThreadNotFound, NotFound, InvalidState),
  }),
  /** Makes a worker a plain thread: clears `spawnedBy` and `workspaceId`, so delegation ends. */
  Rpc.make("thread.detach", {
    payload: threadRef,
    success: Thread,
    error: errors(ThreadNotFound, InvalidState),
  }),
);
