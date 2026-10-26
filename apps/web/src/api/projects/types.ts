import type { CloneSuggestions, Project, ProjectId, RepositoryCandidates } from "@gram/contracts";

/** `projects.*`: the repositories the user works in, cloning one, and the `/new` recents. */
export interface ProjectsApi {
  listProjects(): Promise<readonly Project[]>;
  /**
   * What a new workspace can pick its repositories from: the known projects that are repositories,
   * then every other repository directly in the default folder and the clone folder.
   */
  listRepositories(): Promise<RepositoryCandidates>;
  /**
   * The project whose root is the repository at `root`, registered if it is new. Rejects with
   * `NotFound` for a missing folder, `InvalidState` for one that isn't a repository's top folder.
   */
  addProject(root: string): Promise<Project>;
  /**
   * Clones a GitHub `owner/repo` or a git URL into `<into or the clone folder>/<repo>` and
   * registers it, or registers the clone already there. Rejects with `InvalidState` for a remote it
   * refuses or a folder holding something else, `GitError` when the clone fails. Aborting `signal`
   * stops the clone, which then leaves nothing behind.
   */
  cloneProject(
    remote: string,
    options?: { into?: string | undefined; signal?: AbortSignal | undefined },
  ): Promise<Project>;
  /** GitHub repositories to offer for cloning, as `owner/repo`; empty without `gh`. */
  cloneSuggestions(): Promise<CloneSuggestions>;
  /** Adds the project to the `/new` Bookmarks section, or removes it. */
  setProjectBookmarked(projectId: ProjectId, bookmarked: boolean): Promise<Project>;
  /** Removes the project from the `/new` recents; rejects with `InvalidState` while it has threads. */
  forgetProject(projectId: ProjectId): Promise<void>;
}
