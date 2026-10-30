// Workspaces and the orchestrator's charter. Apart from
// `orchestration.ts` because the charter names `PermissionMode` and `ModelRef`, and `domain.ts`
// imports that file.

import * as Schema from "effect/Schema";
import { DraftId } from "./attachments.ts";
import { ModelRef, PermissionMode, UserInput } from "./domain.ts";
import { SupportedTaskModelSelection } from "./task-preflight.ts";
import { ProjectId, ThreadId, WorkspaceId } from "./ids.ts";
import { MergeReviewPolicy, RepoMergeReviewPolicies } from "./merge-policy.ts";
import { FeatureStage, OrchestrationPause } from "./orchestration.ts";

/** A named set of projects one orchestrator works across. */
export const Workspace = Schema.Struct({
  id: WorkspaceId,
  name: Schema.String,
  projectIds: Schema.NonEmptyArray(ProjectId),
  /** The project the orchestrator's own session runs in; one of `projectIds`. */
  homeProjectId: ProjectId,
  /** The slot: the one thread allowed to orchestrate here. Absent while nobody holds it. */
  orchestratorThreadId: Schema.optionalKey(ThreadId),
  /** Epoch ms. */
  createdAt: Schema.Number,
});
export type Workspace = typeof Workspace.Type;

/** A project-derived name, with a numbered suffix when another workspace already uses it. */
export const availableWorkspaceName = (projectName: string, names: readonly string[]): string => {
  const base = projectName.trim() || "Workspace";
  const taken = new Set(names.map((name) => name.trim().toLowerCase()));
  let name = base;
  for (let suffix = 2; taken.has(name.toLowerCase()); suffix++) name = `${base} (${suffix})`;
  return name;
};

const AtLeastOne = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** The longest `useFor` note a worker model may carry; it goes into the orchestrator's context. */
export const WORKER_MODEL_NOTE_MAX = 300;

/**
 * A model a worker may be spawned on, with what the user wants it used for. A bare `ModelRef` is
 * one too, allowed with no note.
 */
export const WorkerModel = Schema.Struct({
  ...ModelRef.fields,
  /** The kind of work the user wants on this model, in their words; the orchestrator picks by it. */
  useFor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WORKER_MODEL_NOTE_MAX))),
  /** A worker gets this model when the orchestrator names none; the first entry marked wins. */
  default: Schema.optionalKey(Schema.Boolean),
});
export type WorkerModel = typeof WorkerModel.Type;

/** The model a worker model runs on, without the user's note about it. */
export const modelRefOf = ({
  useFor: _useFor,
  default: _default,
  ...model
}: WorkerModel): ModelRef => model;

/**
 * How far an orchestrator and its workers go without asking. `supervised` asks before anything
 * leaves the machine: a push, a PR, a merge. `publish` lets them push branches and open PRs, and
 * asks before what can't be taken back: merging or closing a PR, a release, a workflow run.
 * `full` asks about nothing, and lets the orchestrator merge and answer its workers' questions.
 */
export const Autonomy = Schema.Literals(["supervised", "publish", "full"]);
export type Autonomy = typeof Autonomy.Type;

/**
 * The level a charter without one works at: a workspace made before new ones started at `full`
 * (`DEFAULT_CHARTER`) never wrote its level down, and keeps the one it had.
 */
export const DEFAULT_AUTONOMY: Autonomy = "publish";

/**
 * Why a connector entry can't be kept, or `undefined`: an entry is an MCP server's name, or a URL
 * pattern (an entry with `://`, where `*` matches anything), which is how a claude.ai connector is
 * matched. Settings and charters reach sync and the diagnostics report, so a URL may name a
 * server's address and nothing more: userinfo, a query or a fragment could carry a credential, and
 * none is needed to match a connector.
 */
export const connectorEntryProblem = (entry: string): string | undefined => {
  const trimmed = entry.trim();
  if (trimmed === "") return "Name a connector.";
  if (trimmed.length > 300) return "That is too long for a connector's name or address.";
  if (!trimmed.includes("://")) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\/[^\s/@?#]+(?:\/[^\s?#]*)?$/i.test(trimmed)
    ? undefined
    : "Give the connector's address alone, without a user name, query or fragment: nothing there is needed to match it, and settings aren't a place for credentials.";
};

/**
 * The connectors and MCP servers a workspace's threads get beside Gram's own: only those
 * matching `allow`, or all but those matching `deny`, each entry as `connectorEntryProblem` takes
 * it. Stored as plain strings so a charter with an entry today's rules refuse still loads; read it
 * through `connectorSetOf`, which drops those.
 */
export const ConnectorSet = Schema.Union([
  Schema.Struct({ allow: Schema.Array(Schema.String) }),
  Schema.Struct({ deny: Schema.Array(Schema.String) }),
]);
export type ConnectorSet = typeof ConnectorSet.Type;

/** Entries trimmed, once each, without those `connectorEntryProblem` refuses. */
const keptEntries = (entries: ReadonlyArray<string>): Array<string> => [
  ...new Set(
    entries
      .map((entry) => entry.trim())
      .filter((entry) => connectorEntryProblem(entry) === undefined),
  ),
];

/** A charter's connector set, trimmed and without entries that can't be kept; absent gives all. */
export const connectorSetOf = (
  charter: Pick<OrchestratorCharter, "connectors">,
): ConnectorSet | undefined => {
  const set = charter.connectors;
  if (set === undefined) return undefined;
  return "allow" in set ? { allow: keptEntries(set.allow) } : { deny: keptEntries(set.deny) };
};

/** A connector entry's URL pattern as one expression: `*` matches anything, all else is literal. */
const urlPattern = (entry: string): RegExp =>
  new RegExp(
    `^${entry
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );

/** An MCP server as a connector entry matches it: by its name, or by the URL it is reached at. */
export interface ConnectorIdentity {
  readonly name: string;
  readonly url?: string | undefined;
}

/**
 * Whether one of `entries` names `server`, as Claude Code matches `allowedMcpServers`: an entry
 * with `://` by the server's URL, any other by its name.
 */
export const connectorListed = (
  entries: ReadonlyArray<string>,
  server: ConnectorIdentity,
): boolean =>
  entries.some((entry) =>
    entry.includes("://")
      ? server.url !== undefined && urlPattern(entry).test(server.url)
      : entry === server.name,
  );

/** Whether `set` leaves `server` out of a session; nothing is left out without a set. */
export const leftOutBy = (set: ConnectorSet | undefined, server: ConnectorIdentity): boolean =>
  set === undefined
    ? false
    : "allow" in set
      ? !connectorListed(set.allow, server)
      : connectorListed(set.deny, server);

/** Whether `list` lets `entry` through: the same entry, or a pattern matching a plain address. */
export const coveredBy = (list: ReadonlyArray<string>, entry: string): boolean =>
  list.includes(entry) ||
  (entry.includes("://") &&
    !entry.includes("*") &&
    connectorListed(list, { name: "", url: entry }));

/**
 * The entries of two allowlists that each lets through, for a session held to both: an entry of
 * one is kept when the other names it, by the same name, or by a URL pattern that matches it. An
 * entry only a pattern of both would let through is dropped, so the result never lets in what
 * either list keeps out.
 */
export const narrowAllowlist = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  ...new Set([...a.filter((entry) => coveredBy(b, entry)), ...b.filter((e) => coveredBy(a, e))]),
];

/**
 * What the user lets an orchestrator do. The one limit is how many workers run at once: what an
 * orchestrator spends, and for how long, is bounded by the user's provider, not by Gram.
 */
export const AutomaticDreamThreshold = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 1000 }),
);

/** The share of a subscription limit, as a whole percent, at which new workers pause. */
export const PauseAtLimitPct = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

/** The longest worker brief footer a workspace may keep; it goes into every brief and the charter. */
export const WORKER_BRIEF_FOOTER_MAX = 4000;

export const WorkerBriefFooter = Schema.String.check(Schema.isMaxLength(WORKER_BRIEF_FOOTER_MAX));

/** The thread kinds of a workspace that idle compaction may compact. */
export const IdleCompactKind = Schema.Literals(["orchestrator", "worker"]);
export type IdleCompactKind = typeof IdleCompactKind.Type;

export const OrchestratorCharter = Schema.Struct({
  /** Absent disables automatic launch. Every edit starts a fresh completion count. */
  automaticDreamThreshold: Schema.optionalKey(AutomaticDreamThreshold),
  /** Spawning beyond this asks the user first. */
  maxConcurrentWorkers: AtLeastOne,
  /**
   * When a subscription limit a new worker would run against reaches this share, `spawn_worker`
   * asks the user once whether to pause new workers until it resets. Absent never pauses.
   */
  pauseAtLimitPct: Schema.optionalKey(PauseAtLimitPct),
  /** Absent means `DEFAULT_AUTONOMY`; read it through `autonomyOf`. */
  autonomy: Schema.optionalKey(Autonomy),
  /** The mode workers start in; absent follows `orchestrationMode`. */
  workerMode: Schema.optionalKey(PermissionMode),
  /** The models a worker may be spawned on, the roster; absent allows the orchestrator's own only. */
  workerModels: Schema.optionalKey(Schema.Array(WorkerModel)),
  /** The model a new orchestrator opens on; absent follows `agents.defaultModel`. */
  orchestratorModel: Schema.optionalKey(ModelRef),
  /**
   * The connectors every thread of the workspace gets, its orchestrator and workers alike; absent
   * gives each what its agent is configured with. Read it through `connectorSetOf`.
   */
  connectors: Schema.optionalKey(ConnectorSet),
  /** Absent in migrated workspaces keeps the bot approval gate. */
  mergeReviewPolicy: Schema.optionalKey(MergeReviewPolicy),
  /** Advisory overlap exclusions: exact repo-relative paths, or basenames at any depth.
   * Absent uses lockfiles only; an empty array disables exclusions. */
  overlapIgnorePaths: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** Exact owner/repo overrides, confined to this workspace. */
  repoMergeReviewPolicies: Schema.optionalKey(RepoMergeReviewPolicies),
  /**
   * The user's standing instructions for this workspace's workers, which Gram appends to every
   * worker brief spawned here under a line saying whose they are. Absent or blank appends nothing;
   * read it through `briefFooterOf`.
   */
  workerBriefFooter: Schema.optionalKey(WorkerBriefFooter),
  /**
   * When a subscription limit stops a spawn (its account is at its limit, or the limit gates hold
   * or refuse it) and another worker model of the roster is clear of it, `spawn_worker` offers the
   * orchestrator those models with their notes. Never a silent swap. Absent is off.
   */
  routeAtLimit: Schema.optionalKey(Schema.Boolean),
  /**
   * Compact a large idle thread's context just before its prompt cache expires, so the next wake
   * starts from a summary rather than rewriting the whole conversation. Absent is on, by the user's
   * decision; read it through `idleCompactOf`.
   */
  idleAutoCompact: Schema.optionalKey(Schema.Boolean),
  /** The thread kinds it covers; absent is the orchestrator only. Read through `idleCompactOf`. */
  idleAutoCompactKinds: Schema.optionalKey(Schema.Array(IdleCompactKind)),
});
export type OrchestratorCharter = typeof OrchestratorCharter.Type;

/** The workspace's worker brief footer, trimmed; `undefined` when there is none. */
export const briefFooterOf = (
  charter: Pick<OrchestratorCharter, "workerBriefFooter">,
): string | undefined => {
  const footer = charter.workerBriefFooter?.trim();
  return footer === undefined || footer === "" ? undefined : footer;
};

/** Idle compaction as a workspace has it: on for its orchestrator unless the user says otherwise. */
export const idleCompactOf = (
  charter: Pick<OrchestratorCharter, "idleAutoCompact" | "idleAutoCompactKinds"> | undefined,
): { readonly enabled: boolean; readonly kinds: ReadonlyArray<IdleCompactKind> } => ({
  enabled: charter?.idleAutoCompact ?? true,
  kinds: charter?.idleAutoCompactKinds ?? ["orchestrator"],
});
/**
 * The charter's limits for a new workspace: nothing asks, and branch protection is what stands. A
 * new workspace's charter is this plus its models, from `newWorkspaceCharter`.
 */
export const DEFAULT_CHARTER: OrchestratorCharter = {
  maxConcurrentWorkers: 10,
  mergeReviewPolicy: "automatic",
  autonomy: "full",
};

/** What a new workspace's orchestrator runs on until the user saves another: Claude's Opus, high effort. */
export const DEFAULT_ORCHESTRATOR_MODEL: ModelRef = {
  speed: "standard",
  agent: "claude",
  model: "opus",
  variant: "high",
};

/** What a new workspace's roster starts as: the app's saved one, else none. */
export interface NewWorkspaceModels {
  /** `agents.workerModels`; absent or empty, workers run on the orchestrator's model. */
  readonly workerModels?: ReadonlyArray<WorkerModel> | undefined;
}

/**
 * The charter a new workspace is made with: `DEFAULT_CHARTER`, workers in Auto (Bypass on a
 * harness with no Auto), the orchestrator model and the roster. Only a profile the user picked is
 * ever stored on an entry: a Codex entry with none is put on a gateway that can run it
 * each time the server reads the roster (`bindGateway`), so one made usable later takes it up.
 */
export const newWorkspaceCharter = (saved: NewWorkspaceModels): OrchestratorCharter => {
  const roster = saved.workerModels ?? [];
  return {
    ...DEFAULT_CHARTER,
    workerMode: "auto",
    orchestratorModel: DEFAULT_ORCHESTRATOR_MODEL,
    ...(roster.length === 0 ? {} : { workerModels: roster }),
  };
};

/** The autonomy a charter grants, with the default for one that doesn't say. */
export const autonomyOf = (charter: Pick<OrchestratorCharter, "autonomy">): Autonomy =>
  charter.autonomy ?? DEFAULT_AUTONOMY;

/** A group of features as it is stored: its members, and the stage somebody set for the whole. */
export const FeatureGroup = Schema.Struct({
  features: Schema.Array(Schema.String),
  stage: Schema.optionalKey(FeatureStage),
});
export type FeatureGroup = typeof FeatureGroup.Type;

/** A workspace with its charter and pause, as it is stored and listed. */
export const WorkspaceState = Schema.Struct({
  workspace: Workspace,
  charter: OrchestratorCharter,
  /** Each feature's stage by its slug; a feature nobody has staged has no entry. */
  stages: Schema.optionalKey(Schema.Record(Schema.String, FeatureStage)),
  /** Features run as one effort, by the group's slug, each with the stage of the whole. */
  groups: Schema.optionalKey(Schema.Record(Schema.String, FeatureGroup)),
  paused: Schema.optionalKey(OrchestrationPause),
  /**
   * Features the user paused, by slug, in the order they were paused: the orchestrator isn't woken
   * for their workers, doesn't message them and spawns none for them until the user resumes.
   */
  pausedFeatures: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type WorkspaceState = typeof WorkspaceState.Type;

/** A workspace, or a project whose one-project workspace is made the first time it is named. */
export const TaskTarget = Schema.Union([
  Schema.Struct({ workspaceId: WorkspaceId }),
  Schema.Struct({ projectId: ProjectId }),
]);
export type TaskTarget = typeof TaskTarget.Type;

/**
 * A workspace a thread can join as a worker of its orchestrator, with
 * the names of the thread's repos joining it would add, which the user's click consents to.
 */
export const JoinTarget = Schema.Struct({
  workspaceId: WorkspaceId,
  name: Schema.String,
  adds: Schema.Array(Schema.String),
});
export type JoinTarget = typeof JoinTarget.Type;

/** ⌘N's New task: what the user wants done, for a workspace's orchestrator or one new worker. */
export const StartTaskInput = Schema.Struct({
  target: TaskTarget,
  input: UserInput,
  /** The draft `input`'s attachments were staged under, as `thread.create` takes it. */
  draftId: Schema.optionalKey(DraftId),
  /**
   * Straight to a worker: one starts now in a new worktree of this project, one of the target's,
   * with `input` as its brief, instead of the orchestrator reading it first.
   */
  direct: Schema.optionalKey(
    Schema.Struct({
      projectId: ProjectId,
      base: Schema.optionalKey(Schema.String),
      /**
       * The worker's model as the user picked it from the preview's `workerChoices`; absent is the
       * roster's default. One no longer on the roster, or unavailable here, is refused.
       */
      worker: Schema.optionalKey(ModelRef),
    }),
  ),
  /**
   * The autonomy a workspace made for a `projectId` target starts at, the user's pick on the draft;
   * absent is `DEFAULT_CHARTER`'s. A workspace that already exists keeps its own.
   */
  autonomy: Schema.optionalKey(Autonomy),
  /** Models shown by task preflight. A changed selection refuses rather than silently switching. */
  selection: Schema.optionalKey(SupportedTaskModelSelection),
});
export type StartTaskInput = typeof StartTaskInput.Type;
