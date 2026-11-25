import {
  admitThread,
  callerPerson,
  mayReachMachinesOf,
  NOT_YOUR_MACHINE,
} from "../../host/ownership.ts";
import { OnDemand } from "../../embedding/on-demand.ts";
import { workspaceHost } from "../../embedding/workspace-machines.ts";
import {
  availableWorkspaceName,
  autonomyOf,
  InvalidState,
  NotFound,
  sameValue,
  settingsHold,
  WorkspaceId,
  type Autonomy,
  type HostId,
  type ModelRef,
  type Project,
  type ProjectId,
  type Thread,
  type ThreadId,
  type WorkspaceState,
  slotAgent,
  withWorkspaceEnvironment,
} from "@gram/contracts";
import { samePath } from "@gram/git";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FiberMap from "effect/FiberMap";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { subscriptionTaskCharter } from "../task-models.ts";
import { sameTaskModel } from "../task-selection.ts";
import { outboxForNewOrchestrator, withNotes } from "../outbox.ts";
import { admittedForRole, kindName } from "../rules.ts";
import {
  OUTBOX_UNREADABLE_DETAIL,
  DIGEST_KEY,
  refuseConnectorEntries,
  underKeysOf,
  type OrchestrationKit,
} from "./kit.ts";
import type { Charter } from "./charter.ts";
import { makeKeyedLock } from "../../git/keyed-lock.ts";
import { admitWorkspaceReader, projectWorkspaceOf } from "./reader-workspaces.ts";
import { readableWorkspacesOnly } from "../../embedding/readable-by.ts";
import type { OrchestrationShape } from "./shape.ts";
import type { Digests } from "./digests.ts";
import type { Pauses } from "./pauses.ts";
import type { TaskStartup } from "./task-startup.ts";

/** What workspaces take from the rest of the service. */
export interface WorkspacesDeps {
  /** The machine a workspace's orchestrator goes on, when it has one of its own. */
  readonly workspaceHost: (
    workspace: WorkspaceState["workspace"],
  ) => Effect.Effect<HostId | undefined, InvalidState>;
  readonly forgetReasons: Digests["forgetReasons"];
  readonly openModel: TaskStartup["openModel"];
  readonly endRecovery: Pauses["endRecovery"];
  readonly deliveryFor: Digests["deliveryFor"];
  readonly checkCharter: Charter["checkCharter"];
  readonly afterCharter: Charter["afterCharter"];
}

const sameWorkspace = (a: WorkspaceState, b: WorkspaceState) =>
  a.workspace.name === b.workspace.name &&
  a.workspace.homeProjectId === b.workspace.homeProjectId &&
  sameValue(a.workspace.projectIds, b.workspace.projectIds) &&
  sameValue(a.charter, b.charter);

/** Saving, removing and opening workspaces. */
export const makeWorkspaces = (kit: OrchestrationKit, deps: WorkspacesDeps) => {
  const {
    spawnLock,
    registryLock,
    store,
    projectsOf,
    workspacesChanged,
    findThread,
    runtimes,
    reload,
    removalLock,
    wakeTimers,
    handoffTimers,
    workspaceLock,
    creator,
    checkouts,
    orchestrators,
    openedInAuto,
    releaseSetAside,
    updateOutbox,
    memory,
    orchestrationChanged,
    reasons,
    taskStartupLock,
    workspaceStartupKeys,
    ownerOf,
  } = kit;
  const { forgetReasons, openModel, endRecovery, deliveryFor, checkCharter, afterCharter } = deps;

  const membershipLock = makeKeyedLock<WorkspaceId>();

  const followMembership = (workspaceId: WorkspaceId, before: ReadonlyArray<ProjectId>) =>
    membershipLock.withLock(
      workspaceId,
      Effect.gen(function* () {
        const state = yield* store
          .getWorkspace(workspaceId)
          .pipe(Effect.orElseSucceed(() => undefined));
        const holder = state?.workspace.orchestratorThreadId;
        if (state === undefined || holder === undefined) return;
        yield* syncFolders(holder, before, state);
      }),
    );

  const foldersFor = (hostId: HostId | undefined, projects: ReadonlyArray<Project>) =>
    hostId === undefined
      ? Effect.succeed(projects.map((project) => project.root))
      : Effect.forEach(projects, (project) =>
          checkouts.prepare({ kind: "current", hostId }, [], project.root).pipe(
            Effect.map((clone) => [clone.path]),
            Effect.catch((error) =>
              Effect.logWarning("an orchestrator's machine couldn't clone a project").pipe(
                Effect.annotateLogs({ project: project.name, reason: error.message }),
                Effect.as<Array<string>>([]),
              ),
            ),
          ),
        ).pipe(Effect.map((folders) => folders.flat()));

  const admitHolder = (workspaceId: WorkspaceId | undefined) =>
    Effect.gen(function* () {
      if (workspaceId === undefined) return;
      const state = yield* store.getWorkspace(workspaceId).pipe(Effect.option);
      if (Option.isSome(state)) yield* admitWorkspaceReader(state.value);
      const holder = Option.isSome(state) ? state.value.workspace.orchestratorThreadId : undefined;
      if (holder !== undefined) return yield* admitThread(store.getThread, ownerOf, holder);
      const ran = yield* store.closedHolderOf(workspaceId);
      if (ran === undefined) return;
      const reachable = ran !== "unreadable" && (yield* mayReachMachinesOf(ownerOf, ran));
      if (!reachable) return yield* new InvalidState({ message: NOT_YOUR_MACHINE });
    });

  const visibleWorkspaces = Effect.flatMap(store.listWorkspaces, (all) =>
    readableWorkspacesOnly(all, (state) => state.workspace),
  );

  const syncFolders = (holder: ThreadId, before: ReadonlyArray<ProjectId>, state: WorkspaceState) =>
    Effect.gen(function* () {
      const { projectIds, homeProjectId } = state.workspace;
      const all = yield* store.listProjects;
      const hostId = (yield* findThread(holder))?.checkout.hostId;
      if (hostId !== undefined) {
        const folders = yield* foldersFor(
          hostId,
          all.filter((project) => projectIds.includes(project.id) && project.id !== homeProjectId),
        );
        yield* runtimes
          .updateThread(holder, (thread) => ({ ...thread, additionalDirectories: folders }))
          .pipe(Effect.ignore);
        yield* reload(holder);
        return;
      }
      const left = all
        .filter((project) => before.includes(project.id) && !projectIds.includes(project.id))
        .map((project) => project.root);
      if (left.length > 0) {
        yield* runtimes
          .updateThread(holder, (thread) => ({
            ...thread,
            additionalDirectories: (thread.additionalDirectories ?? []).filter(
              (folder) => !left.some((root) => samePath(root, folder)),
            ),
          }))
          .pipe(Effect.ignore);
      }
      const roots = all
        .filter((project) => projectIds.includes(project.id) && project.id !== homeProjectId)
        .map((project) => project.root);
      yield* runtimes.addDirectories(holder, roots).pipe(Effect.ignore);
      yield* reload(holder);
    });

  const saveWorkspaceWithName = (
    input: Parameters<OrchestrationShape["saveWorkspace"]>[0],
    namePolicy: "exact" | "available",
  ): ReturnType<OrchestrationShape["saveWorkspace"]> =>
    Effect.andThen(
      admitHolder(input.id),
      spawnLock.withLocks(
        input.id === undefined ? [] : [input.id],
        registryLock.withPermits(1)(
          Effect.gen(function* () {
            const others = (yield* visibleWorkspaces).filter(
              ({ workspace }) => workspace.id !== input.id,
            );
            const name =
              namePolicy === "available"
                ? availableWorkspaceName(
                    input.name,
                    others.map(({ workspace }) => workspace.name),
                  )
                : input.name.trim();
            if (name === "")
              return yield* new InvalidState({ message: "A workspace needs a name." });
            const duplicate = others.some(
              ({ workspace }) => workspace.name.trim().toLowerCase() === name.toLowerCase(),
            );
            if (duplicate) {
              return yield* new InvalidState({
                message: "A workspace with that name already exists.",
              });
            }
            const projectIds = Arr.dedupe(input.projectIds);
            if (!projectIds.includes(input.homeProjectId)) {
              return yield* new InvalidState({
                message: "The home project has to be one of the workspace's projects.",
              });
            }
            yield* projectsOf(projectIds);
            const given = input.charter;
            if (given !== undefined) {
              if (input.id !== undefined) {
                return yield* new InvalidState({
                  message: "A saved workspace's charter changes through orchestrator.setCharter.",
                });
              }
              yield* refuseConnectorEntries(given);
              const own = slotAgent(given.orchestratorModel);
              if (own !== undefined && !admittedForRole(own, "orchestrator")) {
                return yield* new InvalidState({
                  message: `${kindName(own)} threads can't be orchestrators yet.`,
                });
              }
            }
            if (input.id === undefined) {
              const charter = given ?? subscriptionTaskCharter((yield* store.getSettings).agents);
              const state: WorkspaceState = {
                workspace: {
                  id: Schema.decodeSync(WorkspaceId)(randomUUID()),
                  name,
                  projectIds,
                  homeProjectId: input.homeProjectId,
                  createdAt: yield* Clock.currentTimeMillis,
                  ...(input.environment == null ? {} : { environment: input.environment }),
                },
                charter,
              };
              yield* store.putWorkspace(state);
              yield* workspacesChanged;
              return state;
            }
            const before = yield* store.getWorkspace(input.id);
            const holder = before.workspace.orchestratorThreadId;
            const homeMoves = before.workspace.homeProjectId !== input.homeProjectId;
            if (homeMoves && holder !== undefined && (yield* findThread(holder)) !== undefined) {
              return yield* new InvalidState({
                message:
                  "The orchestrator works in the home project. Close it before choosing another home.",
                threadId: holder,
              });
            }
            const state = yield* store.updateWorkspace(input.id, (current) => ({
              ...current,
              workspace: withWorkspaceEnvironment(
                { ...current.workspace, name, projectIds, homeProjectId: input.homeProjectId },
                input.environment,
              ),
            }));
            yield* workspacesChanged;
            if (holder !== undefined) {
              yield* followMembership(input.id, before.workspace.projectIds);
            }
            return state;
          }),
        ),
      ),
    );

  const saveWorkspace: OrchestrationShape["saveWorkspace"] = (input) =>
    saveWorkspaceWithName(input, "exact");

  const commitWorkspace: OrchestrationShape["commitWorkspace"] = (change) =>
    Effect.gen(function* () {
      const expected = change.expected;
      yield* admitHolder(expected?.workspace.id);
      const id = expected?.workspace.id ?? Schema.decodeSync(WorkspaceId)(randomUUID());
      const write = Effect.gen(function* () {
        const name = change.name.trim();
        if (name === "") return yield* new InvalidState({ message: "A workspace needs a name." });
        const others = (yield* visibleWorkspaces).filter(({ workspace }) => workspace.id !== id);
        if (
          others.some(({ workspace }) => workspace.name.trim().toLowerCase() === name.toLowerCase())
        ) {
          return yield* new InvalidState({ message: "A workspace with that name already exists." });
        }
        const projects = change.projects;
        if (!Arr.isReadonlyArrayNonEmpty(projects)) {
          return yield* new InvalidState({ message: "A workspace keeps at least one project." });
        }
        const register = change.projects.flatMap((each) => ("root" in each ? [each] : []));
        const home = change.home;
        const homeAt = change.projects.findIndex((each) =>
          "projectId" in home
            ? "projectId" in each && each.projectId === home.projectId
            : "root" in each && each.root === home.root,
        );
        if (homeAt < 0) {
          return yield* new InvalidState({
            message: "The home project has to be one of the workspace's projects.",
          });
        }
        const standing = expected === undefined ? undefined : yield* store.getWorkspace(id);
        if (expected !== undefined && !sameWorkspace(standing!, expected)) return undefined;
        const holder = standing?.workspace.orchestratorThreadId;
        const homeMoves =
          expected !== undefined &&
          !(
            "projectId" in change.home && change.home.projectId === expected.workspace.homeProjectId
          );
        if (homeMoves && holder !== undefined && (yield* findThread(holder)) !== undefined) {
          return yield* new InvalidState({
            message:
              "The orchestrator works in the home project. Close it before choosing another home.",
            threadId: holder,
          });
        }
        yield* checkCharter(standing, change.charter);
        const known = yield* store.listProjects;
        const roots: Record<string, string> = {};
        for (const each of change.projects) {
          if ("root" in each) {
            yield* change.grant(each.root);
            continue;
          }
          const project = known.find((row) => row.id === each.projectId);
          if (project === undefined) {
            return yield* new NotFound({
              entity: "project",
              id: each.projectId,
              message: "A project on the card no longer exists in Gram.",
            });
          }
          yield* change.grant(project.root);
          roots[project.id] = project.root;
        }
        const createdAt = yield* Clock.currentTimeMillis;
        return yield* store.commitWorkspaceAudited({
          id,
          unchanged: (current) =>
            expected === undefined
              ? current === undefined
              : current !== undefined && sameWorkspace(current, expected),
          register,
          roots,
          next: (current, registered) => {
            const ids = Arr.map(projects, (each) =>
              "projectId" in each ? each.projectId : registered[register.indexOf(each)]!.id,
            );
            const projectIds = Arr.dedupe(ids);
            const homeProjectId = ids[homeAt]!;
            return current === undefined
              ? {
                  workspace: { id, name, projectIds, homeProjectId, createdAt },
                  charter: change.charter,
                }
              : {
                  ...current,
                  workspace: { ...current.workspace, name, projectIds, homeProjectId },
                  charter: change.charter,
                };
          },
          audit: change.audit,
          holds: (settings) => settingsHold(settings, change.requires ?? []),
        });
      });
      const follow = (done: { readonly state: WorkspaceState }) =>
        Effect.gen(function* () {
          yield* workspacesChanged;
          if (expected === undefined) return;
          yield* orchestrationChanged(id);
          yield* afterCharter(id, done.state, expected.charter);
          if (
            !sameValue(expected.workspace.projectIds, done.state.workspace.projectIds) ||
            expected.workspace.homeProjectId !== done.state.workspace.homeProjectId
          ) {
            yield* followMembership(id, expected.workspace.projectIds);
          }
        });
      const done = yield* Effect.uninterruptible(
        (expected === undefined
          ? registryLock.withPermits(1)(write)
          : underKeysOf(
              taskStartupLock,
              workspaceStartupKeys(id),
              spawnLock.withLocks([id], registryLock.withPermits(1)(write)),
            )
        ).pipe(
          Effect.tap((committed) => (committed === undefined ? Effect.void : follow(committed))),
        ),
      );
      return done;
    });

  const whileWorkspaceStays: OrchestrationShape["whileWorkspaceStays"] = (workspaceId, effect) =>
    removalLock.withLock(workspaceId, store.getWorkspace(workspaceId).pipe(Effect.andThen(effect)));

  const removeWorkspace: OrchestrationShape["removeWorkspace"] = (workspaceId) =>
    removalLock.withLock(
      workspaceId,
      Effect.gen(function* () {
        const { workspace } = yield* store.getWorkspace(workspaceId);
        const holder =
          workspace.orchestratorThreadId === undefined
            ? undefined
            : yield* findThread(workspace.orchestratorThreadId);
        if (holder !== undefined) {
          return yield* new InvalidState({
            message: `Close the orchestrator of ${workspace.name} before removing the workspace.`,
            threadId: holder.id,
          });
        }
        const dreamThreads = new Set<ThreadId>();
        for (const dream of yield* store.listDreams(workspaceId)) {
          if (dream.threadId !== undefined) dreamThreads.add(dream.threadId);
        }
        for (const thread of yield* store.listThreads) {
          if (thread.role === "dream" && thread.workspaceId === workspaceId) {
            dreamThreads.add(thread.id);
          }
        }
        for (const threadId of dreamThreads) {
          yield* runtimes.close(threadId).pipe(Effect.ignore);
        }
        yield* store.removeWorkspace(workspaceId);
        yield* FiberMap.remove(wakeTimers, workspaceId);
        yield* FiberMap.remove(handoffTimers, workspaceId);
        forgetReasons(workspaceId);
        yield* workspacesChanged;
      }),
    );

  const workspaceOfProject = (
    projectId: ProjectId,
    autonomy: Autonomy | undefined,
    selected?: ModelRef,
  ) =>
    workspaceLock.withLock(
      projectId,
      Effect.gen(function* () {
        const [project] = yield* projectsOf([projectId]);
        const existing = yield* projectWorkspaceOf(
          yield* store.listWorkspaces,
          projectId,
          yield* store.listProjects,
        );
        if (existing !== undefined) {
          if (autonomy !== undefined && autonomyOf(existing.charter) !== autonomy) {
            return yield* new InvalidState({
              message: `${existing.workspace.name} already has a workspace, at ${autonomyOf(existing.charter)} autonomy, which it keeps. Send again to start the task there.`,
            });
          }
          return existing;
        }
        const charter = subscriptionTaskCharter(
          (yield* store.getSettings).agents,
          autonomy,
          selected,
        );
        return yield* saveWorkspaceWithName(
          {
            name: project!.name,
            projectIds: [projectId],
            homeProjectId: projectId,
            charter,
          },
          "available",
        );
      }),
    );

  const open: OrchestrationShape["open"] = (target, selected, requireNew = false) =>
    Effect.gen(function* () {
      const state =
        "projectId" in target
          ? yield* workspaceOfProject(target.projectId, target.autonomy, selected)
          : yield* store.getWorkspace(target.workspaceId);
      yield* admitWorkspaceReader(state);
      const { workspace } = state;
      const holder =
        workspace.orchestratorThreadId === undefined
          ? undefined
          : yield* findThread(workspace.orchestratorThreadId);
      if (holder !== undefined) {
        if (requireNew)
          return yield* new InvalidState({
            message: "Workspace already has an orchestrator; explicit linking is required.",
          });
        if (selected !== undefined && !sameTaskModel(holder.model, selected))
          return yield* new InvalidState({
            message: "The task's orchestrator changed. Check the task preview and start again.",
          });
        return holder;
      }

      const projects = yield* projectsOf(workspace.projectIds);
      const home = projects.find((project) => project.id === workspace.homeProjectId);
      if (home === undefined) {
        return yield* new NotFound({ entity: "project", id: workspace.homeProjectId });
      }
      const { model, mode, note } = yield* openModel(state.charter, selected);
      const others = projects.filter((project) => project.id !== home.id);
      const hostId = yield* deps.workspaceHost(workspace);
      const thread = yield* creator
        .prepare({ kind: "current", ...(hostId === undefined ? {} : { hostId }) }, home.root)
        .pipe(
          Effect.flatMap((checkout) =>
            Effect.gen(function* () {
              const additionalDirectories = yield* foldersFor(checkout.hostId, others);
              return yield* runtimes.create({
                projectRoot: home.root,
                checkout,
                title: `Orchestrator · ${workspace.name}`,
                model,
                mode,
                role: "orchestrator",
                workspaceId: workspace.id,
                additionalDirectories,
                deferOpen: true,
              });
            }),
          ),
        )
        .pipe(
          Effect.catchTags({
            CheckoutInUse: (e) => Effect.fail(new InvalidState({ message: e.message })),
            GitError: (e) => Effect.fail(new InvalidState({ message: e.message })),
          }),
        );
      return yield* seat(workspace.id, thread, mode, note, requireNew);
    });

  const seat = (
    workspaceId: WorkspaceId,
    thread: Thread,
    mode: Thread["mode"],
    note: string | undefined,
    requireNew: boolean,
  ) =>
    Effect.gen(function* () {
      const workspace = { id: workspaceId };
      if (!(yield* store.claimOrchestratorSlot(workspace.id, thread.id))) {
        yield* runtimes.close(thread.id).pipe(Effect.ignore);
        yield* store.forgetClosed(thread.id);
        const winner = (yield* store.getWorkspace(workspace.id)).workspace.orchestratorThreadId;
        const won = winner === undefined ? undefined : yield* findThread(winner);
        if (won !== undefined && !requireNew) return won;
        return yield* new InvalidState({
          message: "Another orchestrator was being opened for this workspace. Try again.",
        });
      }
      orchestrators.set(thread.id, workspace.id);
      if (mode === "auto") openedInAuto.add(thread.id);
      let endedSetAside = false;
      const claimed = yield* store.updateWorkspace(workspace.id, (current) => {
        if (current.paused?.reason !== "deliveryFailed" && current.paused?.reason !== "parked") {
          return current;
        }
        endedSetAside = current.paused.detail === OUTBOX_UNREADABLE_DETAIL;
        const { paused: _, ...rest } = current;
        return rest;
      });
      yield* endRecovery(workspace.id);
      if (endedSetAside) yield* releaseSetAside(workspace.id);
      const latestSeq = yield* store.latestWorkerReportSeq(workspace.id);
      yield* updateOutbox(workspace.id, (outbox) => [
        withNotes(outboxForNewOrchestrator(outbox, latestSeq), note === undefined ? [] : [note]),
        undefined,
      ]);
      yield* memory
        .init(workspace.id)
        .pipe(
          Effect.catch((e) =>
            Effect.logWarning("orchestration memory not initialised").pipe(
              Effect.annotateLogs({ workspaceId: workspace.id, error: e.message }),
            ),
          ),
        );
      yield* workspacesChanged;
      yield* orchestrationChanged(workspace.id);
      reasons.set(workspace.id, new Set(["session start"]));
      if (claimed.paused === undefined) {
        yield* runtimes
          .requestSystemDelivery(thread.id, DIGEST_KEY, deliveryFor(workspace.id))
          .pipe(Effect.catchTag("ThreadNotFound", () => Effect.void));
      }
      return thread;
    });

  const openFromProfile: OrchestrationShape["openFromProfile"] = (input) =>
    Effect.gen(function* () {
      const id = input.workspaceId;
      const made = yield* registryLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* store.getWorkspace(id).pipe(Effect.option);
          if (Option.isSome(existing)) return { state: existing.value, created: false };
          yield* refuseConnectorEntries(input.charter);
          const project = yield* store.ensureProject({ root: input.projectRoot, name: input.name });
          const taken = (yield* store.listWorkspaces).map(({ workspace }) => workspace.name);
          const state: WorkspaceState = {
            workspace: {
              id,
              name: availableWorkspaceName(input.name, taken),
              projectIds: [project.id],
              homeProjectId: project.id,
              createdAt: yield* Clock.currentTimeMillis,
              fromProfile: true,
            },
            charter: input.charter,
          };
          yield* store.putWorkspace(state);
          return { state, created: true };
        }),
      );
      if (made.created) yield* workspacesChanged;
      const { workspace } = made.state;
      if (workspace.fromProfile !== true)
        return yield* new InvalidState({ message: "That workspace wasn't made from a profile." });
      const holder =
        workspace.orchestratorThreadId === undefined
          ? undefined
          : yield* findThread(workspace.orchestratorThreadId);
      if (holder !== undefined) return holder;
      const { model, mode, note } = yield* openModel(made.state.charter);
      if (!sameTaskModel(model, input.model))
        return yield* new InvalidState({
          message: `The profile's orchestrator can't run on ${input.model.model} here${note === undefined ? "." : `: ${note}`}`,
        });
      const thread = yield* input.create({
        model,
        mode,
        title: `Orchestrator · ${workspace.name}`,
        workspaceId: id,
      });
      return yield* seat(id, thread, mode, undefined, true);
    });

  const arrive: OrchestrationShape["arrive"] = (write) =>
    registryLock
      .withPermits(1)(
        Effect.gen(function* () {
          const taken = (yield* store.listWorkspaces).map(({ workspace }) => workspace.name);
          return yield* write(taken);
        }),
      )
      .pipe(Effect.tap(() => workspacesChanged));

  return {
    saveWorkspace,
    commitWorkspace,
    whileWorkspaceStays,
    removeWorkspace,
    open,
    openFromProfile,
    arrive,
  };
};

/**
 * `makeWorkspaces` with each workspace's own machine from the embedder's host provider, where one
 * is set: absent, no workspace has a machine of its own.
 */
export const makeWorkspacesHere = (
  kit: OrchestrationKit,
  deps: Omit<WorkspacesDeps, "workspaceHost">,
) =>
  Effect.map(Effect.serviceOption(OnDemand), (found) =>
    makeWorkspaces(kit, {
      ...deps,
      workspaceHost: (workspace) =>
        Effect.flatMap(callerPerson, (person) =>
          workspaceHost(Option.isSome(found), kit.joinedMachines, person, workspace),
        ),
    }),
  );
