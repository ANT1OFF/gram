import {
  newWorkspaceCharter,
  type StartTaskInput,
  type TaskModelSelection,
  type ThreadId,
  type UserInput,
  firstChoiceOf,
} from "@gram/contracts";

import type { createMockOrchestration } from "../mock-orchestration";
import type { MockWorld } from "../mock-world";
import type { OrchestrationApi } from "./types";
import { MockInvalidState } from "../mock-fs";
import { mockFailOpen } from "../mock-overrides";

const throwIfOpenFailsByFlag = () => {
  const message = mockFailOpen();
  if (message !== undefined) throw new Error(message);
};

/** What the slice needs of the core: its orchestration mock, and a task's draft adopted. */
export interface OrchestrationDeps {
  readonly orchestration: ReturnType<typeof createMockOrchestration>;
  /** The task's input with the draft's files moved into `threadId`, as the server moves them. */
  readonly adoptDraft: (
    input: UserInput,
    draftId: string | undefined,
    threadId: ThreadId,
  ) => UserInput;
}

/** `OrchestrationApi` over the core's orchestration mock, whose host is the core's threads. */
export function createOrchestrationMock(
  world: MockWorld,
  { orchestration, adoptDraft }: OrchestrationDeps,
): OrchestrationApi {
  const taskPreflight = async (
    input: Pick<StartTaskInput, "target" | "autonomy" | "orchestrator">,
  ): Promise<TaskModelSelection> => {
    const state = orchestration
      .peek()
      .find((row) =>
        "workspaceId" in input.target
          ? row.workspace.id === input.target.workspaceId
          : row.workspace.projectIds.length === 1 &&
            row.workspace.projectIds[0] === input.target.projectId,
      );
    const settings = await world.settings();
    const charter = state?.charter ?? newWorkspaceCharter(settings.agents);
    const held = world
      .threads()
      .find((row) => row.thread.id === state?.workspace.orchestratorThreadId)?.thread;
    const slot =
      state?.charter.orchestratorModel ?? settings.agents.defaultModel ?? charter.orchestratorModel;
    const standingModel = held?.model ?? (slot === undefined ? undefined : firstChoiceOf(slot));
    const orchestrator = input.orchestrator ?? standingModel;
    const moves =
      held !== undefined &&
      input.orchestrator !== undefined &&
      JSON.stringify(held.model) !== JSON.stringify(input.orchestrator);
    if (orchestrator === undefined)
      throw new MockInvalidState(
        "This synthetic workspace has no model choice. Select one in Settings → Workspaces & merging.",
      );
    return {
      orchestrator,
      ...(held === undefined ? {} : { orchestratorThreadId: held.id }),
      ...(moves ? { orchestratorFrom: held.model } : {}),
    };
  };
  return {
    listWorkspaces: () => orchestration.list(),
    saveWorkspace: (input) => orchestration.save(input),
    removeWorkspace: (workspaceId) => orchestration.remove(workspaceId),
    openOrchestrator: async (target) => {
      throwIfOpenFailsByFlag();
      return orchestration.open(target);
    },
    taskPreflight,
    startTask: async (input) => {
      throwIfOpenFailsByFlag();
      const shown = input.selection ?? (await taskPreflight(input));
      await taskPreflight(input);
      const created = await orchestration.open(input.target, input.autonomy);
      const orchestrator = { ...created, model: shown.orchestrator };
      world.replaceThread(orchestrator);
      const adoptedBy = (threadId: ThreadId) => adoptDraft(input.input, input.draftId, threadId);
      const task = adoptedBy(orchestrator.id);
      if (world.running(orchestrator.id)) await world.steer(orchestrator.id, task);
      else await world.send(orchestrator.id, task);
      return orchestrator;
    },
    setOrchestratorCharter: (workspaceId, charter) =>
      orchestration.setCharter(workspaceId, charter),
    setOrchestratorPaused: (workspaceId, paused) => orchestration.setPaused(workspaceId, paused),
    orchestratorLedger: (workspaceId) => orchestration.ledger(workspaceId),
    answerWorkerQuestion: (input) => orchestration.answerWorkerQuestion(input),
    dismissWorkerQuestion: (input) => orchestration.dismissWorkerQuestion(input),
    watchLedger: (workspaceId, signal) => orchestration.watchLedger(workspaceId, signal),
    featureCards: (workspaceId) => orchestration.featureCards(workspaceId),
    featureSummary: (workspaceId, feature) => orchestration.featureSummary(workspaceId, feature),
    watchFeatureCards: (workspaceId, signal) =>
      orchestration.watchFeatureCards(workspaceId, signal),
    setOrchestratorStage: (workspaceId, input) => orchestration.setStage(workspaceId, input),
    setOrchestratorGroup: (workspaceId, feature, group) =>
      orchestration.setGroup(workspaceId, feature, group),
    archiveFeature: (workspaceId, feature) => orchestration.archiveFeature(workspaceId, feature),
    setFeaturePaused: (workspaceId, feature, paused) =>
      orchestration.setFeaturePaused(workspaceId, feature, paused),
    renameFeature: (workspaceId, feature, to) =>
      orchestration.renameFeature(workspaceId, feature, to),
    switchOrchestrator: (workspaceId, model, options) =>
      orchestration.switchOrchestrator(workspaceId, model, options),
    retryOrchestratorSwitch: async () => {
      throw new Error("This invented mock has no failed startup owner to retry.");
    },
    cancelOrchestratorSwitch: (workspaceId) => orchestration.cancelSwitch(workspaceId),
    orchestratorHandoff: (workspaceId, options) => orchestration.handoff(workspaceId, options),
    threadDetach: (threadId) => orchestration.detach(threadId),
    threadJoinWorkspace: ({ threadId, workspaceId, ...options }) =>
      orchestration.join(threadId, workspaceId, options),
    threadJoinTargets: (threadId) => orchestration.joinTargets(threadId),
    releaseHeldBrief: (workspaceId, id) => orchestration.releaseHeldBrief(workspaceId, id),
    finishedWorkers: async (workspaceId) => orchestration.finishedWorkers(workspaceId),
    finishedWorkersPage: async (workspaceId, after) =>
      orchestration.finishedWorkersPage(workspaceId, after),
    finishedWorker: async (threadId) => orchestration.finishedWorker(threadId),
  };
}
