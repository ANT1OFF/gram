import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { AgentSessionList } from "../depth.ts";
import { AgentKind, Project } from "../domain.ts";
import { ProjectId } from "../ids.ts";
import { AgentUnavailable, GitError, InvalidState, NotFound } from "../errors.ts";
import {
  AddProjectPayload,
  CloneProjectPayload,
  CloneSuggestions,
  ForgetProjectPayload,
  RepositoryCandidates,
  SetProjectBookmarkedPayload,
} from "../projects.ts";
import { ProjectScripts, SaveProjectScriptsPayload } from "../project-scripts.ts";
import { DeleteSessionPayload } from "../resume.ts";
import { SessionPreview, SessionPreviewPayload } from "../session-preview.ts";
import { PositiveInt, errors } from "./shared.ts";

/** Projects: the repositories the user works in, and the agents' past sessions in them. */
export const ProjectRpcs = RpcGroup.make(
  /** The agent's past sessions for a folder, newest first, marking those a thread already shows. */
  Rpc.make("sessions.list", {
    payload: {
      agent: AgentKind,
      projectRoot: Schema.String,
      limit: Schema.optionalKey(PositiveInt),
    },
    success: AgentSessionList,
    error: errors(NotFound, InvalidState, AgentUnavailable),
  }),
  /** Deletes a past session from the agent's history; rejects while a thread shows it. */
  Rpc.make("sessions.delete", {
    payload: DeleteSessionPayload,
    error: errors(NotFound, InvalidState, AgentUnavailable),
  }),
  /** A past session's first prompt and last reply, for the resume picker; empty when unreadable. */
  Rpc.make("sessions.preview", {
    payload: SessionPreviewPayload,
    success: SessionPreview,
    error: errors(NotFound, InvalidState, AgentUnavailable),
  }),
  Rpc.make("projects.list", { success: Schema.Array(Project), error: errors() }),
  /** What a new workspace can pick its repositories from; `RepositoryCandidates` says what. */
  Rpc.make("projects.repositories", { success: RepositoryCandidates, error: errors() }),
  /**
   * `NotFound` for a missing folder, `InvalidState` for one that isn't a repository's own top
   * folder (a subfolder, a linked worktree, a plain folder).
   */
  Rpc.make("projects.add", {
    payload: AddProjectPayload,
    success: Project,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * Clones a repository into `<into or the clone folder>/<repo>` and registers it, or registers the
   * clone already there. `InvalidState` for a remote `parseRepoRemote` refuses or a folder holding
   * something else; `GitError` when the clone fails, which leaves nothing behind.
   */
  Rpc.make("projects.clone", {
    payload: CloneProjectPayload,
    success: Project,
    error: errors(InvalidState, GitError),
  }),
  /** Repositories to offer for cloning; empty without `gh` or when GitHub can't be asked. */
  Rpc.make("projects.cloneSuggestions", { success: CloneSuggestions, error: errors() }),
  Rpc.make("projects.setBookmarked", {
    payload: SetProjectBookmarkedPayload,
    success: Project,
    error: errors(NotFound),
  }),
  /** Removes a project from `/new` recents; `InvalidState` while threads still belong to it. */
  Rpc.make("projects.forget", {
    payload: ForgetProjectPayload,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * The project's scripts from `.gram/scripts.json` in its folder, with what its `package.json`
   * and Makefile name that isn't saved yet. A file that can't be read comes back as `problem`.
   */
  Rpc.make("projects.scripts", {
    payload: { projectId: ProjectId },
    success: ProjectScripts,
    error: errors(NotFound),
  }),
  /**
   * Writes the scripts to `.gram/scripts.json`, making `.gram` if needed; `InvalidState` for a
   * script `validateScripts` refuses or a file that can't be written. Nothing here runs them.
   */
  Rpc.make("projects.saveScripts", {
    payload: SaveProjectScriptsPayload,
    success: ProjectScripts,
    error: errors(NotFound, InvalidState),
  }),
);
