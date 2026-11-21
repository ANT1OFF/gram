import { type Project, type ProjectId, type ThreadId, type WorkspaceState } from "@gram/contracts";
import { basename, samePath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { dirname, isAbsolute, join } from "node:path";
import { registerRepo, repoFolder, repoIdentity } from "../../fs/folders.ts";
import { toolError, type OutsideRepo, type OrchestrationKit } from "./kit.ts";
import { type OrchestrationShape } from "./shape.ts";

/** One call's projects: those it registered, and those it resolved and holds claimed. */
export interface ProjectCall {
  readonly registered: Array<ProjectId>;
  readonly claimed: Array<ProjectId>;
  readonly identities?: Readonly<Record<string, string>> | undefined;
}

/** Finding, resolving and joining the projects a tool names. */
export const makeProjects = (kit: OrchestrationKit) => {
  const {
    store,
    authorityOf,
    runtimes,
    workspacesChanged,
    registryLock,
    claimedProjects,
    unjoinedRegistered,
  } = kit;

  const unknownRepo = (tool: string, needle: string, state: WorkspaceState) =>
    Effect.gen(function* () {
      if (needle.startsWith("~") || isAbsolute(needle)) {
        const root = yield* repoFolder(needle).pipe(
          Effect.mapError((e) => toolError(tool, e.message)),
        );
        return { root, name: basename(root) || root };
      }
      if (/[\\/]/.test(needle) || needle === "." || needle === "..") return undefined;
      const projects = yield* store.listProjects;
      const parents = [
        ...new Set(
          projects
            .filter((project) => state.workspace.projectIds.includes(project.id))
            .map((project) => dirname(project.root)),
        ),
      ];
      const found: Array<string> = [];
      for (const parent of parents) {
        const root = yield* repoFolder(join(parent, needle)).pipe(Effect.option);
        if (Option.isSome(root) && !found.some((other) => samePath(other, root.value))) {
          found.push(root.value);
        }
      }
      return found.length === 1 ? { root: found[0]!, name: needle } : undefined;
    });

  const lookupProject = (tool: string, named: string, state: WorkspaceState) =>
    Effect.gen(function* () {
      const needle = named.trim();
      const projects = yield* store.listProjects;
      const exact = projects.filter(
        (project) => project.id === needle || samePath(project.root, needle),
      );
      const byName = projects.filter(
        (project) => project.name.toLowerCase() === needle.toLowerCase(),
      );
      const inWorkspace = byName.filter((project) =>
        state.workspace.projectIds.includes(project.id),
      );
      const found = exact.length > 0 ? exact : inWorkspace.length > 0 ? inWorkspace : byName;
      if (found.length === 0) {
        const unknown = yield* unknownRepo(tool, needle, state);
        const known =
          unknown === undefined
            ? undefined
            : projects.find((project) => samePath(project.root, unknown.root));
        if (known !== undefined) return { known };
        if (unknown !== undefined) return { unknown };
        const names = projects
          .filter((project) => state.workspace.projectIds.includes(project.id))
          .map((project) => project.name)
          .join(", ");
        return yield* toolError(
          tool,
          `No project is called "${needle}". This workspace has: ${names}. For a repo Gram doesn't know yet, pass the absolute path of its folder: the user is asked to add it to the workspace. Or ask the user to add it with "Add repository…" on the workspace's menu in the sidebar.`,
        );
      }
      if (found.length > 1) {
        return yield* toolError(
          tool,
          `"${needle}" names ${found.length} projects (${found.map((p) => p.root).join(", ")}). Pass the project's root path instead.`,
        );
      }
      return { known: found[0]! };
    });

  const resolveProject = (tool: string, named: string, state: WorkspaceState, call: ProjectCall) =>
    Effect.gen(function* () {
      const found = yield* lookupProject(tool, named, state);
      const root = "known" in found ? found.known.root : found.unknown.root;
      const approved = call.identities?.[named];
      if (approved !== undefined && (yield* repoIdentity(root)) !== approved) {
        return yield* toolError(
          tool,
          `The repository at ${root} was replaced after the user was asked about it, so nothing was started there. Ask again if it is still wanted.`,
        );
      }
      return yield* registryLock.withPermits(1)(
        Effect.gen(function* () {
          const known = "known" in found ? found.known : undefined;
          if (known !== undefined) {
            const still = (yield* store.listProjects).find((each) => each.id === known.id);
            if (still !== undefined) return claim(call, still);
          }
          const { project, created } = yield* registerRepo(store, root).pipe(
            Effect.mapError((e) => toolError(tool, e.message)),
          );
          if (created) call.registered.push(project.id);
          return claim(call, project);
        }),
      );
    });

  const claim = (call: ProjectCall, project: Project) => {
    if (!call.claimed.includes(project.id)) {
      call.claimed.push(project.id);
      claimedProjects.set(project.id, (claimedProjects.get(project.id) ?? 0) + 1);
    }
    return project;
  };

  const forgetUnjoined = (candidates: ReadonlyArray<ProjectId>) =>
    Effect.gen(function* () {
      if (candidates.length === 0) return;
      const joined = new Set(
        (yield* store.listWorkspaces).flatMap((each) => each.workspace.projectIds),
      );
      for (const id of candidates) {
        if (joined.has(id)) {
          unjoinedRegistered.delete(id);
        } else if ((claimedProjects.get(id) ?? 0) > 0) {
          unjoinedRegistered.add(id);
        } else {
          unjoinedRegistered.delete(id);
          yield* store.forgetProject(id).pipe(Effect.ignore);
        }
      }
    });

  const projectCall = <A, E, R>(
    identities: Readonly<Record<string, string>> | undefined,
    f: (call: ProjectCall) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const call: ProjectCall = { registered: [], claimed: [], identities };
      return f(call).pipe(
        Effect.onExit((exit) =>
          call.claimed.length === 0 && call.registered.length === 0
            ? Effect.void
            : registryLock.withPermits(1)(
                Effect.gen(function* () {
                  const released: Array<ProjectId> = [];
                  for (const id of call.claimed) {
                    const left = (claimedProjects.get(id) ?? 1) - 1;
                    if (left === 0) {
                      claimedProjects.delete(id);
                      if (unjoinedRegistered.has(id)) released.push(id);
                    } else claimedProjects.set(id, left);
                  }
                  yield* forgetUnjoined([
                    ...new Set([...(Exit.isFailure(exit) ? call.registered : []), ...released]),
                  ]);
                }),
              ),
        ),
      );
    });

  const pinRepos: OrchestrationShape["pinRepos"] = (callerId, tool, named) =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(callerId);
      if (authority === undefined) return { pins: named, identities: {} };
      const pins: Array<string> = [];
      const identities: Record<string, string> = {};
      for (const name of named) {
        const found = yield* lookupProject(tool, name, authority.state);
        if ("known" in found) {
          pins.push(found.known.id);
          continue;
        }
        const { root } = found.unknown;
        const identity = yield* repoIdentity(root);
        if (identity === undefined) {
          return yield* toolError(tool, `Gram can't read the repository at ${root}.`);
        }
        pins.push(root);
        identities[root] = identity;
      }
      return { pins, identities };
    });

  const repoNames = (tool: string, named: ReadonlyArray<string>, state: WorkspaceState) =>
    Effect.forEach(named, (name) =>
      lookupProject(tool, name, state).pipe(
        Effect.map((found) => ("known" in found ? found.known.name : found.unknown.name)),
        Effect.orElseSucceed(() => name),
      ),
    );

  const joinWorkspace = (
    state: WorkspaceState,
    orchestratorId: ThreadId,
    projects: ReadonlyArray<Project>,
  ) =>
    Effect.gen(function* () {
      const joining = projects.filter(
        (project) => !state.workspace.projectIds.includes(project.id),
      );
      if (joining.length === 0) return;
      yield* store
        .updateWorkspace(state.workspace.id, (current) => ({
          ...current,
          workspace: {
            ...current.workspace,
            projectIds: [
              ...current.workspace.projectIds,
              ...joining
                .map((project) => project.id)
                .filter((id) => !current.workspace.projectIds.includes(id)),
            ],
          },
        }))
        .pipe(Effect.ignore);
      yield* runtimes
        .addDirectories(
          orchestratorId,
          joining.map((project) => project.root),
        )
        .pipe(Effect.ignore);
      yield* workspacesChanged;
    });

  const outsideWorkspace = (tool: string, named: ReadonlyArray<string>, state: WorkspaceState) =>
    Effect.gen(function* () {
      const outside: Array<OutsideRepo> = [];
      for (const name of named) {
        const found = yield* lookupProject(tool, name, state).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const repo: OutsideRepo | undefined =
          found === undefined
            ? undefined
            : "known" in found
              ? state.workspace.projectIds.includes(found.known.id)
                ? undefined
                : { name: found.known.name, root: found.known.root }
              : { ...found.unknown, unknown: true };
        if (repo !== undefined && !outside.some((other) => samePath(other.root, repo.root))) {
          outside.push(repo);
        }
      }
      return outside;
    });

  return {
    lookupProject,
    resolveProject,
    projectCall,
    pinRepos,
    repoNames,
    joinWorkspace,
    outsideWorkspace,
  };
};

/** What `makeProjects` makes, for the parts whose `deps` take some of it. */
export type Projects = ReturnType<typeof makeProjects>;
