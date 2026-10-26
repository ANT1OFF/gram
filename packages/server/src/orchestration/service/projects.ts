// Project lookup for the tools that name a repo (`spawn_worker`, `add_worker_repo`, joins): which
// registered project a name or path means, whether it is outside the workspace, and joining one to
// the workspace for a worker that needs it.

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

  // ---------------------------------------------------------------------------------------
  // What the tools call
  // ---------------------------------------------------------------------------------------

  /**
   * A repo Gram doesn't know yet that `needle` names: a path to one, or a plain name that
   * is the folder of exactly one repo beside the workspace's own. Only ever a card's subject, or
   * registered by a handler that the card has already asked about.
   */
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

  /**
   * `project` as a project id, a root path, or a name; refuses a name two projects share. A repo
   * Gram doesn't know yet comes back as `unknown`, as `unknownRepo` found it.
   */
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
        // A path that spells a known root another way (`~`, a trailing slash) is that project.
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

  /**
   * `lookupProject`, registering a repo Gram doesn't know yet, and noting in `registered`
   * a project this call created. Only for a handler whose approval check counts such a repo as
   * outside the workspace (`outsideWorkspace`), so the user has said yes to it before this runs;
   * one that isn't the repository `identities` says the card was about is refused.
   */
  const resolveProject = (tool: string, named: string, state: WorkspaceState, call: ProjectCall) =>
    Effect.gen(function* () {
      const found = yield* lookupProject(tool, named, state);
      const root = "known" in found ? found.known.root : found.unknown.root;
      // Pinned as a folder, it is held to the repository seen there, even if it was registered
      // meanwhile and now comes back as a project.
      const approved = call.identities?.[named];
      if (approved !== undefined && (yield* repoIdentity(root)) !== approved) {
        return yield* toolError(
          tool,
          `The repository at ${root} was replaced after the user was asked about it, so nothing was started there. Ask again if it is still wanted.`,
        );
      }
      // Registered or found again, and claimed, in one step under `registryLock`, so another
      // call's failure can't forget the project between this finding it and claiming it.
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

  /** Claims `project` for `call` until it ends (`claimedProjects`). Under `registryLock`. */
  const claim = (call: ProjectCall, project: Project) => {
    if (!call.claimed.includes(project.id)) {
      call.claimed.push(project.id);
      claimedProjects.set(project.id, (claimedProjects.get(project.id) ?? 0) + 1);
    }
    return project;
  };

  /**
   * Forgets the projects a failed call created, so a refusal leaves no project behind. One any
   * workspace has taken in since stays, and so does one a thread has opened in (`forgetProject`).
   * One another call in any workspace still holds waits for that call's end (`unjoinedRegistered`).
   * Under `registryLock`.
   */
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

  /**
   * Runs a call that may register the repos it names (`resolveProject`): what it resolves stays
   * claimed until it ends. Its end gives the claims back and, under the same lock, forgets what a
   * failure registered and what an earlier failure left to the last claim (`forgetUnjoined`).
   */
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

  /**
   * The repos `named` pinned once, before the approval check: a known project by its id, a repo
   * Gram doesn't know yet by its folder. The check, the card and the handler all read the
   * pins, so what runs is what was asked about, whatever is registered or renamed meanwhile. A
   * name that resolves to nothing refuses the call here, so no later lookup can find a repo the
   * check never saw.
   */
  const pinRepos: OrchestrationShape["pinRepos"] = (callerId, tool, named) =>
    Effect.gen(function* () {
      const authority = yield* authorityOf(callerId);
      // Without authority the handler refuses before it reads a repo.
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
        // Without it the handler couldn't tell this repository from one moved in after the card.
        if (identity === undefined) {
          return yield* toolError(tool, `Gram can't read the repository at ${root}.`);
        }
        pins.push(root);
        identities[root] = identity;
      }
      return { pins, identities };
    });

  /** The repos `named` as a card names them, whether pinned (`pinRepos`) or not. */
  const repoNames = (tool: string, named: ReadonlyArray<string>, state: WorkspaceState) =>
    Effect.forEach(named, (name) =>
      lookupProject(tool, name, state).pipe(
        Effect.map((found) => ("known" in found ? found.known.name : found.unknown.name)),
        Effect.orElseSucceed(() => name),
      ),
    );

  /**
   * Once the user has said yes to a project outside the workspace, it joins, and the orchestrator
   * reads it as one of its folders from then on.
   */
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

  /**
   * The repos among `named` that aren't the workspace's, a repo Gram doesn't know yet among
   * them (with `unknown`); a name that resolves to nothing is the handler's to refuse.
   */
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
