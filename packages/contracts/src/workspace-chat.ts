// Workspaces by chat (docs/design/settings-by-chat.md#workspaces): `workspace_list`,
// `workspace_create` and `workspace_update`. Which repos a workspace reaches, its autonomy and its
// worker mode are never settings changes; these tools change them only on a card of their own that
// shows the whole workspace, which the user approves. Pure: the server reads, checks and writes.

import * as Schema from "effect/Schema";
import type { PermissionMode } from "./domain.ts";
import { SettingsChange, SettingsDiffRow } from "./settings-chat.ts";
import { Autonomy } from "./workspaces.ts";

export const WORKSPACE_LIST_TOOL = "workspace_list";
export const WORKSPACE_CREATE_TOOL = "workspace_create";
export const WORKSPACE_UPDATE_TOOL = "workspace_update";

/** The most project paths one call names. */
export const WORKSPACE_PROJECTS_MAX = 20;

/** The worker modes a workspace may be given by chat: the ones Settings offers. */
export const WorkspaceWorkerMode = Schema.Literals([
  "auto",
  "acceptEdits",
  "default",
  "bypassPermissions",
]);
export type WorkspaceWorkerMode = typeof WorkspaceWorkerMode.Type;

const ProjectPath = Schema.NonEmptyString;
const ProjectPaths = Schema.Array(ProjectPath).check(Schema.isMaxLength(WORKSPACE_PROJECTS_MAX));
const Reason = Schema.String.check(Schema.isMaxLength(500));
const Name = Schema.NonEmptyString.check(Schema.isMaxLength(100));

/** `workspace_list`'s arguments. */
export const WorkspaceListInput = Schema.Struct({
  /** One workspace, by id or name; every one the caller may see when absent. */
  workspaceId: Schema.optionalKey(Schema.String),
});

/** `workspace_create`'s arguments. */
export const WorkspaceCreateInput = Schema.Struct({
  name: Name,
  /** Absolute paths of git repositories' top folders; one Gram doesn't know yet is registered. */
  projects: ProjectPaths.check(Schema.isMinLength(1)),
  /** The project the orchestrator runs in, by path; the first project when absent. */
  home: Schema.optionalKey(ProjectPath),
  autonomy: Schema.optionalKey(Autonomy),
  workerMode: Schema.optionalKey(WorkspaceWorkerMode),
  /** Charter changes as `settings_propose` takes them, on `workspace.*` keys only. */
  settings: Schema.optionalKey(Schema.Array(SettingsChange)),
  /** Open the new workspace's orchestrator once it is made, so it can be messaged. */
  openOrchestrator: Schema.optionalKey(Schema.Boolean),
  reason: Schema.optionalKey(Reason),
});
export type WorkspaceCreateInput = typeof WorkspaceCreateInput.Type;

/** `workspace_update`'s arguments. */
export const WorkspaceUpdateInput = Schema.Struct({
  /** By id or name; an orchestrator's own when absent. */
  workspaceId: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Name),
  addProjects: Schema.optionalKey(ProjectPaths),
  /** By path or project id. */
  removeProjects: Schema.optionalKey(ProjectPaths),
  /** By path or project id; one of the projects the workspace has after the change. */
  home: Schema.optionalKey(ProjectPath),
  autonomy: Schema.optionalKey(Autonomy),
  /** `null` follows the default again: Auto, or Bypass on a harness with no Auto. */
  workerMode: Schema.optionalKey(Schema.NullOr(WorkspaceWorkerMode)),
  settings: Schema.optionalKey(Schema.Array(SettingsChange)),
  reason: Schema.optionalKey(Reason),
});
export type WorkspaceUpdateInput = typeof WorkspaceUpdateInput.Type;

/** One project on a workspace card: what happens to it, and whether Gram knows it yet. */
export const WorkspaceProposalProject = Schema.Struct({
  root: Schema.String,
  name: Schema.String,
  change: Schema.Literals(["added", "removed", "kept"]),
  /** Gram doesn't know this repository yet; approving registers it as a project. */
  unregistered: Schema.optionalKey(Schema.Boolean),
  /** The home project after the change. */
  home: Schema.optionalKey(Schema.Boolean),
});
export type WorkspaceProposalProject = typeof WorkspaceProposalProject.Type;

/** What a `workspace_create` or `workspace_update` card carries as its input. */
export const WorkspaceProposalCard = Schema.Struct({
  action: Schema.Literals(["create", "update"]),
  /** The workspace as it is named now; a new one has no id yet. */
  workspace: Schema.Struct({ id: Schema.optionalKey(Schema.String), name: Schema.String }),
  projects: Schema.Array(WorkspaceProposalProject),
  /** For a new workspace each row's `before` is `null`: the card lists what it will have. */
  rows: Schema.Array(SettingsDiffRow),
  reason: Schema.optionalKey(Schema.String),
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type WorkspaceProposalCard = typeof WorkspaceProposalCard.Type;

const AUTONOMY_TEXT = {
  supervised: "Supervised: asks before anything leaves the machine",
  publish: "Publish: pushes branches and opens PRs, asks before merging",
  full: "Full: asks about nothing, merges on its own",
} as const satisfies Record<Autonomy, string>;

/** An autonomy level as a card shows it, with what it lets agents do. */
export const autonomyText = (autonomy: Autonomy): string => AUTONOMY_TEXT[autonomy];

const WORKER_MODE_TEXT: Partial<Record<PermissionMode, string>> = {
  auto: "Auto",
  acceptEdits: "Accept edits",
  default: "Ask",
  bypassPermissions: "Bypass: workers are never asked anything",
};

/** A charter's worker mode as a card shows it; absent follows the default. */
export const workerModeText = (mode: PermissionMode | undefined): string =>
  mode === undefined
    ? "Follow the default: Auto, or Bypass on a harness with no Auto"
    : (WORKER_MODE_TEXT[mode] ?? mode);

/** The card's lead sentence: what happens, in a line. */
export const workspaceProposalSummary = (card: WorkspaceProposalCard): string => {
  if (card.action === "create") {
    const count = card.projects.length;
    return `Create the workspace “${card.workspace.name}” with ${
      count === 1 ? "1 project" : `${count} projects`
    }.`;
  }
  const count =
    card.rows.length + card.projects.filter((project) => project.change !== "kept").length;
  return `Change ${count === 1 ? "1 thing" : `${count} things`} in the workspace “${card.workspace.name}”.`;
};
