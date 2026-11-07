import type { Project, ProjectId, Thread, WorkspaceId, WorkspaceState } from "@gram/contracts";

/** Where a New task goes: a workspace, or a repo whose one-project workspace is made on send. */
export type TaskTarget =
  | { readonly kind: "workspace"; readonly workspaceId: WorkspaceId }
  | { readonly kind: "repo"; readonly projectId: ProjectId };

/** Who picks a task up: the orchestrator, or one worker started from it at once. */
export type TaskWay = "plan" | "direct";

/** A target as one string, for remembering it. */
export const taskTargetKey = (target: TaskTarget): string =>
  target.kind === "workspace" ? `w:${target.workspaceId}` : `p:${target.projectId}`;

/** Most useful first: bookmarked, then the most recently opened. */
const byUse = (a: Project, b: Project) =>
  Number(b.bookmarked) - Number(a.bookmarked) || (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0);

/**
 * The projects a task can make a workspace for: those no workspace has yet, most useful first.
 * `repoRoot` can't pick out the git repos among them, since a project a thread registered has none
 * stored; a folder without git is refused on send, when its worker can't have a worktree.
 */
export const reposWithoutWorkspace = (
  workspaces: readonly WorkspaceState[],
  projects: readonly Project[],
): Project[] => {
  const taken = new Set(workspaces.flatMap((state) => state.workspace.projectIds));
  return projects.filter((p) => !taken.has(p.id)).toSorted(byUse);
};

/** Whether `target` still names something the picker offers. */
const offered = (
  target: TaskTarget,
  workspaces: readonly WorkspaceState[],
  repos: readonly Project[],
): boolean =>
  target.kind === "workspace"
    ? workspaces.some((state) => state.workspace.id === target.workspaceId)
    : repos.some((project) => project.id === target.projectId);

const inWorkspace = (state: WorkspaceState): TaskTarget => ({
  kind: "workspace",
  workspaceId: state.workspace.id,
});

/**
 * Why the draft starts on its target: the workspace page it was opened from (`page`), the thread it
 * was opened from (`thread`, through that thread's repo), the last task's target (`last`), the only
 * workspace there is (`only`), or the most useful repo or the first workspace (`first`). Only `last`
 * is remembered rather than read off where the user is, so only it is marked as such.
 */
export type TaskTargetFrom = "page" | "thread" | "last" | "only" | "first";

/**
 * Which target the draft starts on, and why (`from`): where it was opened from. A workspace's own
 * page (`here`) is that workspace. From a thread, its repo decides: the thread's own workspace (an
 * orchestrator's or a worker's), else the workspace that is only that repo, else one it is part of,
 * else that repo, to make a workspace for on send. Only from neither do the last one used, the only
 * workspace, and then the most useful repo come in. `undefined` when Gram knows no project at all.
 */
export function startingTaskTarget(input: {
  readonly current?: Thread | undefined;
  readonly here?: WorkspaceId | undefined;
  readonly workspaces: readonly WorkspaceState[];
  readonly projects: readonly Project[];
  readonly last?: TaskTarget | undefined;
}): { readonly target: TaskTarget; readonly from: TaskTargetFrom } | undefined {
  const { current, here, workspaces, projects, last } = input;
  const repos = reposWithoutWorkspace(workspaces, projects);
  const page = workspaces.find((state) => here !== undefined && state.workspace.id === here);
  if (page !== undefined) return { target: inWorkspace(page), from: "page" };
  if (current !== undefined) {
    const own = workspaces.find((state) => state.workspace.id === current.workspaceId);
    if (own !== undefined) return { target: inWorkspace(own), from: "thread" };
    const having = workspaces.filter((state) =>
      state.workspace.projectIds.includes(current.projectId),
    );
    const mine =
      having.find((state) => state.workspace.projectIds.length === 1) ??
      having.find((state) => state.workspace.homeProjectId === current.projectId) ??
      having[0];
    // Also before the projects list has it, which would otherwise fall through to another target.
    return {
      target:
        mine === undefined ? { kind: "repo", projectId: current.projectId } : inWorkspace(mine),
      from: "thread",
    };
  }
  if (last !== undefined && offered(last, workspaces, repos)) return { target: last, from: "last" };
  if (workspaces.length === 1) return { target: inWorkspace(workspaces[0]!), from: "only" };
  if (repos[0] !== undefined)
    return { target: { kind: "repo", projectId: repos[0].id }, from: "first" };
  return workspaces[0] === undefined
    ? undefined
    : { target: inWorkspace(workspaces[0]), from: "first" };
}

/** The target `startingTaskTarget` picks, without why. */
export const defaultTaskTarget = (
  input: Parameters<typeof startingTaskTarget>[0],
): TaskTarget | undefined => startingTaskTarget(input)?.target;

/**
 * `target`, with a repo that has its own one-project workspace by now as that workspace: the server
 * starts the task there rather than make another, so a draft opened before it existed must say so
 * instead of offering a new workspace's autonomy.
 */
export const settledTaskTarget = (
  target: TaskTarget | undefined,
  workspaces: readonly WorkspaceState[],
): TaskTarget | undefined => {
  if (target?.kind !== "repo") return target;
  const own = workspaces.find(
    ({ workspace }) =>
      workspace.projectIds.length === 1 && workspace.projectIds[0] === target.projectId,
  );
  return own === undefined ? target : inWorkspace(own);
};

/** The repos a worker straight from the draft may start in, home first. */
export const taskRepos = (
  target: TaskTarget,
  workspaces: readonly WorkspaceState[],
  projects: readonly Project[],
): Project[] => {
  if (target.kind === "repo") return projects.filter((p) => p.id === target.projectId);
  const state = workspaces.find((each) => each.workspace.id === target.workspaceId);
  if (state === undefined) return [];
  const { homeProjectId, projectIds } = state.workspace;
  return [homeProjectId, ...projectIds.filter((id) => id !== homeProjectId)].flatMap((id) =>
    projects.filter((p) => p.id === id),
  );
};
