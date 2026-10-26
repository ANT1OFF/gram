// Workspaces by chat (docs/design/settings-by-chat.md#workspaces): `workspace_list`,
// `workspace_create` and `workspace_update`. A workspace's repos, home, autonomy and worker mode
// decide what its agents reach and may do without asking, so every create or update is shown whole
// on one card and applied only when the user approves it, at every autonomy and in every mode.

import {
  applyCharterWrites,
  autonomyOf,
  autonomyText,
  charterRows,
  planSettingsChanges,
  readSettingsRows,
  SETTINGS_PROPOSAL_TTL_MS,
  WORKSPACE_CREATE_TOOL,
  WORKSPACE_LIST_TOOL,
  WORKSPACE_UPDATE_TOOL,
  WorkspaceCreateInput,
  WorkspaceListInput,
  workerModeText,
  WorkspaceUpdateInput,
  workspaceProposalSummary,
  type OrchestratorCharter,
  type Project,
  type ProjectId,
  type SettingsChange,
  type SettingsDiffRow,
  type SettingsWorld,
  type SettingsWrite,
  type ThreadId,
  type WorkspaceProposalCard,
  type WorkspaceProposalProject,
  type WorkspaceState,
} from "@gram/contracts";
import { projectRootKey } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { basename, isAbsolute, resolve } from "node:path";
import { defineAppTool } from "../app-tools/definition.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { registerRepo, repoFolder } from "../fs/folders.ts";
import { subscriptionTaskCharter } from "../orchestration/task-models.ts";
import { CHARTER_MOVED, Orchestration } from "../orchestration/service.ts";
import { ThreadStore, type SettingsAuditEntry } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import type { ServerApprovalAnswer } from "../runtime/server-approvals.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { askUser, checkModels, fail } from "./approval.ts";
import type { SettingsToolsOptions } from "./chat-tools.ts";

const WORKER_REFUSAL =
  "Workers can't create or change workspaces: which repos a workspace reaches and what its agents may do without asking are the user's, asked for by the orchestrator or a thread the user chats with. Tell your orchestrator what you need with report or message_orchestrator.";

const NOT_HERE = "Workspaces can't be created or changed here.";

/** A repository a card names: a project Gram knows, or a top folder it would register. */
interface Repo {
  readonly root: string;
  readonly name: string;
  readonly project?: Project | undefined;
}

const sameRoot = (a: string, b: string) => projectRootKey(a) === projectRootKey(b);

/** `named` among `projects`: by project id, or by path. */
const matchProject = <P extends Repo>(projects: ReadonlyArray<P>, named: string): P | undefined => {
  const wanted = named.trim();
  return (
    projects.find((each) => each.project?.id === wanted) ??
    (isAbsolute(wanted) ? projects.find((each) => sameRoot(each.root, resolve(wanted))) : undefined)
  );
};

const listText = (projects: ReadonlyArray<Repo>) =>
  projects.map((each) => `${each.name} (${each.root})`).join(", ") || "none";

/** The charter's changes as audit rows: each stored field, before and after, `null` for absent. */
const auditChanges = (writes: ReadonlyArray<SettingsWrite>) =>
  writes.map(({ key, before, after }) => ({ key, before: before ?? null, after: after ?? null }));

/** A card's project list as audit rows, beside its other rows. */
const projectRows = (projects: ReadonlyArray<WorkspaceProposalProject>): Array<SettingsDiffRow> =>
  projects.map((each) => ({
    key: "workspace.projectIds",
    label: `Project ${each.root}`,
    before: each.change === "added" ? null : each.name,
    after:
      each.change === "removed"
        ? null
        : `${each.name}${each.home === true ? " · home" : ""}${each.unregistered === true ? " · new to Gram" : ""}`,
  }));

/** A path as a project root, refused unless it is a git repository's top folder now. */
const repoAt = (tool: string, path: string, known: ReadonlyArray<Project>) =>
  Effect.gen(function* () {
    const given = path.trim();
    if (!isAbsolute(given)) {
      return yield* fail(
        tool,
        `${given} isn't an absolute path. Name each project by the absolute path of its git repository's top folder.`,
      );
    }
    const root = yield* repoFolder(given).pipe(
      Effect.mapError((e) => fail(tool, `Nothing was proposed: ${e.message}`)),
    );
    const project = known.find((each) => sameRoot(each.root, root));
    return project === undefined
      ? { root, name: basename(root) || root }
      : { root: project.root, name: project.name, project };
  });

/** A change by chat's audit row, from the card the user approved. */
const auditOf = (
  caller: ThreadId,
  role: string,
  answered: ServerApprovalAnswer,
  appliedAt: number,
  card: WorkspaceProposalCard,
  changes: SettingsAuditEntry["changes"],
): SettingsAuditEntry => ({
  at: appliedAt,
  threadId: caller,
  proposerRole: role,
  scope: "workspace",
  ...(answered.resolution?.requestId === undefined
    ? {}
    : { requestId: answered.resolution.requestId }),
  approvedBy: "user",
  approvedAt: answered.resolution?.resolvedAt ?? appliedAt,
  changes,
  shown: [...projectRows(card.projects), ...card.rows],
  ...(card.reason === undefined ? {} : { reason: card.reason }),
});

const reasonOf = (reason: string | undefined) => {
  const trimmed = reason?.replace(/\s+/g, " ").trim();
  return trimmed === undefined || trimmed === "" ? {} : { reason: trimmed };
};

export const workspaceAppToolsLayer = (options: SettingsToolsOptions = {}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* AppToolRegistry;
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      // Absent in runtime-only layers, which have no workspaces to change.
      const orchestration = Option.getOrUndefined(yield* Effect.serviceOption(Orchestration));
      const hosts = Option.getOrUndefined(yield* Effect.serviceOption(AgentHosts));
      const ttl = Duration.fromInputUnsafe(options.proposalTtl ?? SETTINGS_PROPOSAL_TTL_MS);

      /** The caller as it is now, refused unless it is a thread the user chats with or directs. */
      const proposer = (tool: string, caller: ThreadId) =>
        Effect.gen(function* () {
          // Who the caller is now, not which binding it was given: a Claude session keeps its
          // tools through a turn in which its role can change.
          const role = yield* runtimes.audienceOf(caller);
          if (role === "worker") return yield* fail(tool, WORKER_REFUSAL);
          if (role !== "orchestrator" && role !== "plain") {
            return yield* fail(tool, "Only the user's own threads may propose workspace changes.");
          }
          if (orchestration === undefined) return yield* fail(tool, NOT_HERE);
          return { role, service: orchestration } as const;
        });

      const threadOf = (tool: string, caller: ThreadId) =>
        store
          .getThread(caller)
          .pipe(Effect.mapError((e) => fail(tool, `Couldn't read this thread: ${e.message}`)));

      /** Each path as a repository, the same one named twice kept once. */
      const reposAt = (tool: string, paths: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const known = yield* store.listProjects;
          const repos: Array<Repo> = [];
          for (const path of paths) {
            const repo = yield* repoAt(tool, path, known);
            if (!repos.some((each) => sameRoot(each.root, repo.root))) repos.push(repo);
          }
          return repos;
        });

      /** The name, refused when another workspace has it, ignoring case and spacing. */
      const freeName = (tool: string, name: string, own?: string) =>
        Effect.gen(function* () {
          const wanted = name.trim();
          if (wanted === "") return yield* fail(tool, "A workspace needs a name.");
          const taken = (yield* store.listWorkspaces).find(
            ({ workspace }) =>
              workspace.id !== own && workspace.name.trim().toLowerCase() === wanted.toLowerCase(),
          );
          if (taken !== undefined) {
            return yield* fail(
              tool,
              `Nothing was proposed: a workspace named “${taken.workspace.name}” already exists (${taken.workspace.id}). Change it with workspace_update, or choose another name.`,
            );
          }
          return wanted;
        });

      /** The charter after `changes`, which must be workspace keys, planned as settings_propose does. */
      const planCharter = (
        tool: string,
        world: SettingsWorld,
        changes: ReadonlyArray<SettingsChange> | undefined,
      ) =>
        Effect.gen(function* () {
          if (changes === undefined || changes.length === 0) return undefined;
          const result = planSettingsChanges(world, changes, { allowUnchanged: true });
          if (!result.ok) {
            return yield* fail(
              tool,
              `Nothing was proposed. ${result.errors.join(" ")}`.replace(/\s+/g, " ").trim(),
            );
          }
          if (result.plan.scope !== "workspace") {
            return yield* fail(
              tool,
              "Nothing was proposed: settings here are the workspace's own (workspace.* keys). Propose app and project settings with settings_propose.",
            );
          }
          const notes = yield* checkModels(store, hosts, tool, result.plan.models);
          return { plan: result.plan, notes };
        });

      /** Registers each repository Gram doesn't know yet, after the user approved the card. */
      const registerAll = (tool: string, repos: ReadonlyArray<Repo>) =>
        Effect.gen(function* () {
          // Every folder checked again first, so a vanished one stops the change before anything.
          for (const repo of repos) {
            yield* repoFolder(repo.root).pipe(Effect.mapError((e) => fail(tool, e.message)));
          }
          const projects: Array<Project> = [];
          for (const repo of repos) {
            const { project } = yield* registerRepo(store, repo.root).pipe(
              Effect.mapError((e) => fail(tool, e.message)),
            );
            projects.push(project);
          }
          return projects;
        });

      const workspaceList = defineAppTool({
        descriptor: {
          name: WORKSPACE_LIST_TOOL,
          class: "read",
          description:
            "The user's Gram workspaces: each one's id and name, its projects (id, name and absolute root), its home project, autonomy, worker mode, the orchestrator's thread when one is open, whether it is paused, and its charter settings as settings_read shows them. A plain thread sees every workspace; an orchestrator its own. `workspaceId` keeps one, by id or name. Make one with workspace_create and change one with workspace_update; the user approves each on a card.",
        },
        audience: ["orchestrator", "plain"],
        input: WorkspaceListInput,
        handle: (caller, { workspaceId }) =>
          Effect.gen(function* () {
            const tool = WORKSPACE_LIST_TOOL;
            const role = yield* runtimes.audienceOf(caller);
            if (role === "worker") return yield* fail(tool, WORKER_REFUSAL);
            if (role !== "orchestrator" && role !== "plain") {
              return yield* fail(tool, "Only the user's own threads may list workspaces.");
            }
            const thread = yield* threadOf(tool, caller);
            const settings = yield* store.getSettings;
            const projects = yield* store.listProjects;
            const wanted = workspaceId?.trim().toLowerCase();
            const states = (yield* store.listWorkspaces).filter(
              (state) =>
                (role === "plain" || state.workspace.id === thread.workspaceId) &&
                (wanted === undefined ||
                  wanted === "" ||
                  state.workspace.id.toLowerCase() === wanted ||
                  state.workspace.name.trim().toLowerCase() === wanted),
            );
            const workspaces = [];
            for (const state of states) {
              const { workspace, charter } = state;
              const holder =
                workspace.orchestratorThreadId === undefined
                  ? undefined
                  : yield* store
                      .getThread(workspace.orchestratorThreadId)
                      .pipe(Effect.orElseSucceed(() => undefined));
              const own = workspace.projectIds.flatMap((id) => {
                const project = projects.find((each) => each.id === id);
                return project === undefined
                  ? []
                  : [{ id: project.id, name: project.name, root: project.root }];
              });
              workspaces.push({
                id: workspace.id,
                name: workspace.name,
                projects: own,
                home: own.find((project) => project.id === workspace.homeProjectId),
                autonomy: autonomyOf(charter),
                workerMode: workerModeText(charter.workerMode),
                ...(holder === undefined ? {} : { orchestratorThreadId: holder.id }),
                ...(state.paused === undefined ? {} : { pausedReason: state.paused.reason }),
                settings: readSettingsRows(
                  { settings, workspace: state, orchestrator: holder?.model },
                  "workspace",
                ),
              });
            }
            return { workspaces };
          }),
      });

      const workspaceCreate = defineAppTool({
        descriptor: {
          name: WORKSPACE_CREATE_TOOL,
          // It raises its own card on every call, whatever the binding, mode or autonomy.
          class: "outwardGated",
          description:
            "Propose a new Gram workspace. Gram checks it, then shows the user one card with the whole workspace: its name, each project path (marking repositories Gram doesn't know yet), the home project, autonomy, worker mode and charter settings. It is created only when they approve; this call waits for that answer and says whether it was created, declined or expired (after 15 minutes). `projects` are absolute paths of git repositories' top folders, each of which must exist; a repository Gram doesn't know yet is registered as a project on approval. `home` is the project the orchestrator runs in, by path; the first project when absent. `autonomy` is supervised (asks before anything leaves the machine), publish (pushes and opens PRs, asks before merging) or full (asks about nothing); absent, a new workspace's default. `workerMode` is auto, acceptEdits, default (workers ask before each edit and command) or bypassPermissions. `settings` takes settings_propose's changes on workspace.* keys: worker models with useFor, max concurrent workers, merge review policy, the orchestrator's model and effort and the rest settings_read lists. `openOrchestrator: true` opens the new workspace's orchestrator once it exists, so you can message it with send_message. Say why in `reason`, which the card shows.",
        },
        audience: ["orchestrator", "plain"],
        input: WorkspaceCreateInput,
        handle: (caller, input) =>
          Effect.gen(function* () {
            const tool = WORKSPACE_CREATE_TOOL;
            const { role, service } = yield* proposer(tool, caller);
            const name = yield* freeName(tool, input.name);
            const repos = yield* reposAt(tool, input.projects);
            const home = input.home === undefined ? repos[0] : matchProject(repos, input.home);
            if (home === undefined) {
              return yield* fail(
                tool,
                `Nothing was proposed: the home project ${input.home} isn't one of the projects. They are: ${listText(repos)}.`,
              );
            }
            const settings = yield* store.getSettings;
            const base: OrchestratorCharter = {
              ...subscriptionTaskCharter(settings.agents, input.autonomy),
              ...(input.workerMode === undefined ? {} : { workerMode: input.workerMode }),
            };
            // What a new workspace would be, so the settings plan against it as they do any other.
            const draft = (charter: OrchestratorCharter): WorkspaceState => ({
              workspace: {
                id: "new" as WorkspaceState["workspace"]["id"],
                name,
                projectIds: ["new"] as unknown as WorkspaceState["workspace"]["projectIds"],
                homeProjectId: "new" as ProjectId,
                createdAt: 0,
              },
              charter,
            });
            const planned = yield* planCharter(
              tool,
              { settings, workspace: draft(base) },
              input.settings,
            );
            const charter =
              planned === undefined ? base : applyCharterWrites(base, planned.plan.writes)!;
            const notes = planned?.notes ?? [];
            const card: WorkspaceProposalCard = {
              action: "create",
              workspace: { name },
              projects: repos.map((repo) => ({
                root: repo.root,
                name: repo.name,
                change: "added",
                ...(repo.project === undefined ? { unregistered: true } : {}),
                ...(repo === home ? { home: true } : {}),
              })),
              rows: [
                {
                  key: "workspace.autonomy",
                  label: "Autonomy",
                  before: null,
                  after: autonomyText(autonomyOf(charter)),
                },
                {
                  key: "workspace.workerMode",
                  label: "Worker mode",
                  before: null,
                  after: workerModeText(charter.workerMode),
                },
                ...charterRows({ settings, workspace: draft(charter) }),
                ...(input.openOrchestrator === true
                  ? [
                      {
                        key: "workspace.orchestrator",
                        label: "Open its orchestrator",
                        before: null,
                        after: "yes",
                      },
                    ]
                  : []),
              ],
              ...reasonOf(input.reason),
              ...(notes.length === 0 ? {} : { notes }),
            };

            const answered = yield* askUser(
              runtimes,
              caller,
              tool,
              ttl,
              "workspace",
              {
                displayName: "Create workspace",
                input: card as unknown as Record<string, unknown>,
                description: workspaceProposalSummary(card),
              },
              { action: "create" },
            );

            // The approval is for this card, by this caller as it was when it asked.
            if ((yield* runtimes.audienceOf(caller)) !== role) {
              return yield* fail(
                tool,
                "This thread's role changed while the card waited, so the approval no longer applies; nothing changed.",
              );
            }
            const projects = yield* registerAll(tool, repos).pipe(
              Effect.mapError((e) => fail(tool, `${e.message} The workspace wasn't created.`)),
            );
            const homeProject = projects[repos.indexOf(home)]!;
            const projectIds = projects.map(
              (project) => project.id,
            ) as unknown as WorkspaceState["workspace"]["projectIds"];
            const appliedAt = yield* Clock.currentTimeMillis;
            const audit = auditOf(caller, role, answered, appliedAt, card, [
              { key: "workspace.name", before: null, after: name },
              { key: "workspace.projectIds", before: null, after: projectIds },
              { key: "workspace.homeProjectId", before: null, after: homeProject.id },
              ...Object.entries(charter).map(([field, value]) => ({
                key: `workspace.${field}`,
                before: null,
                after: value ?? null,
              })),
            ]);
            const saved = yield* service
              .saveWorkspaceApproved(
                { name, projectIds, homeProjectId: homeProject.id, charter },
                audit,
              )
              .pipe(
                Effect.mapError((e) => fail(tool, `${e.message} The workspace wasn't created.`)),
              );
            const state = saved!.state;
            yield* Effect.logInfo("workspace created by chat").pipe(
              Effect.annotateLogs({
                threadId: caller,
                role,
                workspaceId: state.workspace.id,
                auditSeq: saved!.auditSeq,
              }),
            );
            const opened =
              input.openOrchestrator === true
                ? yield* service.open({ workspaceId: state.workspace.id }).pipe(
                    Effect.map((thread): Record<string, string> => ({
                      orchestratorThreadId: thread.id,
                    })),
                    Effect.catch((e) =>
                      Effect.succeed({
                        openFailed: `The workspace was created, but its orchestrator didn't open: ${e.message}`,
                      }),
                    ),
                  )
                : {};
            return {
              applied: true,
              workspace: { id: state.workspace.id, name: state.workspace.name },
              projects: projects.map((project) => ({
                id: project.id,
                name: project.name,
                root: project.root,
                ...(project.id === homeProject.id ? { home: true } : {}),
              })),
              ...opened,
              auditSeq: saved!.auditSeq,
              ...(notes.length === 0 ? {} : { notes }),
            };
          }),
      });

      const workspaceUpdate = defineAppTool({
        descriptor: {
          name: WORKSPACE_UPDATE_TOOL,
          // It raises its own card on every call, whatever the binding, mode or autonomy.
          class: "outwardGated",
          description:
            "Propose a change to a Gram workspace: rename it (`name`), add projects by absolute path (`addProjects`, git repositories' top folders; one Gram doesn't know yet is registered on approval), remove projects by path or project id (`removeProjects`), choose the home project (`home`, by path or id), set `autonomy` or `workerMode` (null follows the default), and change charter settings (`settings`, settings_propose's changes on workspace.* keys). Gram checks it and shows the user one card with the whole change, before → after, and the project list; nothing changes until they approve, and this call waits for that answer and says whether it was applied, declined or expired (after 15 minutes). `workspaceId` names the workspace by id or name; an orchestrator may change only its own, which is the default there. The home project can't move while the workspace's orchestrator is open. workspace_list shows each workspace as it stands. Say why in `reason`, which the card shows.",
        },
        audience: ["orchestrator", "plain"],
        input: WorkspaceUpdateInput,
        handle: (caller, input) =>
          Effect.gen(function* () {
            const tool = WORKSPACE_UPDATE_TOOL;
            const { role, service } = yield* proposer(tool, caller);
            const thread = yield* threadOf(tool, caller);
            const states = yield* store.listWorkspaces;
            const named = input.workspaceId?.trim();
            const state =
              named === undefined || named === ""
                ? states.find((each) => each.workspace.id === thread.workspaceId)
                : (states.find((each) => each.workspace.id === named) ??
                  states.find(
                    (each) => each.workspace.name.trim().toLowerCase() === named.toLowerCase(),
                  ));
            if (state === undefined) {
              return yield* fail(
                tool,
                named === undefined || named === ""
                  ? "Name the workspace with workspaceId; workspace_list lists them."
                  : `There is no workspace ${named}. Workspaces: ${
                      states
                        .map((each) => `${each.workspace.name} (${each.workspace.id})`)
                        .join(", ") || "none"
                    }.`,
              );
            }
            // The workspace's own orchestrator may propose changes to it, on the user's card; never
            // to another's.
            if (role === "orchestrator" && state.workspace.id !== thread.workspaceId) {
              return yield* fail(
                tool,
                "You can only propose changes to your own workspace. The user changes another workspace in Settings, or from a thread of their own.",
              );
            }
            // The target is fixed now, by id: a rename, or another workspace taking this one's
            // name, never moves the approval elsewhere.
            const pinned = state.workspace.id;
            const { workspace, charter } = state;

            const known = yield* store.listProjects;
            const current: Array<Repo> = workspace.projectIds.flatMap((id) => {
              const project = known.find((each) => each.id === id);
              return project === undefined
                ? []
                : [{ root: project.root, name: project.name, project }];
            });
            // A project Gram no longer lists stays as it is: the card can't show it, so it can't go.
            const unlisted = workspace.projectIds.filter(
              (id) => !known.some((each) => each.id === id),
            );
            const removed: Array<Repo> = [];
            for (const each of input.removeProjects ?? []) {
              const found = matchProject(current, each);
              if (found === undefined) {
                return yield* fail(
                  tool,
                  `Nothing was proposed: ${each} isn't one of the workspace's projects. They are: ${listText(current)}.`,
                );
              }
              if (!removed.includes(found)) removed.push(found);
            }
            const toAdd = yield* reposAt(tool, input.addProjects ?? []);
            const both = toAdd.find((repo) =>
              removed.some((each) => sameRoot(each.root, repo.root)),
            );
            if (both !== undefined) {
              return yield* fail(
                tool,
                `Nothing was proposed: ${both.root} is named both to add and to remove.`,
              );
            }
            // One the workspace already has is no change.
            const fresh = toAdd.filter(
              (repo) => !current.some((each) => sameRoot(each.root, repo.root)),
            );
            const kept = current.filter((each) => !removed.includes(each));
            const after = [...kept, ...fresh];
            if (after.length === 0) {
              return yield* fail(
                tool,
                "Nothing was proposed: a workspace keeps at least one project.",
              );
            }
            const homeBefore = current.find((each) => each.project?.id === workspace.homeProjectId);
            const home =
              input.home === undefined
                ? after.find((each) => each === homeBefore)
                : matchProject(after, input.home);
            if (home === undefined) {
              return yield* fail(
                tool,
                input.home === undefined
                  ? `Nothing was proposed: the home project ${homeBefore?.name ?? workspace.homeProjectId} would be removed. Name a new home with home.`
                  : `Nothing was proposed: the home project ${input.home} isn't one of the workspace's projects after this change. They are: ${listText(after)}.`,
              );
            }
            const homeMoves = home !== homeBefore;
            const holder =
              workspace.orchestratorThreadId === undefined
                ? undefined
                : yield* store
                    .getThread(workspace.orchestratorThreadId)
                    .pipe(Effect.orElseSucceed(() => undefined));
            if (homeMoves && holder !== undefined) {
              return yield* fail(
                tool,
                "Nothing was proposed: the orchestrator works in the home project, so the home can't move while it is open. The user closes it first.",
              );
            }
            const name =
              input.name === undefined || input.name.trim() === workspace.name.trim()
                ? workspace.name
                : yield* freeName(tool, input.name, workspace.id);

            const settings = yield* store.getSettings;
            const world: SettingsWorld = {
              settings,
              workspace: state,
              orchestrator: holder?.model,
            };
            const planned = yield* planCharter(tool, world, input.settings);
            const writes: Array<SettingsWrite> = [...(planned?.plan.writes ?? [])];
            const rows: Array<SettingsDiffRow> = [];
            if (name !== workspace.name) {
              rows.push({
                key: "workspace.name",
                label: "Name",
                before: workspace.name,
                after: name,
              });
            }
            if (homeMoves) {
              rows.push({
                key: "workspace.homeProjectId",
                label: "Home project",
                before: homeBefore === undefined ? null : `${homeBefore.name} (${homeBefore.root})`,
                after: `${home.name} (${home.root})`,
              });
            }
            if (input.autonomy !== undefined && input.autonomy !== autonomyOf(charter)) {
              writes.push({
                key: "workspace.autonomy",
                path: ["autonomy"],
                before: charter.autonomy,
                after: input.autonomy,
              });
              rows.push({
                key: "workspace.autonomy",
                label: "Autonomy",
                before: autonomyText(autonomyOf(charter)),
                after: autonomyText(input.autonomy),
              });
            }
            const mode = input.workerMode === null ? undefined : input.workerMode;
            if (input.workerMode !== undefined && mode !== charter.workerMode) {
              writes.push({
                key: "workspace.workerMode",
                path: ["workerMode"],
                before: charter.workerMode,
                after: mode,
              });
              rows.push({
                key: "workspace.workerMode",
                label: "Worker mode",
                before: workerModeText(charter.workerMode),
                after: workerModeText(mode),
              });
            }
            rows.push(...(planned?.plan.rows ?? []));
            const projects: Array<WorkspaceProposalProject> = [
              ...current.map((each) => ({
                root: each.root,
                name: each.name,
                change: kept.includes(each) ? ("kept" as const) : ("removed" as const),
                ...(each === home ? { home: true } : {}),
              })),
              ...fresh.map((repo) => ({
                root: repo.root,
                name: repo.name,
                change: "added" as const,
                ...(repo.project === undefined ? { unregistered: true } : {}),
                ...(repo === home ? { home: true } : {}),
              })),
            ];
            const membershipChanges = removed.length > 0 || fresh.length > 0;
            if (rows.length === 0 && !membershipChanges) {
              return yield* fail(
                tool,
                "Nothing was proposed: this changes nothing, every value is already so.",
              );
            }
            const notes = [...(planned?.plan.notes ?? []), ...(planned?.notes ?? [])];
            if (input.autonomy !== undefined && input.autonomy !== autonomyOf(charter)) {
              notes.push(
                "The orchestrator and its workers reopen at the new autonomy once each is idle.",
              );
            }
            const card: WorkspaceProposalCard = {
              action: "update",
              workspace: { id: workspace.id, name: workspace.name },
              projects,
              rows,
              ...reasonOf(input.reason),
              ...(notes.length === 0 ? {} : { notes }),
            };

            const answered = yield* askUser(
              runtimes,
              caller,
              tool,
              ttl,
              "workspace",
              {
                displayName: "Change workspace",
                input: card as unknown as Record<string, unknown>,
                description: workspaceProposalSummary(card),
              },
              { action: "update", workspaceId: pinned },
            );

            // The approval is for this card's writes, on this card's workspace, by this caller as
            // it was when it asked: nothing is planned or resolved again.
            const roleNow = yield* runtimes.audienceOf(caller);
            const threadNow = yield* store
              .getThread(caller)
              .pipe(Effect.orElseSucceed(() => undefined));
            if (
              roleNow !== role ||
              threadNow === undefined ||
              (role === "orchestrator" && threadNow.workspaceId !== pinned)
            ) {
              return yield* fail(
                tool,
                "This thread's role or workspace changed while the card waited, so the approval no longer applies; nothing changed.",
              );
            }
            const moved = (what: string) =>
              fail(
                tool,
                `The workspace changed while the card waited, so what was approved no longer matches; ${what}. Read it again with workspace_list and propose anew.`,
              );
            const appliedAt = yield* Clock.currentTimeMillis;
            const auditSeqs: Array<number> = [];
            // The charter first: the change most likely to be refused at the last moment (a field
            // moved, or a lower autonomy a thread can't open under), refused before anything else.
            if (writes.length > 0) {
              const done = yield* service
                .changeCharter(
                  pinned,
                  writes,
                  auditOf(caller, role, answered, appliedAt, card, auditChanges(writes)),
                  planned?.plan.requires ?? [],
                )
                .pipe(
                  Effect.mapError((e) =>
                    e._tag === "InvalidState" && e.message === CHARTER_MOVED
                      ? moved("nothing changed")
                      : e._tag === "NotFound"
                        ? fail(tool, `The workspace “${workspace.name}” is gone; nothing changed.`)
                        : fail(tool, `${e.message} Nothing changed.`),
                  ),
                );
              auditSeqs.push(done.auditSeq);
            }
            const charterApplied =
              writes.length > 0
                ? " The charter changes on the card were applied; the name, projects and home weren't."
                : " Nothing changed.";
            if (membershipChanges || name !== workspace.name || homeMoves) {
              const registered = yield* registerAll(tool, fresh).pipe(
                Effect.mapError((e) => fail(tool, `${e.message}${charterApplied}`)),
              );
              const projectIds = [
                ...kept.map((each) => each.project!.id),
                ...unlisted,
                ...registered.map((project) => project.id),
              ] as unknown as WorkspaceState["workspace"]["projectIds"];
              const homeProjectId = home.project?.id ?? registered[fresh.indexOf(home)]!.id;
              const saved = yield* service
                .saveWorkspaceApproved(
                  { id: pinned, name, projectIds, homeProjectId },
                  auditOf(caller, role, answered, appliedAt, card, [
                    ...(name === workspace.name
                      ? []
                      : [{ key: "workspace.name", before: workspace.name, after: name }]),
                    ...(membershipChanges
                      ? [
                          {
                            key: "workspace.projectIds",
                            before: workspace.projectIds,
                            after: projectIds,
                          },
                        ]
                      : []),
                    ...(homeMoves
                      ? [
                          {
                            key: "workspace.homeProjectId",
                            before: workspace.homeProjectId,
                            after: homeProjectId,
                          },
                        ]
                      : []),
                  ]),
                  {
                    name: workspace.name,
                    projectIds: workspace.projectIds,
                    homeProjectId: workspace.homeProjectId,
                  },
                )
                .pipe(Effect.mapError((e) => fail(tool, `${e.message}${charterApplied}`)));
              if (saved === undefined) {
                return yield* moved(
                  writes.length > 0
                    ? "the charter changes on the card were applied, the name, projects and home weren't"
                    : "nothing changed",
                );
              }
              auditSeqs.push(saved.auditSeq);
            }
            yield* Effect.logInfo("workspace changed by chat").pipe(
              Effect.annotateLogs({
                threadId: caller,
                role,
                workspaceId: pinned,
                auditSeqs: auditSeqs.join(","),
              }),
            );
            return {
              applied: true,
              workspace: { id: pinned, name },
              changes: [...projectRows(projects.filter((each) => each.change !== "kept")), ...rows],
              auditSeqs,
              ...(notes.length === 0 ? {} : { notes }),
            };
          }),
      });

      yield* registry.register([workspaceList, workspaceCreate, workspaceUpdate]);
    }),
  );

export const WorkspaceAppToolsLive = workspaceAppToolsLayer();
