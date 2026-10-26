import {
  newWorkspaceCharter,
  modelRefOf,
  type StartTaskInput,
  type TaskModelSelection,
  type TaskWorkerChoice,
  type WorkerModel,
  type ThreadId,
  type UserInput,
} from "@gram/contracts";

import type { createMockOrchestration } from "../mock-orchestration";
import type { MockWorld } from "../mock-world";
import type { OrchestrationApi } from "./types";
import { MockInvalidState } from "../mock-fs";

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
  // Read only the synthetic world's stored choices; no fixture preview creates a holder.
  const taskPreflight = async (
    input: Pick<StartTaskInput, "target" | "direct" | "autonomy">,
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
    const orchestrator =
      held?.model ??
      state?.charter.orchestratorModel ??
      settings.agents.defaultModel ??
      charter.orchestratorModel;
    if (orchestrator === undefined)
      throw new MockInvalidState(
        "This synthetic workspace has no model choice. Select one in Settings → Workspaces.",
      );
    const { variant: _variant, ...bare } = orchestrator;
    const roster: readonly WorkerModel[] = charter.workerModels ?? [bare];
    const standing = roster.find((row) => row.default === true) ?? roster[0];
    // The synthetic world runs every harness.
    const workerChoices: TaskWorkerChoice[] = roster.map((row) => ({
      model: modelRefOf(row),
      ...(row.useFor === undefined ? {} : { useFor: row.useFor }),
      ...(row === standing ? { default: true as const } : {}),
    }));
    const picked = input.direct?.worker;
    const chosen =
      picked === undefined
        ? workerChoices.find((choice) => choice.default === true)
        : workerChoices.find(
            (choice) => JSON.stringify(choice.model) === JSON.stringify(modelRefOf(picked)),
          );
    if (input.direct !== undefined && picked !== undefined && chosen === undefined)
      throw new MockInvalidState("The picked worker model isn't on this workspace's roster.");
    if (picked !== undefined && chosen?.unavailable !== undefined)
      throw new MockInvalidState(`${chosen.model.model} can't start a worker here.`);
    const worker =
      input.direct === undefined || chosen?.unavailable !== undefined ? undefined : chosen?.model;
    return {
      orchestrator,
      ...(held === undefined ? {} : { orchestratorThreadId: held.id }),
      ...(worker === undefined ? {} : { worker }),
      ...(input.direct === undefined ? {} : { workerChoices }),
    };
  };
  return {
    listWorkspaces: () => orchestration.list(),
    saveWorkspace: (input) => orchestration.save(input),
    removeWorkspace: (workspaceId) => orchestration.remove(workspaceId),
    openOrchestrator: (target) => orchestration.open(target),
    taskPreflight,
    startTask: async (input) => {
      const shown = input.selection ?? (await taskPreflight(input));
      await taskPreflight(input);
      const created = await orchestration.open(input.target, input.autonomy);
      const orchestrator = { ...created, model: shown.orchestrator };
      world.replaceThread(orchestrator);
      const adoptedBy = (threadId: ThreadId) => adoptDraft(input.input, input.draftId, threadId);
      if (input.direct !== undefined) {
        const worker = await orchestration.startWorker(
          orchestrator,
          input.direct.projectId,
          input.input.text,
        );
        if (shown.worker !== undefined) world.replaceThread({ ...worker, model: shown.worker });
        await world.send(worker.id, adoptedBy(worker.id));
        return shown.worker === undefined ? worker : { ...worker, model: shown.worker };
      }
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
    switchOrchestrator: (workspaceId, model) =>
      orchestration.switchOrchestrator(workspaceId, model),
    retryOrchestratorSwitch: async () => {
      throw new Error("This invented mock has no failed startup owner to retry.");
    },
    cancelOrchestratorSwitch: (workspaceId) => orchestration.cancelSwitch(workspaceId),
    orchestratorHandoff: (workspaceId) => orchestration.handoff(workspaceId),
    threadDetach: (threadId) => orchestration.detach(threadId),
    threadJoinWorkspace: ({ threadId, workspaceId, ...options }) =>
      orchestration.join(threadId, workspaceId, options),
    threadJoinTargets: (threadId) => orchestration.joinTargets(threadId),
    releaseWorker: (threadId) => orchestration.release(threadId),
    releaseHeldBrief: (workspaceId, id) => orchestration.releaseHeldBrief(workspaceId, id),
    takeOverWorker: (threadId) => orchestration.takeOver(threadId),
    finishedWorkers: async (workspaceId) => orchestration.finishedWorkers(workspaceId),
    finishedWorker: async (threadId) => orchestration.finishedWorker(threadId),
  };
}
