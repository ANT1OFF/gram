// Workspaces: saving, naming and removing one, the workspace a
// project opens into, and `open`, which gives a workspace its orchestrator thread.
import {
  availableWorkspaceName,
  autonomyOf,
  InvalidState,
  NotFound,
  sameValue,
  settingsHold,
  WorkspaceId,
  type Autonomy,
  type ModelRef,
  type ProjectId,
  type ThreadId,
  type WorkspaceState,
} from "@gram/contracts";
import { samePath } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { subscriptionTaskCharter } from "../task-models.ts";
import { sameTaskModel } from "../task-selection.ts";
import { outboxForNewOrchestrator } from "../outbox.ts";
import { admittedForRole, kindName } from "../rules.ts";
import {
  OUTBOX_UNREADABLE_DETAIL,
  DIGEST_KEY,
  refuseConnectorEntries,
  underKeysOf,
  type OrchestrationKit,
} from "./kit.ts";
import type { Charter } from "./charter.ts";
import { type OrchestrationShape } from "./shape.ts";
import type { Digests } from "./digests.ts";
import type { Pauses } from "./pauses.ts";
import type { TaskStartup } from "./task-startup.ts";

/** What workspaces take from the rest of the service. */
export interface WorkspacesDeps {
  readonly forgetReasons: Digests["forgetReasons"];
  readonly openModel: TaskStartup["openModel"];
  readonly endRecovery: Pauses["endRecovery"];
  readonly deliveryFor: Digests["deliveryFor"];
  readonly checkCharter: Charter["checkCharter"];
  readonly afterCharter: Charter["afterCharter"];
}

/** Whether two reads of a workspace agree in all an approval was given against. */
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
    orchestrators,
    openedInAuto,
    releaseSetAside,
    updateOutbox,
    memory,
    orchestrationChanged,
    reasons,
    taskStartupLock,
    workspaceStartupKeys,
  } = kit;
  const { forgetReasons, openModel, endRecovery, deliveryFor, checkCharter, afterCharter } = deps;

  /**
   * The orchestrator's folders after its workspace's projects changed from `before`: a repo that
   * left takes its folder with it, the others are granted, and the session reloads to read them.
   */
  const followMembership = (
    holder: ThreadId,
    before: ReadonlyArray<ProjectId>,
    state: WorkspaceState,
  ) =>
    Effect.gen(function* () {
      const { projectIds, homeProjectId } = state.workspace;
      const all = yield* store.listProjects;
      // A repo that left takes its folder with it: the grant outlives the session otherwise.
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
      // The orchestrator reads the other repos as extra folders, and its prompt names them.
      const roots = all
        .filter((project) => projectIds.includes(project.id) && project.id !== homeProjectId)
        .map((project) => project.root);
      yield* runtimes.addDirectories(holder, roots).pipe(Effect.ignore);
      yield* reload(holder);
    });

  // Under the workspace's spawn lock: a spawn joining a repo to the workspace, and an edit taking
  // one out, each leave the workspace and the orchestrator's folders agreeing only when neither
  // interleaves. A new workspace has no spawns to wait for. Then under `registryLock`, since names
  // are unique across workspaces and a failed spawn's project mustn't be forgotten as this takes
  // it in.
  const saveWorkspaceWithName = (
    input: Parameters<OrchestrationShape["saveWorkspace"]>[0],
    namePolicy: "exact" | "available",
  ): ReturnType<OrchestrationShape["saveWorkspace"]> =>
    spawnLock.withLocks(
      input.id === undefined ? [] : [input.id],
      registryLock.withPermits(1)(
        Effect.gen(function* () {
          const others = (yield* store.listWorkspaces).filter(
            ({ workspace }) => workspace.id !== input.id,
          );
          // Automatic opens pick a free name under the same lock that reserves explicit names.
          const name =
            namePolicy === "available"
              ? availableWorkspaceName(
                  input.name,
                  others.map(({ workspace }) => workspace.name),
                )
              : input.name.trim();
          if (name === "") return yield* new InvalidState({ message: "A workspace needs a name." });
          const duplicate = others.some(
            ({ workspace }) => workspace.name.trim().toLowerCase() === name.toLowerCase(),
          );
          if (duplicate) {
            return yield* new InvalidState({
              message: "A workspace with that name already exists.",
            });
          }
          const projectIds = [...new Set(input.projectIds)] as unknown as typeof input.projectIds;
          if (!projectIds.includes(input.homeProjectId)) {
            return yield* new InvalidState({
              message: "The home project has to be one of the workspace's projects.",
            });
          }
          // Every one of them a project Gram knows.
          yield* projectsOf(projectIds);
          const given = input.charter;
          if (given !== undefined) {
            if (input.id !== undefined) {
              return yield* new InvalidState({
                message: "A saved workspace's charter changes through orchestrator.setCharter.",
              });
            }
            yield* refuseConnectorEntries(given);
            const own = given.orchestratorModel;
            if (own !== undefined && !admittedForRole(own.agent, "orchestrator")) {
              return yield* new InvalidState({
                message: `${kindName(own.agent)} threads can't be orchestrators yet.`,
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
            workspace: {
              ...current.workspace,
              name,
              projectIds,
              homeProjectId: input.homeProjectId,
            },
          }));
          yield* workspacesChanged;
          if (holder !== undefined) {
            yield* followMembership(holder, before.workspace.projectIds, state);
          }
          return state;
        }),
      ),
    );

  const saveWorkspace: OrchestrationShape["saveWorkspace"] = (input) =>
    saveWorkspaceWithName(input, "exact");

  const commitWorkspace: OrchestrationShape["commitWorkspace"] = (change) =>
    Effect.gen(function* () {
      const expected = change.expected;
      const id = expected?.workspace.id ?? Schema.decodeSync(WorkspaceId)(randomUUID());
      const write = Effect.gen(function* () {
        const name = change.name.trim();
        if (name === "") return yield* new InvalidState({ message: "A workspace needs a name." });
        const others = (yield* store.listWorkspaces).filter(({ workspace }) => workspace.id !== id);
        if (
          others.some(({ workspace }) => workspace.name.trim().toLowerCase() === name.toLowerCase())
        ) {
          return yield* new InvalidState({ message: "A workspace with that name already exists." });
        }
        if (change.projects.length === 0) {
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
        // Read before anything is checked, and compared again inside the write's transaction.
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
        const createdAt = yield* Clock.currentTimeMillis;
        return yield* store.commitWorkspaceAudited({
          id,
          unchanged: (current) =>
            expected === undefined
              ? current === undefined
              : current !== undefined && sameWorkspace(current, expected),
          register,
          next: (current, registered) => {
            const ids = change.projects.map((each) =>
              "projectId" in each ? each.projectId : registered[register.indexOf(each)]!.id,
            );
            const projectIds = [
              ...new Set(ids),
            ] as unknown as WorkspaceState["workspace"]["projectIds"];
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
      /**
       * What a committed change sets off: the windows told, a charter change's notes and reloads,
       * and the orchestrator's folders made to follow its projects, so a repo that left takes its
       * grant with it.
       */
      const follow = (done: { readonly state: WorkspaceState }) =>
        Effect.gen(function* () {
          yield* workspacesChanged;
          if (expected === undefined) return;
          yield* orchestrationChanged(id);
          yield* afterCharter(id, done.state, expected.charter);
          const holder = done.state.workspace.orchestratorThreadId;
          if (
            holder !== undefined &&
            (!sameValue(expected.workspace.projectIds, done.state.workspace.projectIds) ||
              expected.workspace.homeProjectId !== done.state.workspace.homeProjectId)
          ) {
            yield* followMembership(holder, expected.workspace.projectIds, done.state);
          }
        });
      // Task startups, spawns and saves of this workspace, then names across workspaces: the
      // order every other path takes them in. Once the write has begun, neither it nor what it
      // sets off can be cut short: a call cancelled after the commit still takes a removed repo's
      // folder from the orchestrator.
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
        // The store refuses an open orchestrator too; asked first, so a refusal stops no dream.
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
        // Every dream's thread, running or finished and however it was started, since its review
        // goes with the workspace; the store refuses a delete while one is still open.
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

  /** The one-project workspace of `projectId`, made on first use at `autonomy` when given. */
  const workspaceOfProject = (
    projectId: ProjectId,
    autonomy: Autonomy | undefined,
    selected?: ModelRef,
  ) =>
    workspaceLock.withLock(
      projectId,
      Effect.gen(function* () {
        const [project] = yield* projectsOf([projectId]);
        const existing = (yield* store.listWorkspaces).find(
          (state) =>
            state.workspace.projectIds.length === 1 && state.workspace.projectIds[0] === projectId,
        );
        if (existing !== undefined) {
          // Made meanwhile, by another window say: it keeps its own level, and the task must not
          // start under one the draft promised and this workspace doesn't have.
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
      const { model, mode } = yield* openModel(state.charter, selected);
      const thread = yield* creator
        .createIn({ kind: "current" }, home.root, {
          title: `Orchestrator · ${workspace.name}`,
          model,
          mode,
          role: "orchestrator",
          workspaceId: workspace.id,
          additionalDirectories: projects
            .filter((project) => project.id !== home.id)
            .map((project) => project.root),
          // The session policy asks for the slot, which can only be claimed once the row exists.
          deferOpen: true,
        })
        .pipe(
          Effect.catchTags({
            CheckoutInUse: (e) => Effect.fail(new InvalidState({ message: e.message })),
            GitError: (e) => Effect.fail(new InvalidState({ message: e.message })),
          }),
        );
      if (!(yield* store.claimOrchestratorSlot(workspace.id, thread.id))) {
        // Another open won the slot while this thread was being made; it must leave no trace,
        // not even on the reopen list.
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
      // A pause for an orchestrator that couldn't be reached, or that was parked, was about the
      // thread this one replaces; the user's own pause, and the one a re-enable starts with, stay.
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
      // Opening another orchestrator ends the set-aside pause as Resume would, and lets go too.
      if (endedSetAside) yield* releaseSetAside(workspace.id);
      const latestSeq = yield* store.latestWorkerReportSeq(workspace.id);
      yield* updateOutbox(workspace.id, (outbox) => [
        outboxForNewOrchestrator(outbox, latestSeq),
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

  return { saveWorkspace, commitWorkspace, whileWorkspaceStays, removeWorkspace, open };
};
