import {
  AppToolError,
  parseRoutineSchedule,
  parseRoutineTrigger,
  RoutineBrief,
  RoutineName,
  routineNameKey,
  routineWhenKey,
  routineWhenText,
  ROUTINES_MAX,
  WorkspaceRoutines,
  type ModelRef,
  type OrchestratorCharter,
  type ThreadId,
  type PinnedWorkerModel,
  type WorkspaceRoutine,
  type WorkspaceState,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { defineAppTool } from "../app-tools/definition.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { refuseOutOfReach } from "../git/repo-reach.ts";
import { triggerRepo } from "./events.ts";
import { workerModelLabel } from "../orchestration/rules.ts";
import { Orchestration } from "../orchestration/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { localZone } from "../zone-time.ts";
import { Routines } from "./routines.ts";
import { nextRunAfter } from "./schedule.ts";

const toolError = (tool: string, message: string) => new AppToolError({ tool, message });

const NO_WORKSPACE =
  "Only an orchestrator, or a worker of a workspace, keeps routines; this thread is neither.";

const TargetKind = Schema.Literals(["worker", "orchestrator"]);

const decodeRoutines = Schema.decodeUnknownResult(WorkspaceRoutines);

const whenOf = (input: {
  readonly schedule?: string | undefined;
  readonly on?: string | undefined;
}):
  | { readonly schedule: WorkspaceRoutine["schedule"] & object }
  | { readonly on: WorkspaceRoutine["on"] & object }
  | { readonly error: string } => {
  if ((input.schedule === undefined) === (input.on === undefined)) {
    return { error: "Give a `schedule` or an `on` event, exactly one." };
  }
  return input.schedule !== undefined
    ? parseRoutineSchedule(input.schedule)
    : parseRoutineTrigger(input.on!);
};

const shown = (routine: WorkspaceRoutine, nextRunAt: number | undefined) => ({
  name: routine.name,
  ...(routine.on === undefined
    ? { schedule: routineWhenText(routine) }
    : { on: routineWhenText(routine) }),
  ...(routine.target === "orchestrator"
    ? { target: "orchestrator" }
    : {
        target: "worker",
        ...(routine.project === undefined ? {} : { project: routine.project }),
        ...(routine.model === undefined ? {} : { model: workerModelLabel(routine.model) }),
      }),
  ...(routine.off === true ? { off: true } : {}),
  ...(nextRunAt === undefined ? {} : { nextRunAt: new Date(nextRunAt).toISOString() }),
});

const modelOf = (tool: string, charter: OrchestratorCharter, named: string) =>
  Effect.gen(function* () {
    const roster = (charter.workerModels ?? []).filter(
      (entry): entry is PinnedWorkerModel => !("tier" in entry),
    );
    const matches = roster.filter(
      (entry) => workerModelLabel(entry) === named || entry.model === named,
    );
    if (matches.length !== 1) {
      return yield* toolError(
        tool,
        roster.length === 0
          ? "This workspace names no worker models; leave `model` out to use the default."
          : `"${named}" isn't one of this workspace's worker models: ${roster.map(workerModelLabel).join(", ")}.`,
      );
    }
    const { useFor: _useFor, default: _default, ...model } = matches[0]!;
    return model as ModelRef;
  });

const routineText = (routine: WorkspaceRoutine): string =>
  [
    `"${routine.name}", ${routineWhenText(routine)}`,
    routine.target === "orchestrator" ? "to the orchestrator" : "starts a worker",
    ...(routine.project === undefined ? [] : [`in project ${routine.project}`]),
    ...(routine.model === undefined ? [] : [`on ${workerModelLabel(routine.model)}`]),
    ...(routine.off === true ? ["off"] : []),
  ].join(", ") + `: ${routine.brief}`;

const onlyNarrows = (input: {
  readonly remove?: boolean | undefined;
  readonly off?: boolean | undefined;
}) => {
  if (input.remove === true) return true;
  const changed = Object.entries(input).filter(
    ([key, value]) => key !== "routine" && value !== undefined,
  );
  return changed.length === 1 && changed[0]![0] === "off" && input.off === true;
};

const checked =
  (
    edit: (
      current: ReadonlyArray<WorkspaceRoutine>,
    ) => ReadonlyArray<WorkspaceRoutine> | { readonly error: string },
  ) =>
  (current: ReadonlyArray<WorkspaceRoutine>) => {
    const next = edit(current);
    if ("error" in next) return next;
    const decoded = decodeRoutines(next);
    return Result.isFailure(decoded)
      ? {
          error: `At most ${ROUTINES_MAX} routines, each with a name of its own: ${decoded.failure.message.split("\n")[0]}`,
        }
      : next;
  };

export const RoutineAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const routines = yield* Routines;
    const orchestration = yield* Orchestration;
    const store = yield* ThreadStore;

    const callerWorkspace = (tool: string, caller: ThreadId) =>
      Effect.gen(function* () {
        const authority = yield* orchestration.authorityOf(caller);
        if (authority !== undefined) return authority.state;
        const thread = Option.getOrUndefined(yield* store.getThread(caller).pipe(Effect.option));
        if (thread?.spawnedBy === undefined || thread.workspaceId === undefined) {
          return yield* toolError(tool, NO_WORKSPACE);
        }
        const state = Option.getOrUndefined(
          yield* store.getWorkspace(thread.workspaceId).pipe(Effect.option),
        );
        if (state === undefined) return yield* toolError(tool, NO_WORKSPACE);
        return state;
      });

    const projectOf = (tool: string, state: WorkspaceState, named: string) =>
      Effect.gen(function* () {
        const projects = (yield* store.listProjects).filter((project) =>
          state.workspace.projectIds.includes(project.id),
        );
        const wanted = named.trim().toLowerCase();
        const found =
          projects.find((project) => project.id === named) ??
          projects.find((project) => project.name.toLowerCase() === wanted);
        if (found === undefined) {
          return yield* toolError(
            tool,
            `"${named}" isn't one of this workspace's projects: ${projects.map((project) => project.name).join(", ")}.`,
          );
        }
        return found.id;
      });

    const editRoutines = (
      tool: string,
      state: WorkspaceState,
      edit: (
        current: ReadonlyArray<WorkspaceRoutine>,
      ) => ReadonlyArray<WorkspaceRoutine> | { readonly error: string },
    ) =>
      Effect.gen(function* () {
        const check = checked(edit);
        const first = check(state.charter.routines ?? []);
        if ("error" in first) return yield* toolError(tool, first.error);
        const saved = yield* orchestration
          .editCharter(state.workspace.id, (standing) => {
            const next = check(standing.routines ?? []);
            if ("error" in next) return undefined;
            const { routines: _routines, ...rest } = standing;
            return next.length === 0 ? rest : { ...rest, routines: next };
          })
          .pipe(
            Effect.mapError((e) => toolError(tool, e.message ?? "Couldn't save the routines.")),
          );
        return saved;
      });

    const result = (tool: string, saved: WorkspaceState, name: string) =>
      Effect.gen(function* () {
        const routine = (saved.charter.routines ?? []).find(
          (each) => routineNameKey(each.name) === routineNameKey(name),
        );
        if (routine === undefined) return yield* toolError(tool, `"${name}" wasn't saved.`);
        const status = (yield* routines
          .list(saved.workspace.id)
          .pipe(Effect.orElseSucceed(() => []))).find((each) => each.id === routine.id);
        const now = yield* Clock.currentTimeMillis;
        const nextRunAt =
          routine.off === true || routine.schedule === undefined
            ? undefined
            : status?.state.scheduleKey === routineWhenKey(routine)
              ? status.state.nextRunAt
              : nextRunAfter(routine.schedule, now, localZone());
        return shown(routine, nextRunAt);
      });

    const createTool = defineAppTool({
      descriptor: {
        name: "routine_create",
        class: "self",
        description:
          'Save a routine: a brief on a `schedule` ("daily HH:MM", "weekdays HH:MM", "weekly mon HH:MM", "every N hours"; local) or `on` an event ("review requested [owner/repo]", "pr ready", "ci failed [branch]", "release npm|github NAME [min-age DAYS]"). "worker" runs in `project` on `model`; "orchestrator" briefs you. Asks the user.',
      },
      audience: ["orchestrator", "worker"],
      input: Schema.Struct({
        name: RoutineName,
        brief: RoutineBrief,
        schedule: Schema.optionalKey(Schema.String),
        on: Schema.optionalKey(Schema.String),
        target: TargetKind,
        project: Schema.optionalKey(Schema.String),
        model: Schema.optionalKey(Schema.String),
      }),
      needsApproval: () => Effect.succeed(true),
      describe: (caller, input) =>
        Effect.succeed(
          `Save the routine "${input.name}" (${input.schedule ?? `on ${input.on ?? "nothing"}`}), which ${input.target === "orchestrator" ? "wakes the orchestrator" : `starts a worker in ${input.project ?? "the home repository"}`} each time${input.model === undefined ? "" : ` on ${input.model}`}, with this brief in full:\n\n${input.brief}\n\n[asked by thread ${caller}]`,
        ),
      handle: (caller, input) =>
        Effect.gen(function* () {
          const tool = "routine_create";
          const state = yield* callerWorkspace(tool, caller);
          const parsed = whenOf(input);
          if ("error" in parsed) return yield* toolError(tool, parsed.error);
          const on = "on" in parsed ? parsed.on : undefined;
          yield* refuseOutOfReach(tool, store, caller, { repos: [triggerRepo(on)] });
          const project =
            input.target === "orchestrator" || input.project === undefined
              ? undefined
              : yield* projectOf(tool, state, input.project);
          const model =
            input.target === "orchestrator" || input.model === undefined
              ? undefined
              : yield* modelOf(tool, state.charter, input.model);
          const routine: WorkspaceRoutine = {
            name: input.name.trim(),
            brief: input.brief,
            ...parsed,
            ...(input.target === "orchestrator" ? { target: "orchestrator" as const } : {}),
            ...(project === undefined ? {} : { project }),
            ...(model === undefined ? {} : { model }),
          };
          const saved = yield* editRoutines(tool, state, (current) =>
            current.some((each) => routineNameKey(each.name) === routineNameKey(routine.name))
              ? { error: `This workspace already has a routine named "${routine.name}".` }
              : [...current, routine],
          );
          return yield* result(tool, saved, routine.name);
        }),
    });

    const updateTool = defineAppTool({
      descriptor: {
        name: "routine_update",
        class: "self",
        description:
          "Change a routine named by `routine`; only given fields change, as in routine_create. The user approves all but `off: true` alone or `remove: true` (its workers carry on). Turning on or rescheduling counts from now.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        routine: Schema.String,
        name: Schema.optionalKey(RoutineName),
        brief: Schema.optionalKey(RoutineBrief),
        schedule: Schema.optionalKey(Schema.String),
        on: Schema.optionalKey(Schema.String),
        target: Schema.optionalKey(TargetKind),
        project: Schema.optionalKey(Schema.String),
        model: Schema.optionalKey(Schema.String),
        off: Schema.optionalKey(Schema.Boolean),
        remove: Schema.optionalKey(Schema.Boolean),
      }),
      resolve: (caller, input) =>
        Effect.gen(function* () {
          const tool = "routine_update";
          const state = yield* callerWorkspace(tool, caller);
          const key = routineNameKey(input.routine);
          const before = (state.charter.routines ?? []).find(
            (each) => routineNameKey(each.name) === key,
          );
          if (before?.id === undefined) {
            return yield* toolError(tool, `This workspace has no routine "${input.routine}".`);
          }
          if (input.remove === true) {
            return { workspaceId: state.workspace.id, id: before.id, before, after: undefined };
          }
          const parsed =
            input.schedule === undefined && input.on === undefined ? undefined : whenOf(input);
          if (parsed !== undefined && "error" in parsed) {
            return yield* toolError(tool, parsed.error);
          }
          const on = parsed === undefined ? before.on : "on" in parsed ? parsed.on : undefined;
          yield* refuseOutOfReach(tool, store, caller, { repos: [triggerRepo(on)] });
          const project =
            input.project === undefined ? undefined : yield* projectOf(tool, state, input.project);
          const model =
            input.model === undefined
              ? undefined
              : yield* modelOf(tool, state.charter, input.model);
          const { target: _target, off: _off, project: _project, model: _model, ...kept } = before;
          const { schedule: _schedule, on: _on, ...unwhen } = kept;
          const rest = parsed === undefined ? kept : unwhen;
          const target =
            input.target ?? (before.target === "orchestrator" ? "orchestrator" : "worker");
          const off = input.off ?? before.off === true;
          const keptProject = project ?? before.project;
          const keptModel = model ?? before.model;
          const after: WorkspaceRoutine = {
            ...rest,
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
            ...(input.brief === undefined ? {} : { brief: input.brief }),
            ...parsed,
            ...(target === "orchestrator" ? { target: "orchestrator" as const } : {}),
            ...(target === "worker" && keptProject !== undefined ? { project: keptProject } : {}),
            ...(target === "worker" && keptModel !== undefined ? { model: keptModel } : {}),
            ...(off ? { off: true as const } : {}),
          };
          return { workspaceId: state.workspace.id, id: before.id, before, after };
        }),
      approvalRequiresResolvedTarget: true,
      needsApproval: (caller, input) =>
        Effect.map(orchestration.authorityOf(caller), (authority) =>
          authority === undefined ? true : !onlyNarrows(input),
        ),
      describe: (caller, pinned) =>
        Effect.succeed(
          pinned.after === undefined
            ? `Remove the routine "${pinned.before.name}":\n\n${routineText(pinned.before)}\n\n[asked by thread ${caller}]`
            : `Change the routine "${pinned.before.name}".\n\nBefore: ${routineText(pinned.before)}\n\nAfter: ${routineText(pinned.after)}\n\n[asked by thread ${caller}]`,
        ),
      cardDetails: (pinned) => ({
        routine: pinned.id,
        before: pinned.before,
        after: pinned.after ?? null,
      }),
      handle: (caller, pinned) =>
        Effect.gen(function* () {
          const tool = "routine_update";
          const state = yield* callerWorkspace(tool, caller);
          if (state.workspace.id !== pinned.workspaceId) {
            return yield* toolError(tool, "This routine's workspace is no longer yours.");
          }
          const same = (each: WorkspaceRoutine) =>
            JSON.stringify(each) === JSON.stringify(pinned.before);
          const saved = yield* editRoutines(tool, state, (current) => {
            const now = current.find((each) => each.id === pinned.id);
            if (now === undefined || !same(now)) {
              return {
                error: `The routine "${pinned.before.name}" changed after this was asked; nothing was changed. Look again and ask anew.`,
              };
            }
            if (pinned.after === undefined) return current.filter((each) => each.id !== pinned.id);
            const after = pinned.after;
            if (
              current.some(
                (each) =>
                  each.id !== pinned.id && routineNameKey(each.name) === routineNameKey(after.name),
              )
            ) {
              return { error: `This workspace already has a routine named "${after.name}".` };
            }
            return current.map((each) => (each.id === pinned.id ? after : each));
          });
          if (pinned.after === undefined) return { removed: pinned.before.name };
          return yield* result(tool, saved, pinned.after.name);
        }),
    });

    yield* registry.register([createTool, updateTool]);
    yield* routines.start;
  }),
);
