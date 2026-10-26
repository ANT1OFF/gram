// Task startup: the user's start of a task in a workspace, with
// the model it opens on, the workers it may use, its preflight and the lock against a charter commit.
import {
  autonomyOf,
  InvalidState,
  type ModelRef,
  type OrchestratorCharter,
  type ProjectId,
  type WorkerModel,
  type StartTaskInput,
  type TaskModelSelection,
  type TaskWorkerChoice,
  modelRefOf,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { discoverDefaultModel } from "../../runtime/default-model.ts";
import { subscriptionTaskCharter } from "../task-models.ts";
import { sameTaskModel, sameTaskSelection } from "../task-selection.ts";
import {
  admittedForRole,
  gateNeedsReason,
  gateOfAutonomy,
  kindName,
  fallbackOf,
  startModeFor,
  workerModelLabel,
  workerModelVerdict,
} from "../rules.ts";
import {
  gateHoldsIn,
  type OrchestrationKit,
  underKeysOf,
  projectKey,
  startupKeysOf,
} from "./kit.ts";
import { type OrchestrationShape } from "./shape.ts";

/** Planning and starting a user's task, and the model a thread opens on. */
export const makeTaskStartup = (kit: OrchestrationKit) => {
  const {
    store,
    hosts,
    needsUnderGate,
    rosterHere,
    nativeGateReady,
    projectsOf,
    findThread,
    taskStartupLock,
    workspaceStartupKeys,
  } = kit;

  /** One model/gate decision shared by read-only task preview and holder creation. */
  const openModel = (charter: OrchestratorCharter, expected?: ModelRef) =>
    Effect.gen(function* () {
      const settings = yield* store.getSettings;
      const preferred = charter.orchestratorModel ?? settings.agents.defaultModel;
      const model = preferred ?? expected ?? (yield* discoverDefaultModel(hosts));
      if (!admittedForRole(model.agent, "orchestrator"))
        return yield* new InvalidState({
          message: `${kindName(model.agent)} cannot orchestrate. Choose an admitted harness explicitly in Settings → Workspaces.`,
        });
      if (expected !== undefined && !sameTaskModel(model, expected))
        return yield* new InvalidState({
          message:
            "The task's selected orchestrator changed. Check the task preview and start again.",
        });
      const mode = startModeFor(model.agent, settings);
      const needs = yield* needsUnderGate(model, gateOfAutonomy(autonomyOf(charter)), mode);
      if (needs !== undefined)
        return yield* new InvalidState({
          message: `The selected task orchestrator is ${kindName(model.agent)}'s ${model.model}. ${gateNeedsReason(needs, model.agent, mode)} Prepare the native approval home or choose another harness that holds this approval policy.`,
        });
      return { model, mode };
    });

  /**
   * A direct task's worker: the model `picked` from the preview's choices, else the one a worker
   * gets with nothing named, and every model it may be started on. An unavailable default with
   * nothing picked is a `refusal`, which only starting refuses, so the preview still offers the
   * rest; a pick that isn't one of the choices, or can't run here, is refused outright.
   */
  const taskWorkers = (
    charter: OrchestratorCharter,
    orchestrator: ModelRef,
    picked: ModelRef | undefined,
  ): Effect.Effect<
    {
      readonly choices: ReadonlyArray<TaskWorkerChoice>;
      readonly worker?: ModelRef;
      readonly refusal?: string;
    },
    InvalidState
  > =>
    Effect.gen(function* () {
      const here =
        charter.workerModels === undefined
          ? undefined
          : yield* rosterHere(charter.workerModels, charter);
      const settings = yield* store.getSettings;
      const profiles = yield* store.listProfiles;
      // Match worker creation: without a roster, inherit the harness/model but not the
      // orchestrator's role-specific effort. Explicit roster entries retain their effort.
      const { variant: _variant, ...bare } = orchestrator;
      const roster: ReadonlyArray<WorkerModel> = here?.roster ?? [bare];
      const fallback = fallbackOf(roster, orchestrator);
      const gateReady = yield* nativeGateReady("codex");
      const choices = roster.map((entry, index): TaskWorkerChoice => {
        const model = modelRefOf(entry);
        const mode = startModeFor(model.agent, settings, charter);
        const verdict = workerModelVerdict({
          model,
          autonomy: autonomyOf(charter),
          gateReady: model.agent === "codex" && gateReady,
          hasGatewayProfile:
            model.profileId !== undefined &&
            profiles.some((profile) => profile.id === model.profileId),
          mode,
          gateHoldsInMode: gateHoldsIn(model.agent, mode),
        });
        const unavailable =
          here?.unavailable.get(index) ?? (verdict.ok ? undefined : verdict.reason);
        const note = entry.useFor?.replace(/\s+/g, " ").trim() ?? "";
        return {
          model,
          ...(note === "" ? {} : { useFor: note }),
          ...(entry === fallback ? { default: true as const } : {}),
          ...(unavailable === undefined ? {} : { unavailable }),
        };
      });
      if (picked !== undefined) {
        const chosen = choices.find((choice) => sameTaskModel(choice.model, picked));
        if (chosen === undefined)
          return yield* new InvalidState({
            message:
              "The picked worker model isn't on this workspace's roster any more. Check the task preview and start again.",
          });
        if (chosen.unavailable !== undefined)
          return yield* new InvalidState({
            message: `${workerModelLabel(chosen.model)} can't start a worker here: ${chosen.unavailable}.`,
          });
        return { choices, worker: chosen.model };
      }
      const standing = choices.find((choice) => choice.default === true);
      if (standing === undefined)
        return {
          choices,
          refusal:
            "This workspace's roster has no worker models. Add one in Settings → Workspaces.",
        };
      if (standing.unavailable !== undefined)
        return {
          choices,
          refusal: `${workerModelLabel(standing.model)} is unavailable here (${standing.unavailable}). Pick another worker model, or change the roster in Settings → Workspaces; this task will not switch providers.`,
        };
      return { choices, worker: standing.model };
    });

  const taskContext = (input: Pick<StartTaskInput, "target" | "direct" | "autonomy">) =>
    Effect.gen(function* () {
      const settings = yield* store.getSettings;
      const state =
        "workspaceId" in input.target
          ? yield* store.getWorkspace(input.target.workspaceId)
          : (yield* store.listWorkspaces).find(
              (row) =>
                row.workspace.projectIds.length === 1 &&
                row.workspace.projectIds[0] ===
                  (input.target as { projectId: ProjectId }).projectId,
            );
      const projectIds = state?.workspace.projectIds ?? [
        (input.target as { projectId: ProjectId }).projectId,
      ];
      yield* projectsOf(projectIds);
      if (
        state !== undefined &&
        input.autonomy !== undefined &&
        autonomyOf(state.charter) !== input.autonomy
      )
        return yield* new InvalidState({
          message: `${state.workspace.name} already has a workspace, at ${autonomyOf(state.charter)} autonomy, which it keeps. Check the task preview and start again.`,
        });
      const charter = state?.charter ?? subscriptionTaskCharter(settings.agents, input.autonomy);
      const holder =
        state?.workspace.orchestratorThreadId === undefined
          ? undefined
          : yield* findThread(state.workspace.orchestratorThreadId);
      return { settings, state, projectIds, charter, holder };
    });

  // Only selection inputs participate: outbox/ledger changes do not invalidate a draft.
  const taskContextKey = (context: Effect.Success<ReturnType<typeof taskContext>>) =>
    JSON.stringify({
      agents: context.settings.agents,
      workspace:
        context.state === undefined
          ? undefined
          : {
              id: context.state.workspace.id,
              projectIds: context.state.workspace.projectIds,
              homeProjectId: context.state.workspace.homeProjectId,
              orchestratorThreadId: context.state.workspace.orchestratorThreadId,
            },
      charter: context.charter,
      holder:
        context.holder === undefined
          ? undefined
          : { id: context.holder.id, model: context.holder.model },
    });

  const taskPlan = (input: Pick<StartTaskInput, "target" | "direct" | "autonomy">) =>
    Effect.gen(function* () {
      const context = yield* taskContext(input);
      const { charter, holder, projectIds } = context;
      const orchestrator = holder?.model ?? (yield* openModel(charter)).model;
      if (input.direct !== undefined && !projectIds.includes(input.direct.projectId))
        return yield* new InvalidState({
          message: "The selected worker repository isn't one of this workspace's repositories.",
        });
      const workers =
        input.direct === undefined
          ? undefined
          : yield* taskWorkers(charter, orchestrator, input.direct.worker);
      const selection: TaskModelSelection = {
        orchestrator,
        ...(holder === undefined ? {} : { orchestratorThreadId: holder.id }),
        ...(workers?.worker === undefined ? {} : { worker: workers.worker }),
        ...(workers === undefined ? {} : { workerChoices: workers.choices }),
      };
      const fresh = Effect.gen(function* () {
        const current = yield* taskContext(input);
        if (taskContextKey(current) !== taskContextKey(context))
          return yield* new InvalidState({
            message:
              JSON.stringify(current.charter.workerModels) !== JSON.stringify(charter.workerModels)
                ? "The task's selected worker changed. Check the task preview and start again."
                : "The task's selected harness changed. Check the task preview and start again.",
          });
      });
      return { selection, fresh, workerRefusal: workers?.refusal };
    });

  const taskPreflight: OrchestrationShape["taskPreflight"] = (input) =>
    Effect.gen(function* () {
      const plan = yield* taskPlan(input);
      yield* plan.fresh;
      return plan.selection;
    });

  /**
   * The `taskStartupLock` keys of a task's target: its workspace's (`startupKeysOf`), or the
   * project's alone while it has no workspace yet.
   */
  const startupKeys = (input: Pick<StartTaskInput, "target">) =>
    Effect.gen(function* () {
      const target = input.target;
      if ("workspaceId" in target) return yield* workspaceStartupKeys(target.workspaceId);
      const state = (yield* store.listWorkspaces).find(
        (row) =>
          row.workspace.projectIds.length === 1 && row.workspace.projectIds[0] === target.projectId,
      );
      return state === undefined
        ? [projectKey(target.projectId)]
        : startupKeysOf(state.workspace.id, state);
    });

  const withTaskStartup: OrchestrationShape["withTaskStartup"] = (input, selected, run) =>
    Effect.gen(function* () {
      // CLI discovery may wait. Let edits finish during it, then check the original
      // inputs under the same lock used by charter commits before creating anything.
      const plan = yield* taskPlan(input);
      return yield* underKeysOf(
        taskStartupLock,
        startupKeys(input),
        Effect.gen(function* () {
          yield* plan.fresh;
          if (plan.workerRefusal !== undefined)
            return yield* new InvalidState({ message: plan.workerRefusal });
          if (selected !== undefined && !sameTaskSelection(plan.selection, selected))
            return yield* new InvalidState({
              message:
                "The task's selected harness changed. Check the task preview and start again.",
            });
          return yield* run(plan.selection);
        }),
      );
    });

  return { openModel, taskWorkers, taskPreflight, withTaskStartup };
};

/** What `makeTaskStartup` makes, for the parts whose `deps` take some of it. */
export type TaskStartup = ReturnType<typeof makeTaskStartup>;
