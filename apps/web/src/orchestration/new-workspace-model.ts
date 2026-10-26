import {
  newWorkspaceCharter,
  localSubscriptionDefault,
  type AgentModel,
  type OrchestratorCharter,
  type Project,
  type ProjectId,
  type Settings,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";

import type { SaveWorkspaceInput } from "@/api/types";
import { projectNameOf, toggleDraftProject } from "@/settings/workspace-settings-model";

// Pure logic behind the New workspace sheet: repositories, what it should work on, and autonomy.
// The name, models and stages wait for the workspace's settings. No React, so it is tested without
// a browser.

/** The sheet as it is filled in. */
export interface NewWorkspaceDraft {
  readonly projectIds: readonly ProjectId[];
  readonly homeProjectId: ProjectId | undefined;
  /** "What should it work on?": the orchestrator's first message, when there is one. */
  readonly task: string;
  /**
   * The charter as edited or copied. Absent while untouched, when it is `newWorkspaceCharter` of the
   * app's settings as they are now, which may still be loading.
   */
  readonly charter: OrchestratorCharter | undefined;
  /** The workspace the charter was copied from; absent means it started from the defaults. */
  readonly from: WorkspaceId | undefined;
}

export const emptyNewWorkspace: NewWorkspaceDraft = {
  projectIds: [],
  homeProjectId: undefined,
  task: "",
  charter: undefined,
  from: undefined,
};

/** The charter the draft would create the workspace with. */
export const charterOf = (
  draft: NewWorkspaceDraft,
  starting: OrchestratorCharter,
): OrchestratorCharter => draft.charter ?? starting;

/**
 * The draft with its charter copied from `source`, everything but its repos: the roster with its
 * efforts and notes, the orchestrator's model, autonomy, worker mode and the cap.
 * `undefined` goes back to the starting charter.
 */
export const startFrom = (
  draft: NewWorkspaceDraft,
  source: WorkspaceState | undefined,
): NewWorkspaceDraft =>
  source === undefined
    ? { ...draft, charter: undefined, from: undefined }
    : { ...draft, charter: source.charter, from: source.workspace.id };

/** A repo added or removed; the first one added is home until it is removed. */
export const toggleRepo = (
  draft: NewWorkspaceDraft,
  projectId: ProjectId,
  included: boolean,
): NewWorkspaceDraft => {
  const { projectIds, homeProjectId } = toggleDraftProject(
    { name: "", projectIds: draft.projectIds, homeProjectId: draft.homeProjectId },
    projectId,
    included,
  );
  return { ...draft, projectIds, homeProjectId };
};

/**
 * The name a new workspace starts with: its home repository's, numbered past any workspace that
 * has it already (`web`, `web 2`). Renaming waits for its settings.
 */
export const workspaceNameFor = (
  draft: Pick<NewWorkspaceDraft, "homeProjectId">,
  projects: readonly Project[],
  workspaces: readonly WorkspaceState[],
): string => {
  const base =
    draft.homeProjectId === undefined ? "workspace" : projectNameOf(projects, draft.homeProjectId);
  const taken = new Set(workspaces.map(({ workspace }) => workspace.name.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
};

/** What `workspace.save` is sent to create the workspace, or why it can't be yet. */
export const createInput = (
  draft: NewWorkspaceDraft,
  starting: OrchestratorCharter,
  projects: readonly Project[],
  workspaces: readonly WorkspaceState[],
): { readonly input: SaveWorkspaceInput } | { readonly error: string } => {
  const [first, ...rest] = draft.projectIds;
  if (first === undefined) return { error: "Pick at least one repository." };
  const homeProjectId =
    draft.homeProjectId !== undefined && draft.projectIds.includes(draft.homeProjectId)
      ? draft.homeProjectId
      : first;
  return {
    input: {
      name: workspaceNameFor({ homeProjectId }, projects, workspaces),
      projectIds: [first, ...rest],
      homeProjectId,
      charter: charterOf(draft, starting),
    },
  };
};

/** The orchestrator's first message, trimmed; `undefined` when the field was left empty. */
export const firstMessageOf = (draft: Pick<NewWorkspaceDraft, "task">): string | undefined => {
  const text = draft.task.trim();
  return text === "" ? undefined : text;
};

/** Honor a saved agent/model; otherwise use a discovered local CLI default, without a gateway. */
export const subscriptionWorkspaceCharter = (
  settings: Settings | undefined,
  claude: readonly AgentModel[] | undefined,
  codex: readonly AgentModel[] | undefined,
): OrchestratorCharter => {
  const selected = settings?.agents.defaultModel ?? localSubscriptionDefault(claude, codex);
  const { orchestratorModel: _default, ...starting } = newWorkspaceCharter({
    workerModels: settings?.agents.workerModels ?? [],
  });
  return {
    ...starting,
    ...(selected === undefined ? {} : { orchestratorModel: selected }),
  };
};
