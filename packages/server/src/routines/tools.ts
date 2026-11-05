/**
 * The routine tools, `routine_create` and `routine_update` (which also removes one), which change the
 * routines in the workspace's charter through its one write path (`Orchestration.editCharter`). An
 * orchestrator keeps its workspace's routines without a card, as it spawns inside its charter without
 * one; the charter's digest lists them, so it needs no list tool. A worker is bound `routine_create`
 * alone, and its call always asks the user, at every autonomy and in every mode (a forced card, which
 * `bypassPermissions` doesn't lift): a routine starts work on its own later, so a worker never sets
 * one up unasked. Update keeps the same check, should a session's tool list ever carry it to a
 * thread that isn't the orchestrator. The user changes routines in Settings, or by chat through
 * `settings_propose`'s `workspace.routines` on its own card.
 *
 * What a routine starts is gated where it starts (`routines.ts`): its worker is the orchestrator's,
 * spawned under the workspace's autonomy, cap and approvals like any other.
 */
import {
  AppToolError,
  parseRoutineSchedule,
  RoutineBrief,
  RoutineName,
  routineNameKey,
  routineScheduleText,
  ROUTINES_MAX,
  WorkspaceRoutines,
  type ModelRef,
  type OrchestratorCharter,
  type ThreadId,
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

/** A routine's row in a tool's result: its schedule in words, where it runs, and its next run. */
const shown = (routine: WorkspaceRoutine, nextRunAt: number | undefined) => ({
  name: routine.name,
  schedule: routineScheduleText(routine.schedule),
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

/** One of the charter's worker models, by `agent:model` or a bare id one entry has. */
const modelOf = (tool: string, charter: OrchestratorCharter, named: string) =>
  Effect.gen(function* () {
    const roster = charter.workerModels ?? [];
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

/** `edit`, refused when the routines it makes wouldn't be kept: too many, or a name twice. */
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

    /** The caller's workspace: the one it orchestrates, or the one it is a worker of. */
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

    /** A worker's change to a routine is the user's to allow; an orchestrator's isn't asked. */
    const askWorker = (caller: ThreadId) =>
      orchestration.authorityOf(caller).pipe(Effect.map((authority) => authority === undefined));

    /** One of the workspace's projects, by name or id. */
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

    /**
     * The charter's routines with `edit` made, stored through the charter's write path. `edit`
     * runs on the routines standing at the write, and its refusal fails the tool.
     */
    const editRoutines = (
      tool: string,
      state: WorkspaceState,
      edit: (
        current: ReadonlyArray<WorkspaceRoutine>,
      ) => ReadonlyArray<WorkspaceRoutine> | { readonly error: string },
    ) =>
      Effect.gen(function* () {
        const check = checked(edit);
        // Checked once here, for the refusal's words; again inside the write, on what stands then.
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

    /** The saved routine `name`, with its next run as the engine reckoned it. */
    const result = (tool: string, saved: WorkspaceState, name: string) =>
      Effect.gen(function* () {
        const routine = (saved.charter.routines ?? []).find(
          (each) => routineNameKey(each.name) === routineNameKey(name),
        );
        if (routine === undefined) return yield* toolError(tool, `"${name}" wasn't saved.`);
        const status = (yield* routines
          .list(saved.workspace.id)
          .pipe(Effect.orElseSucceed(() => []))).find((each) => each.id === routine.id);
        // The engine reckons it once it hears of the change; until then, as it will.
        const now = yield* Clock.currentTimeMillis;
        const nextRunAt =
          routine.off === true
            ? undefined
            : status?.state.scheduleKey === JSON.stringify(routine.schedule)
              ? status.state.nextRunAt
              : nextRunAfter(routine.schedule, now, localZone());
        return shown(routine, nextRunAt);
      });

    const createTool = defineAppTool({
      descriptor: {
        name: "routine_create",
        class: "self",
        description:
          'Save a routine: a brief run on a schedule. `schedule`: "daily HH:MM", "weekdays HH:MM", "weekly mon HH:MM" or "every N hours" (local, 24-hour). `target` "worker" starts your worker in `project` on `model` (defaults apply) with `brief`, written to stand alone; "orchestrator" puts it in your digest. A missed run runs once at start; a run is skipped while the last one\'s worker is live. From a worker this asks the user.',
      },
      audience: ["orchestrator", "worker"],
      input: Schema.Struct({
        name: RoutineName,
        brief: RoutineBrief,
        schedule: Schema.String,
        target: TargetKind,
        project: Schema.optionalKey(Schema.String),
        model: Schema.optionalKey(Schema.String),
      }),
      needsApproval: (caller) => askWorker(caller),
      describe: (caller, input) =>
        Effect.succeed(
          `Save the routine "${input.name}" (${input.schedule}), which ${input.target === "orchestrator" ? "wakes the orchestrator" : `starts a worker in ${input.project ?? "the home repository"}`} each time with this brief: ${input.brief.slice(0, 400)}${input.brief.length > 400 ? "…" : ""} [asked by thread ${caller}]`,
        ),
      handle: (caller, input) =>
        Effect.gen(function* () {
          const tool = "routine_create";
          const state = yield* callerWorkspace(tool, caller);
          const parsed = parseRoutineSchedule(input.schedule);
          if ("error" in parsed) return yield* toolError(tool, parsed.error);
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
            schedule: parsed.schedule,
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
          "Change a routine, named by `routine`: only the fields given change, as routine_create takes them. `off: true` turns it off; turning it on or a new schedule counts from now. `remove: true` deletes it; its workers carry on.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({
        routine: Schema.String,
        name: Schema.optionalKey(RoutineName),
        brief: Schema.optionalKey(RoutineBrief),
        schedule: Schema.optionalKey(Schema.String),
        target: Schema.optionalKey(TargetKind),
        project: Schema.optionalKey(Schema.String),
        model: Schema.optionalKey(Schema.String),
        off: Schema.optionalKey(Schema.Boolean),
        remove: Schema.optionalKey(Schema.Boolean),
      }),
      needsApproval: (caller) => askWorker(caller),
      describe: (caller, input) =>
        Effect.succeed(
          input.remove === true
            ? `Remove the routine "${input.routine}" [asked by thread ${caller}]`
            : `Change the routine "${input.routine}": ${Object.entries(input)
                .filter(([key]) => key !== "routine")
                .map(([key, value]) => `${key} ${JSON.stringify(value)}`)
                .join(", ")} [asked by thread ${caller}]`,
        ),
      handle: (caller, input) =>
        Effect.gen(function* () {
          const tool = "routine_update";
          const state = yield* callerWorkspace(tool, caller);
          const key = routineNameKey(input.routine);
          const known = (state.charter.routines ?? []).find(
            (each) => routineNameKey(each.name) === key,
          );
          if (known === undefined) {
            return yield* toolError(tool, `This workspace has no routine "${input.routine}".`);
          }
          if (input.remove === true) {
            yield* editRoutines(tool, state, (current) =>
              current.filter((each) => routineNameKey(each.name) !== key),
            );
            return { removed: known.name };
          }
          const parsed =
            input.schedule === undefined ? undefined : parseRoutineSchedule(input.schedule);
          if (parsed !== undefined && "error" in parsed) {
            return yield* toolError(tool, parsed.error);
          }
          const project =
            input.project === undefined ? undefined : yield* projectOf(tool, state, input.project);
          const model =
            input.model === undefined
              ? undefined
              : yield* modelOf(tool, state.charter, input.model);
          const change = (routine: WorkspaceRoutine): WorkspaceRoutine => {
            const {
              target: _target,
              off: _off,
              project: _project,
              model: _model,
              ...rest
            } = routine;
            const target =
              input.target ?? (routine.target === "orchestrator" ? "orchestrator" : "worker");
            const off = input.off ?? routine.off === true;
            const keptProject = project ?? routine.project;
            const keptModel = model ?? routine.model;
            return {
              ...rest,
              ...(input.name === undefined ? {} : { name: input.name.trim() }),
              ...(input.brief === undefined ? {} : { brief: input.brief }),
              ...(parsed === undefined ? {} : { schedule: parsed.schedule }),
              ...(target === "orchestrator" ? { target: "orchestrator" as const } : {}),
              ...(target === "worker" && keptProject !== undefined ? { project: keptProject } : {}),
              ...(target === "worker" && keptModel !== undefined ? { model: keptModel } : {}),
              ...(off ? { off: true as const } : {}),
            };
          };
          const renamed = input.name?.trim() ?? known.name;
          const saved = yield* editRoutines(tool, state, (current) => {
            if (
              routineNameKey(renamed) !== key &&
              current.some((each) => routineNameKey(each.name) === routineNameKey(renamed))
            ) {
              return { error: `This workspace already has a routine named "${renamed}".` };
            }
            return current.map((each) => (routineNameKey(each.name) === key ? change(each) : each));
          });
          return yield* result(tool, saved, renamed);
        }),
    });

    yield* registry.register([createTool, updateTool]);
    // Only now: a run opens a worker's session, which keeps the tools it opened with.
    yield* routines.start;
  }),
);
