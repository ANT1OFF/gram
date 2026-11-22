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
  FolderSettings,
  FolderSettingsPayload,
  ForgetProjectPayload,
  ProjectOrigins,
  ProjectOriginsPayload,
  RepositoryCandidates,
  SetProjectBookmarkedPayload,
  SetProjectFolderTrustPayload,
} from "../projects.ts";
import { ProjectScripts, SaveProjectScriptsPayload } from "../project-scripts.ts";
import { DeleteSessionPayload } from "../resume.ts";
import { SessionPreview, SessionPreviewPayload } from "../session-preview.ts";
import { PositiveInt, errors } from "./shared.ts";

/** Projects: the repositories the user works in, and the agents' past sessions in them. */
export const ProjectRpcs = RpcGroup.make(
  Rpc.make("sessions.list", {
    payload: {
      agent: AgentKind,
      projectRoot: Schema.String,
      limit: Schema.optionalKey(PositiveInt),
    },
    success: AgentSessionList,
    error: errors(NotFound, InvalidState, AgentUnavailable),
  }),
  Rpc.make("sessions.delete", {
    payload: DeleteSessionPayload,
    error: errors(NotFound, InvalidState, AgentUnavailable),
  }),
  Rpc.make("sessions.preview", {
    payload: SessionPreviewPayload,
    success: SessionPreview,
    error: errors(NotFound, InvalidState, AgentUnavailable),
  }),
  Rpc.make("projects.list", { success: Schema.Array(Project), error: errors() }),
  Rpc.make("projects.repositories", { success: RepositoryCandidates, error: errors() }),
  Rpc.make("projects.add", {
    payload: AddProjectPayload,
    success: Project,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("projects.clone", {
    payload: CloneProjectPayload,
    success: Project,
    error: errors(InvalidState, GitError),
  }),
  Rpc.make("projects.origins", {
    payload: ProjectOriginsPayload,
    success: ProjectOrigins,
    error: errors(),
  }),
  Rpc.make("projects.cloneSuggestions", { success: CloneSuggestions, error: errors() }),
  Rpc.make("projects.setBookmarked", {
    payload: SetProjectBookmarkedPayload,
    success: Project,
    error: errors(NotFound),
  }),
  Rpc.make("projects.folderSettings", {
    payload: FolderSettingsPayload,
    success: FolderSettings,
    error: errors(NotFound),
  }),
  Rpc.make("projects.setFolderTrust", {
    payload: SetProjectFolderTrustPayload,
    success: Project,
    error: errors(NotFound),
  }),
  Rpc.make("projects.forget", {
    payload: ForgetProjectPayload,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("projects.scripts", {
    payload: { projectId: ProjectId },
    success: ProjectScripts,
    error: errors(NotFound),
  }),
  Rpc.make("projects.saveScripts", {
    payload: SaveProjectScriptsPayload,
    success: ProjectScripts,
    error: errors(NotFound, InvalidState),
  }),
);
