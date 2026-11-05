/**
 * The routine tools: `routine_list`, `routine_create` and `routine_update` (which also removes one),
 * an orchestrator's, which keeps its workspace's routines without a card, as it spawns inside its
 * charter without one. A worker is bound `routine_create` alone, and its call always asks the user,
 * at every autonomy and in every mode (a forced card, which `bypassPermissions` doesn't lift): a
 * routine starts work on its own later, so a worker never sets one up unasked. Update keeps the
 * same check, should a session's tool list ever carry it to a thread that isn't the orchestrator.
 *
 * What a routine starts is gated where it starts (`routines.ts`): its worker is the orchestrator's,
 * spawned under the workspace's autonomy, cap and approvals like any other.
 */
import {
  AppToolError,
  parseRoutineSchedule,
  RoutineBrief,
  RoutineName,
  routineScheduleText,
  type Project,
  type Routine,
  type RoutineTarget,
  type ThreadId,
  type WorkspaceState,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineAppTool } from "../app-tools/definition.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { Orchestration } from "../orchestration/service.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { Routines, type RoutineAuthorship } from "./routines.ts";

const toolError = (tool: string, message: string) => new AppToolError({ tool, message });

const NO_WORKSPACE =
  "Only an orchestrator, or a worker of a workspace, keeps routines; this thread is neither.";

const TargetKind = Schema.Literals(["worker", "orchestrator"]);

/** A schedule the tools take as words (`parseRoutineSchedule`), refused in the tool's name. */
const scheduleOf = (tool: string, text: string) => {
  const parsed = parseRoutineSchedule(text);
  return "error" in parsed
    ? Effect.fail(toolError(tool, parsed.error))
    : Effect.succeed(parsed.schedule);
};

/** A routine as the tools list it: its schedule in words, and its times as ISO strings. */
const listed = (routine: Routine, projects: ReadonlyArray<Project>) => ({
  id: routine.id,
  name: routine.name,
  enabled: routine.enabled,
  schedule: routineScheduleText(routine.schedule),
  target:
    routine.target.kind === "orchestrator"
      ? "orchestrator"
      : `worker in ${projectName(projects, routine.target.projectId)}${routine.target.model === undefined ? "" : ` on ${routine.target.model}`}`,
  createdBy: routine.createdBy,
  ...(routine.nextRunAt === undefined
    ? {}
    : { nextRunAt: new Date(routine.nextRunAt).toISOString() }),
  ...(routine.waiting === undefined ? {} : { waiting: "on the workspace's pause" }),
  ...(routine.lastRun === undefined
    ? {}
    : {
        lastRun: {
          at: new Date(routine.lastRun.at).toISOString(),
          outcome: routine.lastRun.outcome,
          ...(routine.lastRun.detail === undefined ? {} : { detail: routine.lastRun.detail }),
          ...(routine.lastRun.threadId === undefined ? {} : { threadId: routine.lastRun.threadId }),
        },
      }),
  brief: routine.brief,
});

const authorship = (caller: ThreadId, by: "orchestrator" | "worker"): RoutineAuthorship => ({
  by,
  threadId: caller,
});

const projectName = (projects: ReadonlyArray<Project>, id: string) =>
  projects.find((project) => project.id === id)?.name ?? id;

export const RoutineAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const routines = yield* Routines;
    const orchestration = yield* Orchestration;
    const store = yield* ThreadStore;

    /** The caller's workspace and whether it calls as its orchestrator or as one of its workers. */
    const callerWorkspace = (tool: string, caller: ThreadId) =>
      Effect.gen(function* () {
        const authority = yield* orchestration.authorityOf(caller);
        if (authority !== undefined) {
          return { state: authority.state, by: "orchestrator" as const };
        }
        const thread = Option.getOrUndefined(yield* store.getThread(caller).pipe(Effect.option));
        if (thread?.spawnedBy === undefined || thread.workspaceId === undefined) {
          return yield* toolError(tool, NO_WORKSPACE);
        }
        const state = Option.getOrUndefined(
          yield* store.getWorkspace(thread.workspaceId).pipe(Effect.option),
        );
        if (state === undefined) return yield* toolError(tool, NO_WORKSPACE);
        return { state, by: "worker" as const };
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
        return found;
      });

    const targetOf = (
      tool: string,
      state: WorkspaceState,
      input: {
        readonly target?: "worker" | "orchestrator" | undefined;
        readonly project?: string | undefined;
        readonly model?: string | undefined;
      },
    ) =>
      Effect.gen(function* () {
        if (input.target === undefined && input.project === undefined) return undefined;
        if (input.target === "orchestrator") return { kind: "orchestrator" } as RoutineTarget;
        if (input.project === undefined) {
          return yield* toolError(
            tool,
            "A worker routine names the `project` its worker starts in.",
          );
        }
        const project = yield* projectOf(tool, state, input.project);
        const target: RoutineTarget = {
          kind: "worker",
          projectId: project.id,
          ...(input.model === undefined ? {} : { model: input.model }),
        };
        return target;
      });

    /** One of the caller's workspace's routines, by id or name. */
    const routineOf = (tool: string, caller: ThreadId, named: string) =>
      Effect.gen(function* () {
        const { state } = yield* callerWorkspace(tool, caller);
        const all = yield* routines
          .list(state.workspace.id)
          .pipe(Effect.mapError((e) => toolError(tool, e.message ?? NO_WORKSPACE)));
        const wanted = named.trim().toLowerCase();
        const found =
          all.find((routine) => routine.id === named) ??
          all.find((routine) => routine.name.toLowerCase() === wanted);
        if (found === undefined) {
          return yield* toolError(
            tool,
            `This workspace has no routine "${named}"; routine_list lists them.`,
          );
        }
        return { state, routine: found };
      });

    const listTool = defineAppTool({
      descriptor: {
        name: "routine_list",
        class: "read",
        description:
          "This workspace's routines (saved briefs on a schedule): each one's schedule, target, next run and last run.",
      },
      audience: ["orchestrator"],
      input: Schema.Struct({ includeBriefs: Schema.optionalKey(Schema.Boolean) }),
      handle: (caller, input) =>
        Effect.gen(function* () {
          const { state } = yield* callerWorkspace("routine_list", caller);
          const projects = yield* store.listProjects;
          const all = yield* routines
            .list(state.workspace.id)
            .pipe(Effect.mapError((e) => toolError("routine_list", e.message ?? NO_WORKSPACE)));
          const now = yield* Clock.currentTimeMillis;
          return {
            now: new Date(now).toISOString(),
            routines: all.map((routine) => {
              const row = listed(routine, projects);
              if (input.includeBriefs === true) return row;
              const { brief: _brief, ...rest } = row;
              return rest;
            }),
          };
        }),
    });

    const createTool = defineAppTool({
      descriptor: {
        name: "routine_create",
        class: "self",
        description:
          'Save a routine: a brief that runs on a schedule (a daily CI triage, a weekly dependency check). `schedule` is "daily HH:MM", "weekly mon HH:MM" or "every N hours" (24-hour, local time; 1 to 168 hours). Each run, `target: "worker"` starts your worker in `project` on `model` (else the default) with `brief`, written to stand alone; `"orchestrator"` puts the brief in your digest. A run missed while Gram was closed runs once at the next start; a run is skipped while the last run\'s worker is live; a paused workspace holds them. From a worker this asks the user.',
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
          `Save the routine "${input.name}" (${input.schedule}), which ${input.target === "orchestrator" ? "wakes the orchestrator" : `starts a worker in ${input.project ?? "a project"}`} each time with this brief: ${input.brief.slice(0, 400)}${input.brief.length > 400 ? "…" : ""} [asked by thread ${caller}]`,
        ),
      handle: (caller, input) =>
        Effect.gen(function* () {
          const tool = "routine_create";
          const { state, by } = yield* callerWorkspace(tool, caller);
          const schedule = yield* scheduleOf(tool, input.schedule);
          const target = yield* targetOf(tool, state, input);
          if (target === undefined) return yield* toolError(tool, "Name the routine's `target`.");
          const routine = yield* routines
            .create(
              state.workspace.id,
              { name: input.name, brief: input.brief, target, schedule },
              authorship(caller, by),
            )
            .pipe(
              Effect.mapError((e) => toolError(tool, e.message ?? "Couldn't save the routine.")),
            );
          return listed(routine, yield* store.listProjects);
        }),
    });

    const updateTool = defineAppTool({
      descriptor: {
        name: "routine_update",
        class: "self",
        description:
          "Change a routine, named by `routine` (id or name): only the fields given change, as routine_create takes them. `enabled: false` turns it off; turning it on or a new schedule counts from now. `remove: true` deletes it; its workers carry on.",
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
        enabled: Schema.optionalKey(Schema.Boolean),
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
          const { state, routine } = yield* routineOf(tool, caller, input.routine);
          if (input.remove === true) {
            yield* routines
              .remove(routine.id)
              .pipe(Effect.mapError((e) => toolError(tool, e.message ?? "Couldn't remove it.")));
            return { removed: routine.name };
          }
          const schedule =
            input.schedule === undefined ? undefined : yield* scheduleOf(tool, input.schedule);
          const target = yield* targetOf(tool, state, input);
          const updated = yield* routines
            .update(routine.id, {
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.brief === undefined ? {} : { brief: input.brief }),
              ...(schedule === undefined ? {} : { schedule }),
              ...(target === undefined ? {} : { target }),
              ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            })
            .pipe(
              Effect.mapError((e) => toolError(tool, e.message ?? "Couldn't save the routine.")),
            );
          return listed(updated, yield* store.listProjects);
        }),
    });

    yield* registry.register([listTool, createTool, updateTool]);
    // Only now: a run opens a worker's session, which keeps the tools it opened with.
    yield* routines.start;
  }),
);
