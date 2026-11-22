import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { ModelRef, Thread } from "../domain.ts";
import { AgentUnavailable, InvalidState, NotFound, ThreadNotFound } from "../errors.ts";
import { ProjectId, ThreadId, WorkspaceId } from "../ids.ts";
import { FeatureCards } from "../feature-cards.ts";
import { OrchestratorLedger } from "../orchestration.ts";
import { RoutineId, RoutineStatus } from "../routines.ts";
import { FinishedWorker, FinishedWorkerDetail, FinishedWorkersPage } from "../reaching-workers.ts";
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
  WorkspaceEnvironment,
  WorkspaceState,
} from "../workspaces.ts";
import { errors, threadRef } from "./shared.ts";

/**
 * Threaded orchestration: workspaces, their orchestrator, its ledger and its workers.
 */
export const OrchestrationRpcs = RpcGroup.make(
  Rpc.make("workspace.list", { success: Schema.Array(WorkspaceState), error: errors() }),
  Rpc.make("workspace.save", {
    payload: {
      id: Schema.optionalKey(WorkspaceId),
      name: Workspace.fields.name,
      projectIds: Workspace.fields.projectIds,
      homeProjectId: Workspace.fields.homeProjectId,
      charter: Schema.optionalKey(OrchestratorCharter),
      /** Its machine's environment (`Workspace.environment`): null goes back to the default, absent keeps it. */
      environment: Schema.optionalKey(Schema.NullOr(WorkspaceEnvironment)),
    },
    success: WorkspaceState,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("workspace.remove", {
    payload: {
      workspaceId: WorkspaceId,
      after: Schema.optionalKey(Schema.Struct({ at: Schema.Number, threadId: Schema.String })),
    },
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.open", {
    payload: {
      workspaceId: Schema.optionalKey(WorkspaceId),
      projectId: Schema.optionalKey(ProjectId),
    },
    success: Thread,
    error: errors(NotFound, InvalidState, AgentUnavailable),
  }),
  Rpc.make("workspace.startTask", {
    payload: StartTaskInput,
    success: Thread,
    error: errors(NotFound, InvalidState, AgentUnavailable, ThreadNotFound),
  }),
  Rpc.make("workspace.taskPreflight", {
    payload: {
      target: StartTaskInput.fields.target,
      autonomy: StartTaskInput.fields.autonomy,
      orchestrator: StartTaskInput.fields.orchestrator,
    },
    success: TaskModelSelection,
    error: errors(NotFound, InvalidState, AgentUnavailable),
  }),
  Rpc.make("orchestrator.setCharter", {
    payload: { workspaceId: WorkspaceId, charter: OrchestratorCharter },
    success: WorkspaceState,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.setPaused", {
    payload: { workspaceId: WorkspaceId, paused: Schema.Boolean },
    success: WorkspaceState,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.ledger", {
    payload: {
      workspaceId: WorkspaceId,
      after: Schema.optionalKey(Schema.Struct({ at: Schema.Number, threadId: Schema.String })),
    },
    success: OrchestratorLedger,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.watchLedger", {
    payload: {
      workspaceId: WorkspaceId,
      after: Schema.optionalKey(Schema.Struct({ at: Schema.Number, threadId: Schema.String })),
    },
    success: OrchestratorLedger,
    error: errors(NotFound),
    stream: true,
  }),
  Rpc.make("orchestrator.featureCards", {
    payload: {
      workspaceId: WorkspaceId,
      after: Schema.optionalKey(Schema.Struct({ at: Schema.Number, threadId: Schema.String })),
    },
    success: FeatureCards,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.watchFeatureCards", {
    payload: {
      workspaceId: WorkspaceId,
      after: Schema.optionalKey(Schema.Struct({ at: Schema.Number, threadId: Schema.String })),
    },
    success: FeatureCards,
    error: errors(NotFound),
    stream: true,
  }),
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
  Rpc.make("orchestrator.setGroup", {
    payload: {
      workspaceId: WorkspaceId,
      feature: Schema.String,
      group: Schema.optionalKey(Schema.String),
    },
    success: WorkspaceState,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.archiveFeature", {
    payload: { workspaceId: WorkspaceId, feature: Schema.String },
    success: Schema.Array(ThreadId),
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.setFeaturePaused", {
    payload: { workspaceId: WorkspaceId, feature: Schema.String, paused: Schema.Boolean },
    success: WorkspaceState,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.renameFeature", {
    payload: { workspaceId: WorkspaceId, feature: Schema.String, to: Schema.String },
    success: Schema.String,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.handoff", {
    payload: {
      workspaceId: WorkspaceId,
      checkpoint: Schema.optionalKey(Schema.Boolean),
      model: Schema.optionalKey(ModelRef),
      after: Schema.optionalKey(Schema.Struct({ at: Schema.Number, threadId: Schema.String })),
    },
    success: Thread,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.switch", {
    payload: {
      workspaceId: WorkspaceId,
      model: ModelRef,
      note: Schema.optionalKey(Schema.Boolean),
    },
    success: Thread,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.retrySwitch", {
    payload: {
      workspaceId: WorkspaceId,
      after: Schema.optionalKey(Schema.Struct({ at: Schema.Number, threadId: Schema.String })),
    },
    success: Thread,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("orchestrator.cancelSwitch", {
    payload: {
      workspaceId: WorkspaceId,
      after: Schema.optionalKey(Schema.Struct({ at: Schema.Number, threadId: Schema.String })),
    },
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("workerQuestion.answer", {
    payload: AnswerWorkerQuestionInput,
    success: WorkerQuestion,
    error: errors(NotFound, InvalidState, ThreadNotFound, AgentUnavailable),
  }),
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
  Rpc.make("orchestrator.finishedWorkers", {
    payload: {
      workspaceId: WorkspaceId,
      after: Schema.optionalKey(Schema.Struct({ at: Schema.Number, threadId: Schema.String })),
    },
    success: Schema.Array(FinishedWorker),
    error: errors(),
  }),
  Rpc.make("orchestrator.finishedWorkersPage", {
    payload: {
      workspaceId: WorkspaceId,
      after: Schema.optionalKey(Schema.Struct({ at: Schema.Number, threadId: Schema.String })),
    },
    success: FinishedWorkersPage,
    error: errors(),
  }),
  Rpc.make("orchestrator.finishedWorker", {
    payload: threadRef,
    success: FinishedWorkerDetail,
    error: errors(ThreadNotFound),
  }),
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
  Rpc.make("thread.detach", {
    payload: threadRef,
    success: Thread,
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("routine.list", {
    payload: { workspaceId: WorkspaceId },
    success: Schema.Array(RoutineStatus),
    error: errors(NotFound),
  }),
  Rpc.make("routine.run", {
    payload: { workspaceId: WorkspaceId, id: RoutineId },
    success: RoutineStatus,
    error: errors(NotFound, InvalidState),
  }),
);
