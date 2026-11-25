import {
  autonomyOf,
  InvalidState,
  type ModelRef,
  type OrchestratorCharter,
  type StartTaskInput,
  type TaskModelSelection,
  defaultSlotOf,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { moveKindOf } from "../../runtime/agent-switch.ts";
import { discoverDefaultModel } from "../../runtime/default-model.ts";
import { slotHereNow } from "../../runtime/model-slots.ts";
import { subscriptionTaskCharter } from "../task-models.ts";
import { sameTaskModel, sameTaskSelection } from "../task-selection.ts";
import {
  admittedForRole,
  gateNeedsReason,
  gateOfAutonomy,
  kindName,
  startModeFor,
  workerModelLabel,
} from "../rules.ts";
import { type OrchestrationKit, underKeysOf, projectKey, startupKeysOf } from "./kit.ts";
import { admitWorkspaceReader, projectWorkspaceOf } from "./reader-workspaces.ts";
import { type OrchestrationShape } from "./shape.ts";

/** Planning and starting a user's task, and the model a thread opens on. */
export const makeTaskStartup = (kit: OrchestrationKit) => {
  const {
    store,
    hosts,
    needsUnderGate,
    autoHere,
    projectsOf,
    findThread,
    taskStartupLock,
    workspaceStartupKeys,
  } = kit;

  const openModel = (charter: OrchestratorCharter, expected?: ModelRef) =>
    Effect.gen(function* () {
      const settings = yield* store.getSettings;
      const own = yield* slotHereNow(hosts, charter.orchestratorModel);
      const app = own.model === undefined ? yield* slotHereNow(hosts, defaultSlotOf(settings)) : {};
      const preferred = own.model ?? app.model;
      const model = preferred ?? expected ?? (yield* discoverDefaultModel(hosts));
      const missing = own.missing ?? (preferred === undefined ? app.missing : undefined);
      const note =
        missing === undefined
          ? undefined
          : `The orchestrator's ${own.missing === undefined ? "default " : ""}model can't run here: ${missing}. It opens on ${workerModelLabel(model)} instead.`;
      if (!admittedForRole(model.agent, "orchestrator"))
        return yield* new InvalidState({
          message: `${kindName(model.agent)} cannot orchestrate. Choose an admitted harness explicitly in Settings → Workspaces.`,
        });
      if (expected !== undefined && !sameTaskModel(model, expected))
        return yield* new InvalidState({
          message:
            "The task's selected orchestrator changed. Check the task preview and start again.",
        });
      const gate = gateOfAutonomy(autonomyOf(charter));
      const mode = startModeFor(
        model.agent,
        settings,
        {},
        yield* autoHere(model.agent, gate, model.profileId !== undefined),
      );
      const needs = yield* needsUnderGate(model, gate, mode);
      if (needs !== undefined)
        return yield* new InvalidState({
          message: `The selected task orchestrator is ${kindName(model.agent)}'s ${model.model}. ${gateNeedsReason(needs, model.agent, mode)} Prepare the native approval home or choose another harness that holds this approval policy.`,
        });
      return { model, mode, ...(note === undefined ? {} : { note }) };
    });

  const taskContext = (input: Pick<StartTaskInput, "target" | "autonomy">) =>
    Effect.gen(function* () {
      const settings = yield* store.getSettings;
      const { target } = input;
      const state =
        "workspaceId" in target
          ? yield* store.getWorkspace(target.workspaceId)
          : yield* projectWorkspaceOf(
              yield* store.listWorkspaces,
              target.projectId,
              yield* store.listProjects,
            );
      if (state !== undefined) yield* admitWorkspaceReader(state);
      const projectIds =
        state?.workspace.projectIds ?? ("projectId" in target ? [target.projectId] : []);
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

  const taskPlan = (input: Pick<StartTaskInput, "target" | "autonomy" | "orchestrator">) =>
    Effect.gen(function* () {
      const context = yield* taskContext(input);
      const { charter, holder } = context;
      const picked = input.orchestrator;
      if (picked !== undefined && !admittedForRole(picked.agent, "orchestrator"))
        return yield* new InvalidState({
          message: `${kindName(picked.agent)} threads can't be orchestrators yet. Pick another orchestrator model.`,
        });
      const opened =
        holder === undefined
          ? yield* openModel(
              picked === undefined ? charter : { ...charter, orchestratorModel: picked },
            )
          : undefined;
      const switching = holder?.sessionSwitch?.target;
      const moves =
        holder !== undefined &&
        picked !== undefined &&
        !sameTaskModel(holder.model, picked) &&
        (switching === undefined || !sameTaskModel(switching, picked));
      const move = moves
        ? yield* moveKindOf(store, hosts, holder, picked).pipe(
            Effect.mapError(
              (e) =>
                new InvalidState({
                  message: `The orchestrator can't move to ${kindName(picked.agent)} · ${picked.model} as this task starts. ${e.message}`,
                }),
            ),
          )
        : undefined;
      const orchestrator =
        holder === undefined ? opened!.model : picked !== undefined ? picked : holder.model;
      const selection: TaskModelSelection = {
        orchestrator,
        ...(holder === undefined ? {} : { orchestratorThreadId: holder.id }),
        ...(opened?.note === undefined ? {} : { orchestratorNote: opened.note }),
        ...(moves ? { orchestratorFrom: holder.model } : {}),
        ...(move === "fresh" ? { orchestratorFresh: true } : {}),
      };
      const fresh = Effect.gen(function* () {
        const current = yield* taskContext(input);
        if (taskContextKey(current) !== taskContextKey(context))
          return yield* new InvalidState({
            message: "The task's selected harness changed. Check the task preview and start again.",
          });
      });
      return { selection, fresh };
    });

  const taskPreflight: OrchestrationShape["taskPreflight"] = (input) =>
    Effect.gen(function* () {
      const plan = yield* taskPlan(input);
      yield* plan.fresh;
      return plan.selection;
    });

  const startupKeys = (input: Pick<StartTaskInput, "target">) =>
    Effect.gen(function* () {
      const target = input.target;
      if ("workspaceId" in target) return yield* workspaceStartupKeys(target.workspaceId);
      const state = yield* projectWorkspaceOf(
        yield* store.listWorkspaces,
        target.projectId,
        yield* store.listProjects,
      );
      return state === undefined
        ? [projectKey(target.projectId)]
        : startupKeysOf(state.workspace.id, state);
    });

  const withTaskStartup: OrchestrationShape["withTaskStartup"] = (input, selected, run) =>
    Effect.gen(function* () {
      const plan = yield* taskPlan(input);
      return yield* underKeysOf(
        taskStartupLock,
        startupKeys(input),
        Effect.gen(function* () {
          yield* plan.fresh;
          if (selected !== undefined && !sameTaskSelection(plan.selection, selected))
            return yield* new InvalidState({
              message:
                "The task's selected harness changed. Check the task preview and start again.",
            });
          return yield* run(plan.selection);
        }),
      );
    });

  return { openModel, taskPreflight, withTaskStartup };
};

/** What `makeTaskStartup` makes, for the parts whose `deps` take some of it. */
export type TaskStartup = ReturnType<typeof makeTaskStartup>;
