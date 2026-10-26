import {
  CENSOR,
  connectorEntryProblem,
  connectorSetOf,
  MCP_TARGET_LABEL,
  type AgentConfiguredServers,
  type AgentKind,
  type Autonomy,
  type ModelRef,
  type OrchestratorCharter,
  type PermissionMode,
  type Project,
  type ProjectId,
  type WorkerModel,
  type Workspace,
} from "@gram/contracts";

import { agentLabel } from "@/agents/agent-label";
import type { SaveWorkspaceInput } from "@/api/types";
import { ADMITTED_AGENTS } from "@/orchestration/admitted";

import type { ConnectorSuggestion } from "./connector-entries";

// Pure logic behind Settings → Workspaces: the workspace form and the charter's worker cap. No
// React, so it is tested without a browser.

/** The one limit a charter carries: how many workers run at once. */
export const WORKERS_AT_ONCE = {
  label: "Workers at once",
  description: "Spawning beyond this asks you first.",
  min: 1,
  step: 1,
} as const;

/** The charter with its worker cap changed. */
export const withWorkerCap = (
  charter: OrchestratorCharter,
  value: number,
): OrchestratorCharter => ({
  ...charter,
  maxConcurrentWorkers: value,
});

/** One autonomy level as Settings offers it, in plain words. */
export interface AutonomyLevel {
  readonly value: Autonomy;
  readonly label: string;
  /** What agents may do unasked at this level, in one line; also the chip's tooltip. */
  readonly description: string;
  /** The rest of what the level allows, behind "Learn more". */
  readonly detail: string;
  /** Nothing in Gram asks at this level, so it is shown as a warning and confirmed first. */
  readonly warn: boolean;
}

/** The levels from the most asked to the least, which is the order the selector shows them in. */
export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  {
    value: "supervised",
    label: "Supervised",
    description: "Asks before anything leaves your machine: a push, a pull request, a merge.",
    detail: "Edits and commands inside a worktree follow the worker mode.",
    warn: false,
  },
  {
    value: "publish",
    label: "Publish",
    description: "Pushes branches and opens pull requests. Asks before merging or releasing.",
    detail:
      "Still asks before merging or closing a pull request, a release, a workflow run, or a force or deleting push.",
    warn: false,
  },
  {
    value: "full",
    label: "Full",
    description: "Asks about nothing. Branch protection outside Gram is the only gate.",
    detail:
      "The orchestrator may turn on auto-merge and answer its workers' questions. What stands between an agent and your repositories is what you have outside Gram: branch protection, required reviews and your provider's spending limits.",
    warn: true,
  },
];

export const autonomyLevel = (value: Autonomy): AutonomyLevel =>
  AUTONOMY_LEVELS.find((level) => level.value === value) ?? AUTONOMY_LEVELS[1]!;

/**
 * A level's words for a chip. One this build doesn't know reads as its own word: `autonomyLevel`'s
 * fallback would call it Publish, and a chip is where a level the server added would first show.
 */
export const presentAutonomy = (value: string): Omit<AutonomyLevel, "value"> =>
  AUTONOMY_LEVELS.find((level) => level.value === value) ?? {
    label: value,
    description: "This version of Gram doesn't know this level.",
    detail: "",
    warn: false,
  };

/** The charter at another level; always written out, so a picked default survives a changed default. */
export const withAutonomy = (
  charter: OrchestratorCharter,
  autonomy: Autonomy,
): OrchestratorCharter => ({ ...charter, autonomy });

/** Only the step up to `full` is confirmed: every other change asks more, or can be taken back. */
export const autonomyNeedsConfirm = (current: Autonomy, next: Autonomy): boolean =>
  next === "full" && current !== "full";

/**
 * What to know about the prompt that still asks at this level: it is an accident gate, not a
 * security boundary. A line to show, and the why behind it. `undefined` at `full`, where nothing
 * asks and so there is no gate to qualify.
 */
export const gateNote = (autonomy: Autonomy): { line: string; detail: string } | undefined => {
  if (autonomy === "full") return undefined;
  const commands =
    autonomy === "supervised"
      ? "git push, gh pr create, gh pr merge"
      : "gh pr merge, gh release create, git push --force";
  return {
    line: "That prompt is an accident gate, not a security boundary.",
    detail: `It catches the ordinary commands (${commands}), and everything else runs under your own permission rules. If those allow the shell broadly, nothing stops a prompt-injected worker from doing the same by another route.`,
  };
};

/** The charter with its worker models replaced; an empty list is no list, which allows the orchestrator's own model only. */
export const withWorkerModels = (
  charter: OrchestratorCharter,
  models: readonly WorkerModel[],
): OrchestratorCharter => {
  const { workerModels: _was, ...rest } = charter;
  return models.length === 0 ? rest : { ...rest, workerModels: models };
};

/** Two entries are the same model when a spawn couldn't tell them apart. */
export const sameModelRef = (a: ModelRef, b: ModelRef): boolean =>
  a.agent === b.agent &&
  a.model === b.model &&
  a.profileId === b.profileId &&
  a.variant === b.variant &&
  a.speed === b.speed;

/** `models` with `model` added, unless it is there already. */
export const addWorkerModel = (
  models: readonly WorkerModel[],
  model: WorkerModel,
): readonly WorkerModel[] =>
  models.some((each) => sameModelRef(each, model)) ? models : [...models, model];

/** A worker model with `note` as what it is for; a blank note is no note. */
export const withUseFor = (model: WorkerModel, note: string): WorkerModel => {
  const { useFor: _was, ...rest } = model;
  const trimmed = note.trim();
  return trimmed === "" ? rest : { ...rest, useFor: trimmed };
};

/** The roster with entry `index`'s note replaced. */
export const withWorkerNote = (
  models: readonly WorkerModel[],
  index: number,
  note: string,
): readonly WorkerModel[] =>
  models.map((model, i) => (i === index ? withUseFor(model, note) : model));

/**
 * The roster with entry `index` as the one a worker gets when the orchestrator names none, and no
 * other; marking the default again unmarks it, leaving the orchestrator's own model as the fallback.
 */
export const withDefaultWorker = (
  models: readonly WorkerModel[],
  index: number,
): readonly WorkerModel[] => {
  const unmark = models[index]?.default === true;
  return models.map((model, i) => {
    const { default: _was, ...rest } = model;
    return i === index && !unmark ? { ...rest, default: true } : rest;
  });
};

/** The index of the entry a worker gets by default, as the server reads it: the first marked. */
export const defaultWorkerIndex = (models: readonly WorkerModel[]): number | undefined => {
  const index = models.findIndex((model) => model.default === true);
  return index === -1 ? undefined : index;
};

/** The charter with an orchestrator model of its own, or following the default model again. */
export const withOrchestratorModel = (
  charter: OrchestratorCharter,
  model: ModelRef | undefined,
): OrchestratorCharter => {
  const { orchestratorModel: _was, ...rest } = charter;
  return model === undefined ? rest : { ...rest, orchestratorModel: model };
};

/** The charter with `text` as its worker brief footer; blank text is no footer. */
export const withWorkerBriefFooter = (
  charter: OrchestratorCharter,
  text: string,
): OrchestratorCharter => {
  const { workerBriefFooter: _was, ...rest } = charter;
  const trimmed = text.trim();
  return trimmed === "" ? rest : { ...rest, workerBriefFooter: trimmed };
};

/** The charter offering another worker model at a limit, or not; off is stored as absent. */
export const withRouteAtLimit = (
  charter: OrchestratorCharter,
  on: boolean,
): OrchestratorCharter => {
  const { routeAtLimit: _was, ...rest } = charter;
  return on ? { ...rest, routeAtLimit: true } : rest;
};

/** How a charter's connector set reads in the selector: none, an allowlist, or a denylist. */
export type ConnectorMode = "all" | "allow" | "deny";

/** The connector set's choices, from the widest to the narrowest. */
export const CONNECTOR_MODES: readonly { readonly value: ConnectorMode; readonly label: string }[] =
  [
    { value: "all", label: "Every connector" },
    { value: "deny", label: "All but these" },
    { value: "allow", label: "Only these" },
  ];

/** The selector's choice for `charter`, and the entries it lists. */
export const connectorChoice = (
  charter: OrchestratorCharter,
): { readonly mode: ConnectorMode; readonly entries: readonly string[] } => {
  const set = connectorSetOf(charter);
  if (set === undefined) return { mode: "all", entries: [] };
  return "allow" in set
    ? { mode: "allow", entries: set.allow }
    : { mode: "deny", entries: set.deny };
};

/**
 * The charter with its connector set made `mode` over `entries`: `all` drops the set, so nothing
 * is narrowed. Switching between the lists keeps what was listed, for the user to edit.
 */
export const withConnectors = (
  charter: OrchestratorCharter,
  mode: ConnectorMode,
  entries: readonly string[],
): OrchestratorCharter => {
  const { connectors: _was, ...rest } = charter;
  if (mode === "all") return rest;
  return {
    ...rest,
    connectors: mode === "allow" ? { allow: [...entries] } : { deny: [...entries] },
  };
};

/**
 * What the connector picker offers, from Settings → Connectors' read: each agent's servers by
 * name, and a claude.ai connector by its address, the only way Claude Code matches one, once the
 * read knows it. One without an address isn't offered; it can still be typed.
 */
export const connectorSuggestions = (
  agents: readonly AgentConfiguredServers[],
): readonly ConnectorSuggestion[] => {
  const byEntry = new Map<string, Set<string>>();
  for (const { target, servers } of agents) {
    for (const server of servers) {
      const entry = server.scope === "claudeai" ? server.url : server.name;
      // A shown address may come masked: a query value or a token in its path replaced, which
      // matches no server. An entry with a query is refused anyway; such a one can still be typed.
      if (
        entry === undefined ||
        entry.includes("•") ||
        entry.includes(CENSOR) ||
        connectorEntryProblem(entry) !== undefined
      ) {
        continue;
      }
      const labels = byEntry.get(entry) ?? new Set<string>();
      labels.add(server.scope === "claudeai" ? server.name : MCP_TARGET_LABEL[target]);
      byEntry.set(entry, labels);
    }
  }
  return [...byEntry]
    .map(([entry, labels]) => ({ entry, label: [...labels].join(", ") }))
    .toSorted((a, b) => a.entry.localeCompare(b.entry));
};

/** The worker mode choice for "no mode of its own", which a workspace made before modes had. */
export const FOLLOW_DEFAULT_MODE = "follow";

export type WorkerModeChoice = PermissionMode | typeof FOLLOW_DEFAULT_MODE;

/** The modes a charter may hold workers to, each said in one line, the wizard's and Settings' alike. */
export const WORKER_MODE_CHOICES: readonly {
  readonly value: PermissionMode;
  readonly label: string;
  readonly line: string;
}[] = [
  {
    value: "auto",
    label: "Auto",
    line: "Workers edit and run commands on their own; risky steps are checked first.",
  },
  {
    value: "acceptEdits",
    label: "Accept edits",
    line: "Workers edit files freely and ask before running a command.",
  },
  {
    value: "default",
    label: "Ask",
    line: "Workers ask before each edit and command. Slow with several at once.",
  },
  {
    value: "bypassPermissions",
    label: "Bypass",
    line: "Workers are never asked anything. Only for repos where that is safe.",
  },
];

/** What a workspace without a mode of its own does, offered only while it is that. */
export const FOLLOW_DEFAULT_CHOICE = {
  value: FOLLOW_DEFAULT_MODE,
  label: "Follow the default",
  line: "Auto, or Bypass on a harness with no Auto.",
} as const;

/** A mode's name for a summary line. */
export const workerModeLabel = (mode: PermissionMode | undefined): string =>
  WORKER_MODE_CHOICES.find((choice) => choice.value === mode)?.label ?? FOLLOW_DEFAULT_CHOICE.label;

/** The charter with workers held to `mode`, or following the default rule again. */
export const withWorkerMode = (
  charter: OrchestratorCharter,
  mode: WorkerModeChoice,
): OrchestratorCharter => {
  const { workerMode: _was, ...rest } = charter;
  return mode === FOLLOW_DEFAULT_MODE ? rest : { ...rest, workerMode: mode };
};

/** Something about one worker model the server will refuse at spawn; saving it is still allowed. */
export interface WorkerModelIssue {
  /** Index into `charter.workerModels`. */
  readonly index: number;
  readonly message: string;
  /**
   * The entry can't run here at all, so the orchestrator's spawns on it get the default instead
   * (the server's `workerModelUnavailable`), and where to fix it.
   */
  readonly unavailable?: { readonly fix: "gateways" | "workspaces" | "agents" } | undefined;
}

/** What `workerModelIssues` checks the entries against, each part once it has been listed. */
export interface WorkerModelContext {
  /** The gateway profiles there are, with whether each has a key and the models it lists. */
  readonly profiles?:
    | readonly {
        readonly id: string;
        readonly keyRef: string;
        readonly models?: readonly { readonly id: string }[] | undefined;
      }[]
    | undefined;
  /** The user's custom model ids per agent, which every list of that agent offers too. */
  readonly customModels?: Partial<Record<AgentKind, readonly string[]>> | undefined;
  /**
   * The models Codex offers on its own login, with no gateway profile; `null` for
   * one that couldn't list any. An agent left out hasn't answered yet.
   */
  readonly ownModels?: Partial<Record<AgentKind, readonly string[] | null>> | undefined;
}

/** Local entries use the local CLI; only an explicit profile uses a gateway. Warn without blocking saves. */
export const workerModelIssues = (
  charter: Pick<OrchestratorCharter, "workerModels" | "autonomy">,
  context: WorkerModelContext = {},
): readonly WorkerModelIssue[] => {
  const { profiles, ownModels } = context;
  const lists = (
    profile: NonNullable<WorkerModelContext["profiles"]>[number],
    model: WorkerModel,
  ): boolean =>
    (profile.models ?? []).some((each) => each.id === model.model) ||
    (context.customModels?.[model.agent] ?? []).includes(model.model);
  return (charter.workerModels ?? []).flatMap((model, index): WorkerModelIssue[] => {
    if (!ADMITTED_AGENTS.includes(model.agent)) {
      return [{ index, message: "This agent can't run as a worker, so a spawn on it is refused." }];
    }
    const name = agentLabel(model.agent);
    if (model.profileId !== undefined && profiles !== undefined) {
      const profile = profiles.find((each) => each.id === model.profileId);
      if (profile === undefined) {
        return [
          {
            index,
            message:
              "Unavailable: the gateway profile it ran on is gone, so a spawn on it gets the default. Remove it and add it again on a profile that exists.",
            unavailable: { fix: "workspaces" },
          },
        ];
      }
      if (profile.keyRef === "") {
        return [
          {
            index,
            message:
              "Unavailable until its gateway profile has a key; a spawn on it gets the default.",
            unavailable: { fix: "gateways" },
          },
        ];
      }
      // A profile whose models were never fetched lists none, which says nothing against it.
      if ((profile.models ?? []).length > 0 && !lists(profile, model)) {
        return [
          {
            index,
            message: `Unavailable: its gateway profile doesn't offer ${model.model}, so a spawn on it gets the default. Remove it and add it again on a profile that does.`,
            unavailable: { fix: "workspaces" },
          },
        ];
      }
    }
    if (model.profileId === undefined) {
      const own = ownModels?.[model.agent];
      if (own === null || (own !== undefined && !own.includes(model.model))) {
        return [
          {
            index,
            message:
              own === null
                ? `Unavailable: ${name} couldn't list local models, so a spawn on it gets the default.`
                : `Unavailable: ${name} does not list ${model.model} on your local account. Choose a listed model in Settings → Workspaces; a spawn on it gets the default.`,
            unavailable: { fix: own === null ? "agents" : "workspaces" },
          },
        ];
      }
    }
    return [];
  });
};

/**
 * Whether a roster is what new workspaces start with: the same models, profiles, efforts, notes
 * and default, in the same order. A profile is compared exactly, since one the user picked is the
 * only one ever stored and a new workspace should get that one, not whichever gateway binds.
 */
export const sameRoster = (
  models: readonly WorkerModel[] | undefined,
  template: readonly WorkerModel[],
): boolean => {
  const roster = models ?? [];
  return (
    roster.length === template.length &&
    roster.every((model, i) => {
      const other = template[i]!;
      return (
        sameModelRef(model, other) &&
        (model.useFor ?? "") === (other.useFor ?? "") &&
        (model.default === true) === (other.default === true)
      );
    })
  );
};

/**
 * How a harness differs from Claude in an orchestration role, as the server holds it.
 * Shown only while that harness is relevant, so a Claude-only user reads
 * none of it.
 */
const HARNESS_NOTES: Partial<Record<AgentKind, readonly string[]>> = {
  codex: [
    "Uses your local Codex login without a gateway. Supervised and Publish use Gram's own approval home, linked to your CLI login. Preparation must succeed before a gated session starts; existing sessions in your own CLI home need a fresh gated session.",
    "Starts in Bypass, because Codex has no Auto; the outward gate still asks.",
    "Known gap: a command typed into an interactive shell Codex opened is not asked about.",
    "After you change autonomy, a running Codex thread's prompt keeps describing the old level until its next fresh session; what it is actually asked about changes at once.",
    "Codex reports tokens, not cost.",
  ],
};

/** How a dream is held on each harness; shown with the harness notes and where a dream's model is picked. */
export const DREAM_HARNESS_NOTE =
  "Dream uses bounded file tools on Claude: snapshot inputs are read-only, and only candidate output and notes are writable. This requires macOS or Linux with /usr/bin/python3 for directory-handle confinement. Claude native commands, network and subagents are disabled. Codex Dream starts with normal Codex permissions: workspace-write sandbox and on-request approvals. Instructions guide snapshot reads and candidate writes, but native tools can access other permitted files. Review and Adopt apply candidates through Gram.";

/** Said under the list whatever is in it. */
export const HARNESS_GENERAL_NOTE =
  "Orchestrators, workers and dreams can run on Claude Code or Codex where the harness supports the role.";

/**
 * The harnesses worth explaining, each once: those in the worker models, then the kind of the
 * user's default model, which is what an orchestrator or a worker runs on when nothing says otherwise.
 */
export const harnessNotes = (
  models: readonly ModelRef[],
  defaultAgent?: AgentKind | undefined,
): readonly { readonly agent: AgentKind; readonly notes: readonly string[] }[] =>
  [
    ...new Set([
      ...models.map((model) => model.agent),
      ...(defaultAgent === undefined ? [] : [defaultAgent]),
    ]),
  ].flatMap((agent) => {
    const notes = HARNESS_NOTES[agent];
    return notes === undefined ? [] : [{ agent, notes }];
  });

/** The workspace form as it is typed. */
export interface WorkspaceDraft {
  readonly name: string;
  readonly projectIds: readonly ProjectId[];
  readonly homeProjectId: ProjectId | undefined;
}

export const emptyWorkspaceDraft: WorkspaceDraft = {
  name: "",
  projectIds: [],
  homeProjectId: undefined,
};

export const draftOfWorkspace = (workspace: Workspace): WorkspaceDraft => ({
  name: workspace.name,
  projectIds: workspace.projectIds,
  homeProjectId: workspace.homeProjectId,
});

/**
 * A project ticked or unticked. The home project follows: the first project ticked becomes it, and
 * unticking it hands the role to the first that is left.
 */
export const toggleDraftProject = (
  draft: WorkspaceDraft,
  projectId: ProjectId,
  included: boolean,
): WorkspaceDraft => {
  const projectIds = included
    ? draft.projectIds.includes(projectId)
      ? draft.projectIds
      : [...draft.projectIds, projectId]
    : draft.projectIds.filter((id) => id !== projectId);
  const homeProjectId =
    draft.homeProjectId !== undefined && projectIds.includes(draft.homeProjectId)
      ? draft.homeProjectId
      : projectIds[0];
  return { ...draft, projectIds, homeProjectId };
};

/** What to save, or the sentence saying why the draft can't be. */
export const validateWorkspaceDraft = (
  draft: WorkspaceDraft,
  id?: Workspace["id"] | undefined,
): { readonly input: SaveWorkspaceInput } | { readonly error: string } => {
  const name = draft.name.trim();
  if (name === "") return { error: "Give the workspace a name." };
  const [first, ...rest] = draft.projectIds;
  if (first === undefined) return { error: "Pick at least one repository." };
  const homeProjectId = draft.homeProjectId;
  if (homeProjectId === undefined || !draft.projectIds.includes(homeProjectId)) {
    return { error: "The home repository must be one of the workspace's repositories." };
  }
  return {
    input: {
      ...(id === undefined ? {} : { id }),
      name,
      projectIds: [first, ...rest],
      homeProjectId,
    },
  };
};

/** The workspace with one more repo, as `saveWorkspace` takes it; one it already has changes nothing. */
export const withWorkspaceRepo = (
  workspace: Workspace,
  projectId: ProjectId,
): SaveWorkspaceInput => ({
  id: workspace.id,
  name: workspace.name,
  projectIds: workspace.projectIds.includes(projectId)
    ? workspace.projectIds
    : [...workspace.projectIds, projectId],
  homeProjectId: workspace.homeProjectId,
});

/**
 * The workspace without a repo, the project and its threads left as they are. The home project
 * stays: the orchestrator runs in it, so another has to become home first.
 */
export const withoutWorkspaceRepo = (
  workspace: Workspace,
  projectId: ProjectId,
): { readonly input: SaveWorkspaceInput } | { readonly error: string } => {
  if (projectId === workspace.homeProjectId) {
    return { error: "The home repository stays. Make another one home first." };
  }
  const [first, ...rest] = workspace.projectIds.filter((id) => id !== projectId);
  if (first === undefined) return { error: "A workspace keeps at least one repository." };
  return {
    input: {
      id: workspace.id,
      name: workspace.name,
      projectIds: [first, ...rest],
      homeProjectId: workspace.homeProjectId,
    },
  };
};

/** The repos a workspace can let go of: every one but its home project. */
export const removableRepos = (workspace: Workspace): readonly ProjectId[] =>
  workspace.projectIds.filter((id) => id !== workspace.homeProjectId);

/** A project's name for the list, falling back to its id once the project has been removed. */
export const projectNameOf = (projects: readonly Project[], projectId: ProjectId): string =>
  projects.find((project) => project.id === projectId)?.name ?? projectId;
