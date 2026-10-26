// Settings by chat (docs/design/settings-by-chat.md): `settings_read` and `settings_propose`.
// What may change and how is decided in `@gram/contracts` (`settings-chat.ts`); this reads the
// world, raises the user's card, and applies an approved change by the Settings UI's own paths.

import {
  AppToolError,
  planSettingsChanges,
  readSettingsRows,
  readUserOnlyRows,
  SETTINGS_PROPOSAL_TTL_MS,
  SETTINGS_PROPOSE_TOOL,
  SETTINGS_READ_TOOL,
  SettingsProposeInput,
  settingsProposalSummary,
  type ModelRef,
  type Project,
  type SettingsChange,
  type SettingsProposalCard,
  type SettingsWorld,
  type ThreadId,
  type WorkspaceState,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineAppTool } from "../app-tools/definition.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { rosterOf } from "../orchestration/rules.ts";
import { CHARTER_MOVED, Orchestration } from "../orchestration/service.ts";
import { ThreadStore, type SettingsAuditEntry } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { selectableModels } from "../runtime/model-efforts.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { makeSettingsWriter } from "./writer.ts";

export interface SettingsToolsOptions {
  /** How long a card waits for the user; `SETTINGS_PROPOSAL_TTL_MS` unless a test says. */
  readonly proposalTtl?: Duration.Input;
}

const fail = (tool: string, message: string) => new AppToolError({ tool, message });

const WORKER_REFUSAL =
  "Workers can read Gram's settings but not propose changes to them: a change to the workspace's settings is the user's, asked for by the orchestrator in the thread the user watches. Tell your orchestrator what you need with report or message_orchestrator.";

/** What `changes` would do, or why nothing was proposed. */
const plan = (tool: string, world: SettingsWorld, changes: ReadonlyArray<SettingsChange>) => {
  const result = planSettingsChanges(world, changes);
  return result.ok
    ? Effect.succeed(result.plan)
    : Effect.fail(
        fail(tool, `Nothing was proposed. ${result.errors.join(" ")}`.replace(/\s+/g, " ").trim()),
      );
};

export const settingsAppToolsLayer = (options: SettingsToolsOptions = {}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* AppToolRegistry;
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const writer = yield* makeSettingsWriter;
      // Absent in runtime-only layers, which have no workspaces to change.
      const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
      const hosts = Option.getOrUndefined(yield* Effect.serviceOption(AgentHosts));
      const ttl = Duration.fromInputUnsafe(options.proposalTtl ?? SETTINGS_PROPOSAL_TTL_MS);

      /**
       * The workspace in scope for `caller`: its own (an orchestrator's, a worker's, or the one a
       * plain thread joined), or for a plain thread the one it names by id or name.
       */
      const workspaceInScope = (
        tool: string,
        caller: ThreadId,
        role: string,
        named: string | undefined,
      ) =>
        Effect.gen(function* () {
          const thread = yield* store.getThread(caller);
          const own = thread.workspaceId;
          const states = yield* store.listWorkspaces;
          if (named === undefined || named.trim() === "") {
            return own === undefined
              ? undefined
              : states.find((state) => state.workspace.id === own);
          }
          const wanted = named.trim().toLowerCase();
          const found =
            states.find((state) => state.workspace.id === named.trim()) ??
            states.find((state) => state.workspace.name.trim().toLowerCase() === wanted);
          if (found === undefined) {
            return yield* fail(
              tool,
              `There is no workspace ${named}. Workspaces: ${
                states
                  .map((state) => `${state.workspace.name} (${state.workspace.id})`)
                  .join(", ") || "none"
              }.`,
            );
          }
          if (role !== "plain" && found.workspace.id !== own) {
            return yield* fail(
              tool,
              "You can only read and propose settings for your own workspace. The user changes another workspace's settings in Settings, or from a thread of their own.",
            );
          }
          return found;
        }).pipe(
          Effect.mapError((e) =>
            e instanceof AppToolError ? e : fail(tool, `Couldn't read this thread: ${e.message}`),
          ),
        );

      const projectInScope = (
        tool: string,
        caller: ThreadId,
        state: WorkspaceState | undefined,
        named?: string,
      ) =>
        Effect.gen(function* () {
          const thread = yield* store
            .getThread(caller)
            .pipe(Effect.mapError((e) => fail(tool, e.message)));
          const projects = yield* store.listProjects;
          const inScope = projects.filter(
            (p) => p.id === thread.projectId || state?.workspace.projectIds.includes(p.id),
          );
          const matches =
            named === undefined
              ? []
              : inScope.filter((p) => p.name.toLowerCase() === named.toLowerCase());
          const byId = inScope.find((p) => p.id === named);
          if (named !== undefined && byId === undefined && matches.length > 1)
            return yield* fail(
              tool,
              "Several workspace projects have that name. Use the project id.",
            );
          const found =
            named === undefined
              ? inScope.find((p) => p.id === thread.projectId)
              : (byId ?? matches[0]);
          if (
            found === undefined ||
            (found.id !== thread.projectId && !state?.workspace.projectIds.includes(found.id))
          )
            return yield* fail(
              tool,
              "That project is not in this thread's workspace. Use a thread in that project or name a workspace project with projectId.",
            );
          return found;
        });

      /** The settings, the workspace, and the model its orchestrator runs on, if one holds it. */
      const worldOf = (workspace: WorkspaceState | undefined, project?: Project) =>
        Effect.gen(function* () {
          const settings = yield* store.getSettings;
          const holder = workspace?.workspace.orchestratorThreadId;
          const orchestrator =
            holder === undefined
              ? undefined
              : yield* store.getThread(holder).pipe(
                  Effect.map((thread) => thread.model),
                  Effect.orElseSucceed(() => undefined),
                );
          return { settings, workspace, project, orchestrator } satisfies SettingsWorld;
        });

      const settingsRead = defineAppTool({
        descriptor: {
          name: SETTINGS_READ_TOOL,
          class: "read",
          description:
            "Gram's settings you may see, with each value as it stands: `project` (the local check: a command with optional setup, and timeoutMs; without a command the local gate is off), `app` (appearance, motion, notifications, update channel, default models and the like) and, when this thread has one, its `workspace` (worker models with useFor, default and availability, max concurrent workers, merge review policy, the orchestrator's model and effort, pause). Each row's `tier` says how it changes: `project`, `workspace` and `preference` keys change through settings_propose, with the user's approval on a card every time; `userOnly` lists what no agent may change, with why. Secrets, keys, gateway profiles, folders and connectors are never read. Use projectId to name a workspace project by id or name; otherwise the current project is read. A plain thread may name another workspace by id or name with `workspaceId`.",
        },
        audience: ["orchestrator", "plain", "worker"],
        input: Schema.Struct({
          workspaceId: Schema.optionalKey(Schema.String),
          projectId: Schema.optionalKey(Schema.String),
        }),
        handle: (caller, { workspaceId, projectId }) =>
          Effect.gen(function* () {
            const tool = SETTINGS_READ_TOOL;
            const role = yield* runtimes.audienceOf(caller);
            if (role === "dream") return yield* fail(tool, "Dreams don't read Gram's settings.");
            const state = yield* workspaceInScope(tool, caller, role, workspaceId);
            const project = yield* projectInScope(tool, caller, state, projectId);
            const world = yield* worldOf(state, project);
            const unavailable =
              state === undefined || orchestration === undefined
                ? new Map<number, string>()
                : yield* orchestration
                    .workerModelAvailability(state.workspace.id)
                    .pipe(Effect.orElseSucceed(() => new Map<number, string>()));
            const roster = state?.charter.workerModels;
            return {
              app: readSettingsRows(world, "app"),
              project: {
                id: project.id,
                name: project.name,
                ...(project.localCheckUnavailable === undefined
                  ? {}
                  : { unavailable: project.localCheckUnavailable }),
                settings: readSettingsRows(world, "project"),
              },
              ...(state === undefined
                ? {}
                : {
                    workspace: {
                      id: state.workspace.id,
                      name: state.workspace.name,
                      settings: readSettingsRows(world, "workspace").map((row) =>
                        row.key === "workspace.workerModels" && roster !== undefined
                          ? { ...row, value: rosterOf(roster, unavailable) }
                          : row,
                      ),
                      ...(state.paused === undefined ? {} : { pausedReason: state.paused.reason }),
                    },
                  }),
              userOnly: readUserOnlyRows(world),
              howToChange:
                role === "worker"
                  ? WORKER_REFUSAL
                  : "Propose changes with settings_propose; the user approves each proposal on a card in this thread before anything changes.",
            };
          }),
      });

      /** The models a plan names, checked against what their agent lists, as the pickers do. */
      const checkModels = (tool: string, models: ReadonlyArray<ModelRef>) =>
        Effect.gen(function* () {
          const notes: Array<string> = [];
          if (hosts === undefined) return notes;
          for (const model of models) {
            const listed = yield* selectableModels(store, hosts, model.agent, model.profileId).pipe(
              Effect.map((choices) => ({ ok: true as const, choices })),
              Effect.catchCause(() => Effect.succeed({ ok: false as const })),
            );
            if (!listed.ok) {
              notes.push(
                `Gram couldn't list ${model.agent}'s models just now, so ${model.agent}:${model.model} wasn't checked.`,
              );
              continue;
            }
            const found = listed.choices.find(
              (option) => option.id === model.model || option.resolvedId === model.model,
            );
            if (found === undefined) {
              return yield* fail(
                tool,
                `${model.agent} has no model ${model.model}. It lists: ${listed.choices
                  .slice(0, 16)
                  .map((option) => option.id)
                  .join(", ")}.`,
              );
            }
            if (
              model.variant !== undefined &&
              found.efforts.length > 0 &&
              !found.efforts.includes(model.variant)
            ) {
              return yield* fail(
                tool,
                `${model.agent}:${model.model} has no ${model.variant} effort; it supports ${found.efforts.join(", ")}.`,
              );
            }
          }
          return notes;
        });

      const settingsPropose = defineAppTool({
        descriptor: {
          name: SETTINGS_PROPOSE_TOOL,
          // It raises its own card on every call, whatever the binding, mode or autonomy.
          class: "outwardGated",
          description:
            'Propose a change to Gram\'s settings. Gram checks it, shows the user a before → after card in this thread, and applies it only when they approve; this call waits for that answer and says whether it was applied, declined or expired (after 15 minutes). Each change is `{op: "set", key, value}` (`null` clears an optional key), or for a list key (`workspace.workerModels`, `agents.workerModels`) `{op: "add", key, item: {agent, model, variant?, speed?, useFor?, default?}}`, `{op: "update", key, match: "agent:model", item: {useFor?, default?, variant?, speed?}}` or `{op: "remove", key, match: "agent:model"}`. One proposal changes app settings, one workspace, or one project. projectId selects a project in this thread’s workspace; omit it for this thread’s project. settings_read lists the keys; pausing and resuming, autonomy, permission modes, connectors, credentials, gateways, folders and consent switches are the user\'s alone and are refused. Say why in `reason`, which the card shows.',
        },
        audience: ["orchestrator", "plain"],
        input: SettingsProposeInput,
        handle: (caller, { changes, reason, workspaceId, projectId }) =>
          Effect.gen(function* () {
            const tool = SETTINGS_PROPOSE_TOOL;
            // Who the caller is now, not which binding it was given: a Claude session keeps its
            // tools through a turn in which its role can change.
            const role = yield* runtimes.audienceOf(caller);
            if (role === "worker") return yield* fail(tool, WORKER_REFUSAL);
            if (role !== "orchestrator" && role !== "plain") {
              return yield* fail(tool, "Only the user's own threads may propose settings changes.");
            }
            const state = yield* workspaceInScope(tool, caller, role, workspaceId);
            const project = yield* projectInScope(tool, caller, state, projectId);
            const proposed = yield* plan(tool, yield* worldOf(state, project), changes);
            if (proposed.scope === "workspace" && orchestration === undefined) {
              return yield* fail(tool, "Workspaces can't be changed here.");
            }
            // The target is fixed now, by id: a rename, or another workspace taking this one's
            // name, never moves the approval elsewhere.
            const pinned = proposed.scope === "workspace" ? state?.workspace.id : undefined;
            const checked = yield* checkModels(tool, proposed.models);
            const notes = [...proposed.notes, ...checked];
            const trimmed = reason?.replace(/\s+/g, " ").trim();
            const card: SettingsProposalCard = {
              scope: proposed.scope,
              ...(proposed.scope === "project"
                ? { project: { id: project.id, name: project.name, root: project.root } }
                : {}),
              ...(proposed.scope === "workspace" && state !== undefined
                ? { workspace: { id: state.workspace.id, name: state.workspace.name } }
                : {}),
              ...(trimmed === undefined || trimmed === "" ? {} : { reason: trimmed }),
              rows: proposed.rows,
              ...(notes.length === 0 ? {} : { notes }),
            };

            const answer = yield* runtimes
              .requestApproval(caller, {
                toolName: `mcp__gram__${tool}`,
                displayName: "Change settings",
                input: card as unknown as Record<string, unknown>,
                description: settingsProposalSummary(card),
                suggestions: [],
                scopes: ["once"],
              })
              .pipe(
                // The timeout interrupts the wait, which withdraws the card.
                Effect.timeoutOption(ttl),
                Effect.catchTag("ThreadNotFound", () =>
                  Effect.fail(fail(tool, "Gram couldn't show the card: this thread is gone.")),
                ),
              );
            if (Option.isNone(answer)) {
              yield* Effect.logInfo("settings proposal expired").pipe(
                Effect.annotateLogs({ threadId: caller, scope: proposed.scope }),
              );
              return yield* fail(
                tool,
                `The settings proposal expired: the user didn't answer within ${Duration.format(ttl)}, so the card was withdrawn and nothing changed. Propose it again if it's still wanted.`,
              );
            }
            const answered = answer.value;
            if (answered.decision !== "allow") {
              const resolution = answered.resolution;
              const userDeclined =
                resolution === undefined ||
                (resolution.origin === "user" && resolution.reason === "rejected");
              yield* Effect.logInfo("settings proposal declined").pipe(
                Effect.annotateLogs({
                  threadId: caller,
                  scope: proposed.scope,
                  reason: resolution?.reason ?? "rejected",
                }),
              );
              return yield* new AppToolError({
                tool,
                message: userDeclined
                  ? "The user declined the settings change; nothing changed."
                  : `The settings card was withdrawn (${resolution.reason}); nothing changed.`,
                approvalRequired: true,
                ...(resolution === undefined ? {} : { approvalResolution: resolution }),
              });
            }

            // The approval is for this card's writes, on this card's target, by this caller as it
            // was when it asked: nothing is planned or resolved again.
            const roleNow = yield* runtimes.audienceOf(caller);
            const threadNow = yield* store
              .getThread(caller)
              .pipe(Effect.orElseSucceed(() => undefined));
            if (
              roleNow !== role ||
              (proposed.scope === "project" &&
                threadNow !== undefined &&
                threadNow.projectId !== project.id &&
                (threadNow.workspaceId !== state?.workspace.id ||
                  !(yield* store.listWorkspaces)
                    .find((s) => s.workspace.id === threadNow.workspaceId)
                    ?.workspace.projectIds.includes(project.id))) ||
              threadNow === undefined ||
              (role !== "plain" && pinned !== undefined && threadNow.workspaceId !== pinned)
            ) {
              return yield* fail(
                tool,
                "This thread's role or workspace changed while the card waited, so the approval no longer applies; nothing changed.",
              );
            }
            const appliedAt = yield* Clock.currentTimeMillis;
            const audit: SettingsAuditEntry = {
              at: appliedAt,
              threadId: caller,
              proposerRole: role,
              scope: proposed.scope,
              ...(answered.resolution?.requestId === undefined
                ? {}
                : { requestId: answered.resolution.requestId }),
              approvedBy: "user",
              approvedAt: answered.resolution?.resolvedAt ?? appliedAt,
              changes: proposed.writes.map(({ key, before, after }) => ({
                key,
                before: before ?? null,
                after: after ?? null,
              })),
              shown: proposed.rows,
              ...(card.reason === undefined ? {} : { reason: card.reason }),
            };
            const moved = () =>
              fail(
                tool,
                "Those settings changed while the card waited, so what was approved no longer matches; nothing changed. Read them again and propose anew.",
              );
            let auditSeq: number;
            if (proposed.scope === "app") {
              const done = yield* writer.commit(proposed.writes, audit, { announce: true });
              if (done === undefined) return yield* moved();
              auditSeq = done.auditSeq;
            } else if (proposed.scope === "project") {
              const done = yield* store.updateProjectLocalCheckAudited(
                project.id,
                proposed.writes,
                audit,
                proposed.projectLocalCheckRevision ?? "",
              );
              if (done === undefined) return yield* moved();
              auditSeq = done.auditSeq;
            } else {
              // Pausing and resuming are the user's alone, so there is no route to them from here.
              const done = yield* orchestration!
                .changeCharter(pinned!, proposed.writes, audit, proposed.requires)
                .pipe(
                  Effect.mapError((e) =>
                    e._tag === "InvalidState" && e.message === CHARTER_MOVED
                      ? moved()
                      : e._tag === "NotFound"
                        ? fail(
                            tool,
                            `The workspace “${card.workspace?.name ?? pinned}” is gone; nothing changed.`,
                          )
                        : fail(tool, e.message),
                  ),
                );
              auditSeq = done.auditSeq;
            }
            yield* Effect.logInfo("settings changed by chat").pipe(
              Effect.annotateLogs({
                threadId: caller,
                role,
                scope: proposed.scope,
                keys: proposed.writes.map((write) => write.key).join(","),
                auditSeq,
              }),
            );
            return {
              applied: true,
              scope: proposed.scope,
              changes: proposed.rows,
              auditSeq,
              ...(notes.length === 0 ? {} : { notes }),
            };
          }),
      });

      yield* registry.register([settingsRead, settingsPropose]);
    }),
  );

export const SettingsAppToolsLive = settingsAppToolsLayer();
