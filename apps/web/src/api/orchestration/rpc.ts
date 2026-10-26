import { iterate, run, untilGone, type RpcContext } from "../rpc-client";
import type { OrchestrationApi } from "./types";

/** `OrchestrationApi` over the RPC client; the ledger feed ends for good once its workspace goes. */
export const orchestrationRpc = ({ client, connection }: RpcContext): OrchestrationApi => ({
  listWorkspaces: () => run(client["workspace.list"](undefined)),
  saveWorkspace: ({ id, name, projectIds, homeProjectId, charter }) =>
    run(
      client["workspace.save"]({
        ...(id === undefined ? {} : { id }),
        name,
        projectIds,
        homeProjectId,
        ...(charter === undefined ? {} : { charter }),
      }),
    ),
  removeWorkspace: (workspaceId) => run(client["workspace.remove"]({ workspaceId })),
  openOrchestrator: (target) => run(client["orchestrator.open"](target)),
  startTask: (input) => run(client["workspace.startTask"](input)),
  taskPreflight: (input) => run(client["workspace.taskPreflight"](input)),
  setOrchestratorCharter: (workspaceId, charter) =>
    run(client["orchestrator.setCharter"]({ workspaceId, charter })),
  setOrchestratorPaused: (workspaceId, paused) =>
    run(client["orchestrator.setPaused"]({ workspaceId, paused })),
  orchestratorLedger: (workspaceId) => run(client["orchestrator.ledger"]({ workspaceId })),
  answerWorkerQuestion: (input) => run(client["workerQuestion.answer"](input)),
  dismissWorkerQuestion: (input) => run(client["workerQuestion.dismiss"](input)),
  watchLedger: (workspaceId, signal) =>
    untilGone(
      (s) => iterate(client["orchestrator.watchLedger"]({ workspaceId }), s),
      connection,
      signal,
    ),
  featureCards: (workspaceId) => run(client["orchestrator.featureCards"]({ workspaceId })),
  featureSummary: (workspaceId, feature) =>
    run(client["orchestrator.featureSummary"]({ workspaceId, feature })),
  watchFeatureCards: (workspaceId, signal) =>
    untilGone(
      (s) => iterate(client["orchestrator.watchFeatureCards"]({ workspaceId }), s),
      connection,
      signal,
    ),
  setOrchestratorStage: (workspaceId, { feature, group, stage, plan, note }) =>
    run(
      client["orchestrator.setStage"]({
        workspaceId,
        stage,
        ...(feature === undefined ? {} : { feature }),
        ...(group === undefined ? {} : { group }),
        ...(plan === undefined ? {} : { plan: [...plan] }),
        ...(note === undefined ? {} : { note }),
      }),
    ),
  setOrchestratorGroup: (workspaceId, feature, group) =>
    run(
      client["orchestrator.setGroup"]({
        workspaceId,
        feature,
        ...(group === undefined ? {} : { group }),
      }),
    ),
  archiveFeature: (workspaceId, feature) =>
    run(client["orchestrator.archiveFeature"]({ workspaceId, feature })),
  setFeaturePaused: (workspaceId, feature, paused) =>
    run(client["orchestrator.setFeaturePaused"]({ workspaceId, feature, paused })),
  renameFeature: (workspaceId, feature, to) =>
    run(client["orchestrator.renameFeature"]({ workspaceId, feature, to })),
  switchOrchestrator: (workspaceId, model) =>
    run(client["orchestrator.switch"]({ workspaceId, model })),
  retryOrchestratorSwitch: (workspaceId) =>
    run(client["orchestrator.retrySwitch"]({ workspaceId })),
  cancelOrchestratorSwitch: (workspaceId) =>
    run(client["orchestrator.cancelSwitch"]({ workspaceId })),
  orchestratorHandoff: (workspaceId) => run(client["orchestrator.handoff"]({ workspaceId })),
  threadDetach: (threadId) => run(client["thread.detach"]({ threadId })),
  threadJoinWorkspace: (input) => run(client["thread.joinWorkspace"](input)),
  threadJoinTargets: (threadId) => run(client["thread.joinTargets"]({ threadId })),
  releaseWorker: (threadId) => run(client["orchestrator.releaseWorker"]({ threadId })),
  releaseHeldBrief: (workspaceId, id) =>
    run(client["orchestrator.releaseHeldBrief"]({ workspaceId, id })),
  takeOverWorker: (threadId) => run(client["orchestrator.takeOverWorker"]({ threadId })),
  finishedWorkers: (workspaceId) => run(client["orchestrator.finishedWorkers"]({ workspaceId })),
  finishedWorker: (threadId) => run(client["orchestrator.finishedWorker"]({ threadId })),
});
