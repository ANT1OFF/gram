// Settings by chat (docs/design/settings-by-chat.md): what `settings_read` shows, what
// `settings_propose` may change and at which tier, and the plan a change set makes, with the
// before → after rows its approval card shows. Pure: the server reads and writes, this decides.

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { chimeOf } from "./chime.ts";
import {
  ProjectLocalCheck,
  DEFAULT_LOCAL_CHECK_TIMEOUT_MS,
  type Project,
  ReasoningVariant,
  SpeedMode,
  AgentKind,
  SupportedModelRef,
  type ModelRef,
} from "./domain.ts";
import { MergeReviewPolicy } from "./merge-policy.ts";
import {
  noticeActionsOn,
  notifyAboutOf,
  openAtLaunchOf,
  overviewSidebarOf,
  restartOnMcpChangeOn,
  reviewRequestsAwaitChecks,
  reviewRequestsDirectOnly,
  reviewRequestsHideBots,
  reviewRequestsOn,
  sendKeyOf,
  SettingsPatch,
  usageHistoryEnabled,
  type Settings,
} from "./settings.ts";
import {
  AutomaticDreamThreshold,
  IdleCompactKind,
  idleCompactOf,
  autonomyOf,
  PauseAtLimitPct,
  OrchestratorCharter,
  WORKER_BRIEF_FOOTER_MAX,
  WORKER_MODEL_NOTE_MAX,
  WorkerBriefFooter,
  type WorkerModel,
  type WorkspaceState,
} from "./workspaces.ts";

export const SETTINGS_READ_TOOL = "settings_read";
export const SETTINGS_PROPOSE_TOOL = "settings_propose";

/** How long a proposal's card waits for the user before it is withdrawn and the call fails. */
export const SETTINGS_PROPOSAL_TTL_MS = 15 * 60 * 1000;

/** The most changes one proposal carries. */
export const SETTINGS_CHANGES_MAX = 20;

/** Tier 1 is a running workspace's; tier 2 the user's own app preferences. Both need a card. */
export type SettingsTier = "workspace" | "project" | "preference";
export type SettingsScope = "app" | "workspace" | "project";

const Item = Schema.Record(Schema.String, Schema.Unknown);

/**
 * One change in a proposal: `set` a key (`null` clears an optional one), or `add`, `update` or
 * `remove` an entry of a list key, which `match` names as `agent:model` or `agent:model@profileId`.
 */
export const SettingsChange = Schema.Union([
  Schema.Struct({ op: Schema.Literal("set"), key: Schema.NonEmptyString, value: Schema.Unknown }),
  Schema.Struct({ op: Schema.Literal("add"), key: Schema.NonEmptyString, item: Item }),
  Schema.Struct({
    op: Schema.Literal("update"),
    key: Schema.NonEmptyString,
    match: Schema.NonEmptyString,
    item: Item,
  }),
  Schema.Struct({
    op: Schema.Literal("remove"),
    key: Schema.NonEmptyString,
    match: Schema.NonEmptyString,
  }),
]);
export type SettingsChange = typeof SettingsChange.Type;

/** `settings_propose`'s arguments. */
export const SettingsProposeInput = Schema.Struct({
  changes: Schema.Array(SettingsChange),
  /** Why, in the agent's words; the card shows it. */
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  /** A plain thread may name a workspace by id or name; others may name only their own. */
  workspaceId: Schema.optionalKey(Schema.String),
  projectId: Schema.optionalKey(Schema.String),
});

/** One row of a proposal's card: `before` is `null` for a new entry, `after` for a removed one. */
export const SettingsDiffRow = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
});
export type SettingsDiffRow = typeof SettingsDiffRow.Type;

/** What a `settings_propose` card carries as its input, for the web to show as a diff. */
export const SettingsProposalCard = Schema.Struct({
  scope: Schema.Literals(["app", "workspace", "project"]),
  project: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      root: Schema.optionalKey(Schema.String),
    }),
  ),
  workspace: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
  reason: Schema.optionalKey(Schema.String),
  rows: Schema.Array(SettingsDiffRow),
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type SettingsProposalCard = typeof SettingsProposalCard.Type;

/** What a change set is read against: the app's settings, and the workspace in scope if any. */
export interface SettingsWorld {
  readonly settings: Settings;
  readonly project?: Project | undefined;
  readonly workspace?: WorkspaceState | undefined;
  /**
   * The model of the workspace's orchestrator, which decides the worker model used when none is
   * named (`workerFallback`); absent, the one a new orchestrator would open on.
   */
  readonly orchestrator?: ModelRef | undefined;
}

/**
 * The worker model a worker gets when its orchestrator names none: the one marked default, else
 * the orchestrator's own, else one of the same model id, else the first. The one rule both
 * `spawn_worker` and a proposal's card use.
 */
export const workerFallback = (
  allowed: ReadonlyArray<WorkerModel>,
  own: Pick<ModelRef, "agent" | "model"> | undefined,
): WorkerModel | undefined =>
  allowed.find((each) => each.default === true) ??
  (own === undefined
    ? undefined
    : (allowed.find((each) => each.agent === own.agent && each.model === own.model) ??
      allowed.find((each) => each.model === own.model))) ??
  allowed[0];

interface Entry {
  readonly key: string;
  readonly label: string;
  readonly tier: SettingsTier;
  readonly scope: SettingsScope;
  /** A list of worker models, changed by `add`, `update` and `remove`. */
  readonly list?: true;
  /** The effective value, as `settings_read` shows it and the card compares it. */
  readonly read: (world: SettingsWorld) => unknown;
  /** What an absent value means, in words. */
  readonly unset?: string;
}

const at = (settings: Settings, key: string): unknown => {
  const [group, field] = key.split(".");
  const section = (settings as Record<string, unknown>)[group!];
  if (field === undefined) return section;
  return typeof section === "object" && section !== null
    ? (section as Record<string, unknown>)[field]
    : undefined;
};

const pref = (
  key: string,
  label: string,
  read: (settings: Settings) => unknown = (settings) => at(settings, key),
  unset?: string,
): Entry => ({
  key,
  label,
  tier: "preference",
  scope: "app",
  read: (world) => read(world.settings),
  ...(unset === undefined ? {} : { unset }),
});

const charterOf = (world: SettingsWorld): OrchestratorCharter | undefined =>
  world.workspace?.charter;

const orchestratorModelOf = (world: SettingsWorld): ModelRef | undefined =>
  charterOf(world)?.orchestratorModel ?? world.settings.agents.defaultModel;

const ws = (
  key: string,
  label: string,
  read: (world: SettingsWorld) => unknown,
  unset?: string,
): Entry => ({
  key,
  label,
  tier: "workspace",
  scope: "workspace",
  read,
  ...(unset === undefined ? {} : { unset }),
});

/** Every key `settings_propose` may change. A key that isn't here is refused. */
export const SETTINGS_CATALOGUE: ReadonlyArray<Entry> = [
  ...(["command", "setup", "timeoutMs"] as const).map((field): Entry => ({
    key: `project.localCheck.${field}`,
    label: `Local check ${field === "timeoutMs" ? "timeout (ms)" : field}`,
    tier: "project",
    scope: "project",
    read: (w) =>
      w.project?.localCheckUnavailable ??
      w.project?.localCheck?.[field] ??
      (field === "timeoutMs" ? DEFAULT_LOCAL_CHECK_TIMEOUT_MS : undefined),
    unset:
      field === "command"
        ? "off — no local check configured; CI and GitHub rules apply"
        : "not set",
  })),
  // Tier 1: the running workspace and its orchestrator.
  ws(
    "workspace.maxConcurrentWorkers",
    "Max concurrent workers",
    (w) => charterOf(w)?.maxConcurrentWorkers,
  ),
  ws(
    "workspace.pauseAtLimitPct",
    "Pause new workers at limit (%)",
    (w) => charterOf(w)?.pauseAtLimitPct,
    "never",
  ),
  ws("workspace.mergeReviewPolicy", "Merge review policy", (w) =>
    charterOf(w) === undefined ? undefined : (charterOf(w)?.mergeReviewPolicy ?? "bot"),
  ),
  ws(
    "workspace.automaticDreamThreshold",
    "Automatic Dream after completions",
    (w) => charterOf(w)?.automaticDreamThreshold,
    "off",
  ),
  ws("workspace.idleAutoCompact", "Compact idle threads", (w) =>
    charterOf(w) === undefined ? undefined : idleCompactOf(charterOf(w)).enabled,
  ),
  ws("workspace.idleAutoCompactKinds", "Thread kinds idle compaction covers", (w) =>
    charterOf(w) === undefined ? undefined : idleCompactOf(charterOf(w)).kinds,
  ),
  ws("workspace.orchestratorModel", "Orchestrator model", orchestratorModelOf, "the app default"),
  ws(
    "workspace.orchestratorEffort",
    "Orchestrator effort",
    (w) => orchestratorModelOf(w)?.variant,
    "the model's default",
  ),
  {
    ...ws(
      "workspace.workerModels",
      "Worker model",
      (w) => charterOf(w)?.workerModels,
      "the orchestrator's own model only",
    ),
    list: true,
  },
  ws(
    "workspace.workerBriefFooter",
    "Worker brief footer",
    (w) => charterOf(w)?.workerBriefFooter,
    "none",
  ),
  ws("workspace.routeAtLimit", "Offer another model at a limit", (w) =>
    charterOf(w) === undefined ? undefined : charterOf(w)?.routeAtLimit === true,
  ),
  // Tier 2: the user's own app preferences.
  pref("appearance.mode", "Colour mode"),
  pref("appearance.paletteId", "Palette"),
  pref("appearance.density", "Density"),
  pref("appearance.contrast", "Contrast"),
  pref("appearance.motion", "Motion"),
  pref("appearance.showCost", "Show gateway cost", (s) => s.appearance.showCost ?? false),
  pref("composer.sendKey", "Send key", sendKeyOf),
  pref("layout.openAtLaunch", "Open at launch", openAtLaunchOf),
  pref("layout.quietWhenIdle", "Quiet when idle", (s) => s.layout?.quietWhenIdle ?? false),
  pref("layout.overviewSidebar", "Overview sidebar", overviewSidebarOf, "automatic"),
  pref("notifications.native", "Desktop notifications"),
  pref("notifications.sounds", "Sounds"),
  pref("notifications.chime", "Chime", (s) => chimeOf(s.notifications)),
  pref("notifications.notifyAbout", "Notify about", notifyAboutOf),
  pref("notifications.reviewRequests", "Review request notifications", reviewRequestsOn),
  pref(
    "notifications.reviewRequestsDirectOnly",
    "Only reviews requested by name",
    reviewRequestsDirectOnly,
  ),
  pref("notifications.reviewRequestsHideBots", "Hide bot PRs", reviewRequestsHideBots),
  pref(
    "notifications.reviewRequestsAwaitChecks",
    "Hold review requests until checks pass",
    reviewRequestsAwaitChecks,
  ),
  pref("updates.channel", "Update channel"),
  pref("logLevel", "Log level"),
  pref("agents.defaultModel", "Default model", undefined, "the agent's own default"),
  pref("agents.idleEvictMinutes", "Close idle sessions after (minutes)"),
  pref("agents.followWorktreeMoves", "Follow worktree moves"),
  pref("agents.restartOnMcpChange", "Restart sessions after MCP changes", restartOnMcpChangeOn),
  pref("agents.branchPrefix", "Branch prefix", (s) => s.agents.branchPrefix ?? "feat"),
  pref(
    "workspaces.localCheckConcurrency",
    "Local checks at once",
    (s) => s.workspaces?.localCheckConcurrency,
    "automatic: 1, or 2 on a machine with 12 or more cores",
  ),
  {
    ...pref(
      "agents.workerModels",
      "New-workspace worker model",
      (s) => s.agents.workerModels ?? [],
    ),
    list: true,
  },
];

/** A key no agent may set, even with the user's approval. */
export interface UserOnlyKey {
  readonly key: string;
  readonly reason: string;
  /** Its value, where showing it is harmless; absent, `settings_read` names the key only. */
  readonly read?: (world: SettingsWorld) => unknown;
  /**
   * The tool that changes it instead, on a card of its own that shows the whole workspace change;
   * absent, only the user changes it, in Settings.
   */
  readonly via?: string;
}

/**
 * Tier 3: never settable by an agent through `settings_propose`, approval or not. They widen
 * what agents may do, reach, run or send, and stay the user's in the Settings UI. A key names
 * itself and everything under it (`profiles` covers `profiles.<id>.key`).
 */
export const USER_ONLY_SETTINGS: ReadonlyArray<UserOnlyKey> = [
  {
    key: "workspace.paused",
    reason: "a pause is how the user stops agents, so only the user pauses or resumes",
    read: (w) => (w.workspace === undefined ? undefined : w.workspace.paused !== undefined),
  },
  {
    key: "workspace.autonomy",
    reason: "the autonomy level decides what agents may do without asking",
    read: (w) => (w.workspace === undefined ? undefined : autonomyOf(w.workspace.charter)),
    via: "workspace_update",
  },
  {
    key: "workspace.workerMode",
    reason: "it is the permission mode workers start in",
    read: (w) => w.workspace?.charter.workerMode,
    via: "workspace_update",
  },
  {
    key: "agents.defaultMode",
    reason: "it is the permission mode new threads start in",
    read: (w) => w.settings.agents.defaultMode,
  },
  { key: "workspace.connectors", reason: "connectors widen the tools agents get" },
  { key: "workspaces.orchestratorConnectors", reason: "connectors widen the tools agents get" },
  {
    key: "workspaces.orchestratorPeerMessaging",
    reason: "it lets an orchestrator send to sessions outside Gram",
    read: (w) => w.settings.workspaces?.orchestratorPeerMessaging === true,
  },
  {
    key: "workspace.projectIds",
    reason: "it is the repos a workspace can reach",
    via: "workspace_update",
  },
  {
    key: "workspace.homeProjectId",
    reason: "it is the repos a workspace can reach",
    via: "workspace_update",
  },
  { key: "agents.defaultFolder", reason: "it is a directory agents start in" },
  { key: "agents.cloneFolder", reason: "it is a directory Gram writes clones to" },
  { key: "agents.codexRuntime", reason: "it chooses the program Gram runs for Codex" },
  { key: "editor.command", reason: "it is a command Gram runs" },
  { key: "terminal.shell", reason: "it is a program Gram runs" },
  { key: "agents.customModels", reason: "it sends arbitrary model ids to agents as written" },
  { key: "helpers.claudeContext", reason: "it is consent for helper context, per provider" },
  { key: "helpers.codexContext", reason: "it is consent for helper context, per provider" },
  { key: "helpers.source", reason: "it routes helper calls to a gateway or a local CLI" },
  { key: "helpers.localFallback", reason: "it routes helper calls to a gateway or a local CLI" },
  { key: "profiles", reason: "gateway profiles hold credentials" },
  { key: "gateways", reason: "gateway profiles hold credentials" },
  {
    key: "updates.automaticChecks",
    reason: "it is an explicit opt-in to update checks",
    read: (w) => w.settings.updates.automaticChecks === true,
  },
  { key: "updates.pinnedVersion", reason: "it decides which build Gram installs" },
  {
    key: "usageHistory.claude",
    reason: "it is consent to read Claude Code's local history",
    read: (w) => usageHistoryEnabled(w.settings, "claude"),
  },
  {
    key: "usageHistory.codex",
    reason: "it is consent to read Codex's local history",
    read: (w) => usageHistoryEnabled(w.settings, "codex"),
  },
  {
    key: "workspaces.continueAfterRestart",
    reason: "it lets workers carry on unattended after a restart",
  },
  {
    key: "notifications.actions",
    reason: "it lets asks be answered from a desktop notification",
    read: (w) => noticeActionsOn(w.settings),
  },
  { key: "reviewBots", reason: "it decides whose review gates a merge" },
];

const entryOf = (key: string): Entry | undefined =>
  SETTINGS_CATALOGUE.find((entry) => entry.key === key);

/** The user-only rule covering `key`, matched case-insensitively so no spelling slips past. */
export const userOnlySetting = (key: string): UserOnlyKey | undefined => {
  const wanted = key.trim().toLowerCase();
  return USER_ONLY_SETTINGS.find((each) => {
    const own = each.key.toLowerCase();
    return wanted === own || wanted.startsWith(`${own}.`);
  });
};

// ─── How values read ──────────────────────────────────────────────────────────────────────────

const isModelRef = (value: unknown): value is ModelRef =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ModelRef).agent === "string" &&
  typeof (value as ModelRef).model === "string";

/**
 * `claude:opus · high · fast · profile p1`: every field a model ref stores. A speed is shown whenever
 * one is set, since an absent one keeps the CLI's and `standard` turns an inherited fast off.
 */
export const modelText = (model: ModelRef): string =>
  [
    `${model.agent}:${model.model}`,
    ...(model.variant === undefined ? [] : [model.variant]),
    ...(model.speed === undefined ? [] : [model.speed]),
    ...(model.profileId === undefined ? [] : [`profile ${model.profileId}`]),
  ].join(" · ");

const workerText = (model: WorkerModel): string =>
  `${modelText(model)}${model.default === true ? " · default" : ""}${
    model.useFor === undefined || model.useFor.trim() === "" ? "" : ` — ${model.useFor.trim()}`
  }`;

const valueText = (entry: Entry, value: unknown): string => {
  if (value === undefined || value === null) return entry.unset ?? "not set";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (isModelRef(value)) return modelText(value);
  if (Array.isArray(value)) return value.map((each) => valueText(entry, each)).join(", ");
  return JSON.stringify(value);
};

/** A worker model's identity in a list: `agent:model`, with `@profileId` when it has one. */
const identity = (model: WorkerModel): string =>
  `${model.agent}:${model.model}${model.profileId === undefined ? "" : `@${model.profileId}`}`;

// ─── settings_read ────────────────────────────────────────────────────────────────────────────

export interface SettingsReadRow {
  readonly key: string;
  readonly label: string;
  readonly tier: SettingsTier;
  readonly value: unknown;
}

/** The catalogue's rows for `scope`, read against `world`. */
export const readSettingsRows = (
  world: SettingsWorld,
  scope: SettingsScope,
): ReadonlyArray<SettingsReadRow> =>
  SETTINGS_CATALOGUE.filter((entry) => entry.scope === scope).map((entry) => {
    const value = entry.read(world);
    return {
      key: entry.key,
      label: entry.label,
      tier: entry.tier,
      value: value === undefined ? (entry.unset ?? null) : value,
    };
  });

/** Every user-only key, with its value where that is harmless to show. */
export const readUserOnlyRows = (world: SettingsWorld) =>
  USER_ONLY_SETTINGS.map((each) => {
    const value = each.read?.(world);
    return {
      key: each.key,
      reason: each.reason,
      ...(value === undefined ? {} : { value }),
      ...(each.via === undefined ? {} : { via: each.via }),
    };
  });

// ─── settings_propose ─────────────────────────────────────────────────────────────────────────

/**
 * One stored field a proposal writes, with its value as stored before (`undefined` when absent)
 * and after (`undefined` clears it). `path` is where it is stored: a settings group and field
 * (`["appearance", "mode"]`), a top-level setting (`["logLevel"]`), a charter field
 * (`["maxConcurrentWorkers"]`).
 */
export interface SettingsWrite {
  readonly key: string;
  readonly path: ReadonlyArray<string>;
  readonly before: unknown;
  readonly after: unknown;
}

/** An app setting a workspace write depends on, with the value the card was drawn from. */
export interface SettingsRequirement {
  readonly key: string;
  readonly path: ReadonlyArray<string>;
  readonly value: unknown;
}

/** Whether every app setting `requires` names still holds the value the card showed. */
export const settingsHold = (
  settings: Settings,
  requires: ReadonlyArray<SettingsRequirement>,
): boolean => requires.every((each) => sameValue(storedAt(settings, each.path), each.value));

/**
 * A change set's effect, checked against the schemas the Settings UI writes through. `writes` is
 * what is applied, each only while its field still holds `before`; `rows` show every one of them.
 */
export interface SettingsPlan {
  /** Entire opaque project recipe the user saw, checked atomically with config/audit writes. */
  readonly projectLocalCheckRevision?: string | undefined;
  readonly scope: SettingsScope;
  readonly writes: ReadonlyArray<SettingsWrite>;
  /**
   * App settings a workspace card's rows were read from, such as the default model a cleared
   * override falls back to. The write holds only while each still has `value`.
   */
  readonly requires: ReadonlyArray<SettingsRequirement>;
  readonly rows: ReadonlyArray<SettingsDiffRow>;
  /** The keys the change set named, in the order they were first named. */
  readonly keys: ReadonlyArray<string>;
  /** The models the change set names or re-tunes, to check against what their agent lists. */
  readonly models: ReadonlyArray<ModelRef>;
  readonly notes: ReadonlyArray<string>;
}

export type SettingsPlanResult =
  | { readonly ok: true; readonly plan: SettingsPlan }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> };

const strict = { onExcessProperty: "error" } as const;

const firstLine = (message: string) => message.split("\n").slice(0, 3).join(" ").trim();

const decodeWith = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownResult(schema as never, strict)(value) as Result.Result<
    S["Type"],
    { readonly message: string }
  >;

const WorkerModelAdd = Schema.Struct({
  agent: AgentKind,
  model: Schema.NonEmptyString,
  variant: Schema.optionalKey(ReasoningVariant),
  speed: Schema.optionalKey(SpeedMode),
  useFor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(WORKER_MODEL_NOTE_MAX))),
  default: Schema.optionalKey(Schema.Boolean),
});

const WorkerModelUpdate = Schema.Struct({
  useFor: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(WORKER_MODEL_NOTE_MAX))),
  ),
  default: Schema.optionalKey(Schema.Boolean),
  variant: Schema.optionalKey(Schema.NullOr(ReasoningVariant)),
  speed: Schema.optionalKey(SpeedMode),
});

const NO_PROFILE =
  "a gateway profile can't be chosen by chat: which profile, and so which key, a model runs on is the user's, in Settings";

/** The patch `{ group: { field: value } }`, or `{ key: value }` for a top-level key. */
const patchFor = (key: string, value: unknown): Record<string, unknown> => {
  const [group, field] = key.split(".");
  return field === undefined ? { [group!]: value } : { [group!]: { [field]: value } };
};

const mergePatch = (into: Record<string, unknown>, add: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(add)) {
    const existing = into[key];
    into[key] =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof existing === "object" &&
      existing !== null
        ? { ...existing, ...value }
        : value;
  }
};

/** The entries `match` names in `list`: by `agent:model`, and by profile when it gives one. */
const matching = (list: ReadonlyArray<WorkerModel>, match: string): ReadonlyArray<number> => {
  const wanted = match.trim().toLowerCase();
  const [label, profile] = wanted.split("@");
  return list.flatMap((model, index) => {
    if (`${model.agent}:${model.model}`.toLowerCase() !== label) return [];
    if (profile !== undefined && (model.profileId ?? "").toLowerCase() !== profile) return [];
    return [index];
  });
};

const withoutDefault = (list: Array<WorkerModel>, keep: number) => {
  for (const [index, model] of list.entries()) {
    if (index !== keep && model.default === true) {
      const { default: _, ...rest } = model;
      list[index] = rest;
    }
  }
};

/** Rows for a worker-model list: one per entry added, removed or changed, in list order. */
const listRows = (
  entry: Entry,
  before: ReadonlyArray<WorkerModel>,
  after: ReadonlyArray<WorkerModel>,
): Array<SettingsDiffRow> => {
  const ids = [...before.map(identity), ...after.map(identity)].filter(
    (id, index, all) => all.indexOf(id) === index,
  );
  return ids.flatMap((id) => {
    const was = before.find((model) => identity(model) === id);
    const now = after.find((model) => identity(model) === id);
    const beforeText = was === undefined ? null : workerText(was);
    const afterText = now === undefined ? null : workerText(now);
    return beforeText === afterText
      ? []
      : [{ key: entry.key, label: `${entry.label} ${id}`, before: beforeText, after: afterText }];
  });
};

/**
 * What `changes` would do to `world`, or every reason it can't: a key that is user-only or not in
 * the catalogue, an op that doesn't fit its key, a value its schema refuses, two scopes in one
 * set, or a set that changes nothing. Nothing here reads or writes anything.
 */
export const planSettingsChanges = (
  world: SettingsWorld,
  changes: ReadonlyArray<SettingsChange>,
  options: {
    /** A set that changes nothing is a plan with no writes, for a card that shows more besides. */
    readonly allowUnchanged?: boolean;
  } = {},
): SettingsPlanResult => {
  const errors: Array<string> = [];
  const keys: Array<string> = [];
  const models: Array<ModelRef> = [];
  const notes: Array<string> = [];
  const patch: Record<string, unknown> = {};
  let charter: Record<string, unknown> | undefined =
    world.workspace === undefined ? undefined : { ...world.workspace.charter };
  const projectCheck: Record<string, unknown> = { ...world.project?.localCheck };
  const lists = new Map<string, Array<WorkerModel>>();
  const scopes = new Set<SettingsScope>();

  if (changes.length === 0) return { ok: false, errors: ["Propose at least one change."] };
  if (changes.length > SETTINGS_CHANGES_MAX) {
    return { ok: false, errors: [`Propose at most ${SETTINGS_CHANGES_MAX} changes at once.`] };
  }

  for (const change of changes) {
    const key = change.key.trim();
    const userOnly = userOnlySetting(key);
    if (userOnly !== undefined) {
      errors.push(
        userOnly.via === undefined
          ? `${key} is the user's alone (${userOnly.reason}); no agent may change it, with approval or without. The user changes it in Settings.`
          : `${key} isn't a settings change (${userOnly.reason}): propose it with ${userOnly.via}, whose card shows the user the whole workspace change.`,
      );
      continue;
    }
    const entry = entryOf(key);
    if (entry === undefined) {
      errors.push(`${key} isn't settable by chat. settings_read lists the keys that are.`);
      continue;
    }
    scopes.add(entry.scope);
    if (!keys.includes(key)) keys.push(key);
    if (entry.scope === "workspace" && charter === undefined) {
      errors.push(
        `${key} needs a workspace, and this thread has none in scope. Name one with workspaceId from a thread the user is chatting with, or ask from the workspace's orchestrator.`,
      );
      continue;
    }

    if (entry.scope === "project") {
      if (world.project === undefined) {
        errors.push(`${key} needs a project in scope.`);
        continue;
      }
      if (change.op !== "set") {
        errors.push(`${key} changes with set.`);
        continue;
      }
      const field = key.slice("project.localCheck.".length);
      if (
        change.value === null ||
        (field !== "timeoutMs" && typeof change.value === "string" && change.value.trim() === "")
      )
        delete projectCheck[field];
      else projectCheck[field] = change.value;
      continue;
    }
    if (entry.list === true) {
      if (change.op === "set") {
        errors.push(`${key} is a list: change it with add, update or remove.`);
        continue;
      }
      const list =
        lists.get(key) ??
        ([
          ...((entry.read(world) as ReadonlyArray<WorkerModel> | undefined) ?? []),
        ] as Array<WorkerModel>);
      lists.set(key, list);
      if (change.op === "add") {
        if ("profileId" in change.item) {
          errors.push(`${key}: ${NO_PROFILE}.`);
          continue;
        }
        const decoded = decodeWith(WorkerModelAdd, change.item);
        if (Result.isFailure(decoded)) {
          errors.push(`${key}: ${firstLine(decoded.failure.message)}`);
          continue;
        }
        const item = decoded.success as WorkerModel;
        if (list.some((model) => identity(model) === identity(item))) {
          errors.push(`${key} already has ${identity(item)}; use update to change it.`);
          continue;
        }
        list.push(item);
        if (item.default === true) withoutDefault(list, list.length - 1);
        models.push(item);
        continue;
      }
      const found = matching(list, change.match);
      if (found.length !== 1) {
        errors.push(
          found.length === 0
            ? `${key} has no ${change.match}. It has: ${list.map(identity).join(", ") || "none"}.`
            : `${key} has ${found.length} entries for ${change.match}; name one as agent:model@profileId.`,
        );
        continue;
      }
      const index = found[0]!;
      if (change.op === "remove") {
        list.splice(index, 1);
        continue;
      }
      if ("profileId" in change.item) {
        errors.push(`${key}: ${NO_PROFILE}.`);
        continue;
      }
      const decoded = decodeWith(WorkerModelUpdate, change.item);
      if (Result.isFailure(decoded)) {
        errors.push(
          `${key}: ${firstLine(decoded.failure.message)} Only useFor, default, variant and speed change in place; remove the entry and add another to change its agent or model.`,
        );
        continue;
      }
      const update = decoded.success;
      const next: Record<string, unknown> = { ...list[index]! };
      for (const [field, value] of Object.entries(update)) {
        if (value === null) delete next[field];
        else next[field] = value;
      }
      if (update.default === false) delete next["default"];
      list[index] = next as WorkerModel;
      if (update.default === true) withoutDefault(list, index);
      if (update.variant !== undefined || update.speed !== undefined) models.push(list[index]!);
      continue;
    }

    if (change.op !== "set") {
      errors.push(`${key} isn't a list: change it with set.`);
      continue;
    }
    const value = change.value;

    if (entry.scope === "app") {
      if (key === "agents.defaultModel" && isModelRef(value) && value.profileId !== undefined) {
        errors.push(`${key}: ${NO_PROFILE}.`);
        continue;
      }
      const decoded = decodeWith(SettingsPatch, patchFor(key, value));
      if (Result.isFailure(decoded)) {
        errors.push(
          `${key}: ${value === null ? "can't be cleared" : firstLine(decoded.failure.message)}`,
        );
        continue;
      }
      mergePatch(patch, decoded.success as Record<string, unknown>);
      if (key === "agents.defaultModel" && isModelRef(value)) models.push(value);
      continue;
    }

    // Workspace scalar keys.
    const into = charter!;
    const field = key.slice("workspace.".length);
    switch (key) {
      case "workspace.maxConcurrentWorkers": {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
          errors.push(`${key}: expected a whole number of at least 1.`);
        } else into[field] = value;
        break;
      }
      case "workspace.mergeReviewPolicy": {
        const decoded = decodeWith(MergeReviewPolicy, value);
        if (Result.isFailure(decoded)) {
          errors.push(`${key}: expected one of ${MergeReviewPolicy.literals.join(", ")}.`);
        } else into[field] = decoded.success;
        break;
      }
      case "workspace.idleAutoCompact": {
        // `null` goes back to the default, which is on.
        if (value === null) delete into[field];
        else if (typeof value !== "boolean") errors.push(`${key}: expected true or false.`);
        else into[field] = value;
        break;
      }
      case "workspace.idleAutoCompactKinds": {
        if (value === null) {
          delete into[field];
          break;
        }
        const decoded = decodeWith(Schema.NonEmptyArray(IdleCompactKind), value);
        if (Result.isFailure(decoded)) {
          errors.push(
            `${key}: expected a non-empty list of ${IdleCompactKind.literals.join(", ")}, or null for the orchestrator only.`,
          );
        } else into[field] = [...new Set(decoded.success)];
        break;
      }
      case "workspace.pauseAtLimitPct":
      case "workspace.automaticDreamThreshold": {
        if (value === null) {
          delete into[field];
          break;
        }
        const schema =
          key === "workspace.pauseAtLimitPct" ? PauseAtLimitPct : AutomaticDreamThreshold;
        const decoded = decodeWith(schema, value);
        if (Result.isFailure(decoded)) {
          errors.push(
            `${key}: ${
              key === "workspace.pauseAtLimitPct"
                ? "expected a whole percent from 1 to 100, or null for never"
                : "expected a whole number from 1 to 1000, or null for off"
            }.`,
          );
        } else into[field] = decoded.success;
        break;
      }
      case "workspace.workerBriefFooter": {
        if (value === null || value === "") {
          delete into[field];
          break;
        }
        const decoded = decodeWith(WorkerBriefFooter, value);
        if (Result.isFailure(decoded)) {
          errors.push(
            `${key}: expected text of at most ${WORKER_BRIEF_FOOTER_MAX} characters, or null for none.`,
          );
        } else if (decoded.success.trim() === "") delete into[field];
        else into[field] = decoded.success;
        break;
      }
      case "workspace.routeAtLimit": {
        if (value === null || value === false) {
          delete into[field];
          break;
        }
        if (value !== true) errors.push(`${key}: expected true, or false for off.`);
        else into[field] = true;
        break;
      }
      case "workspace.orchestratorModel": {
        if (value === null) {
          delete into["orchestratorModel"];
          break;
        }
        if (isModelRef(value) && value.profileId !== undefined) {
          errors.push(`${key}: ${NO_PROFILE}.`);
          break;
        }
        const decoded = decodeWith(SupportedModelRef, value);
        if (Result.isFailure(decoded)) {
          errors.push(`${key}: ${firstLine(decoded.failure.message)}`);
        } else {
          into["orchestratorModel"] = decoded.success;
          models.push(decoded.success);
        }
        break;
      }
      case "workspace.orchestratorEffort": {
        // Only on a model this workspace pins: an effort on the inherited default would pin that
        // model as a side effect, and depend on an app setting the card can't hold still.
        const base = into["orchestratorModel"] as ModelRef | undefined;
        if (base === undefined) {
          errors.push(
            `${key}: this workspace's orchestrator follows the app's default model, so there is no model here to set the effort of. Set workspace.orchestratorModel with a variant instead.`,
          );
          break;
        }
        if (value === null) {
          const { variant: _, ...rest } = base;
          into["orchestratorModel"] = rest;
          break;
        }
        const decoded = decodeWith(ReasoningVariant, value);
        if (Result.isFailure(decoded)) {
          errors.push(`${key}: expected one of ${ReasoningVariant.literals.join(", ")}.`);
        } else {
          const model = { ...base, variant: decoded.success };
          into["orchestratorModel"] = model;
          models.push(model);
        }
        break;
      }
    }
  }

  if (scopes.size > 1) {
    errors.push(
      "One proposal changes app settings, one workspace, or one project, not both or several: propose them separately.",
    );
  }
  if (errors.length > 0) return { ok: false, errors };

  const scope: SettingsScope = scopes.has("project")
    ? "project"
    : scopes.has("workspace")
      ? "workspace"
      : "app";
  let writes: Array<SettingsWrite>;
  let next: SettingsWorld;

  if (scope === "project") {
    const decoded = decodeWith(ProjectLocalCheck, projectCheck);
    if (Result.isFailure(decoded))
      return { ok: false, errors: [firstLine(decoded.failure.message)] };
    writes = keys.map((key) => {
      const field = key.slice("project.localCheck.".length) as keyof ProjectLocalCheck;
      return {
        key,
        path: ["localCheck", field],
        before: world.project?.localCheck?.[field],
        after: decoded.success[field],
      };
    });
    const nextProject = { ...world.project!, localCheck: decoded.success };
    delete nextProject.localCheckUnavailable;
    next = { ...world, project: nextProject };
    if (world.project?.localCheckUnavailable !== undefined) {
      notes.push(
        "The unreadable stored local-check configuration will be replaced in full; its private contents are not shown.",
      );
      notes.push(
        `Complete destination: command=${decoded.success.command ?? "unset"}; setup=${decoded.success.setup ?? "unset"}; effective timeoutMs=${decoded.success.timeoutMs ?? DEFAULT_LOCAL_CHECK_TIMEOUT_MS}.`,
      );
    }
    notes.push(
      "Local checks execute repository code on your machine. Without a command, the local gate is OFF; CI and GitHub rules still apply.",
    );
  } else if (scope === "app") {
    for (const [key, list] of lists) mergePatch(patch, patchFor(key, list));
    const decoded = decodeWith(SettingsPatch, patch);
    if (Result.isFailure(decoded)) {
      return { ok: false, errors: [firstLine(decoded.failure.message)] };
    }
    writes = Object.entries(decoded.success as Record<string, unknown>).flatMap(
      ([group, value]): Array<SettingsWrite> =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? Object.entries(value).map(([field, leaf]) => ({
              key: `${group}.${field}`,
              path: [group, field],
              before: storedAt(world.settings, [group, field]),
              after: leaf === null ? undefined : leaf,
            }))
          : [
              {
                key: group,
                path: [group],
                before: storedAt(world.settings, [group]),
                after: value,
              },
            ],
    );
    next = { ...world, settings: applySettingsWrites(world.settings, writes)! };
  } else {
    const into = charter!;
    const roster = lists.get("workspace.workerModels");
    if (roster !== undefined) {
      if (roster.length === 0) {
        delete into["workerModels"];
        notes.push(
          "With no worker models listed, workers run on the orchestrator's own model, as in Settings.",
        );
      } else {
        into["workerModels"] = roster;
        if (world.workspace!.charter.workerModels === undefined) {
          notes.push(
            "Workers could run on the orchestrator's own model before; from now on only on the models listed.",
          );
        }
      }
    }
    const decoded = decodeWith(OrchestratorCharter, into);
    if (Result.isFailure(decoded)) {
      return { ok: false, errors: [firstLine(decoded.failure.message)] };
    }
    const before = world.workspace!.charter as Record<string, unknown>;
    const after = decoded.success as Record<string, unknown>;
    writes = [...new Set([...Object.keys(before), ...Object.keys(after)])].map((field) => ({
      key: `workspace.${field}`,
      path: [field],
      before: before[field],
      after: after[field],
    }));
    next = {
      ...world,
      workspace: { ...world.workspace!, charter: decoded.success },
    };
    if (keys.some((key) => key.startsWith("workspace.orchestrator"))) {
      notes.push(
        "The orchestrator model applies from the orchestrator's next session; the running one keeps its model until it is switched.",
      );
    }
  }

  writes = writes.filter(
    (write) =>
      (scope === "project" && world.project?.localCheckUnavailable !== undefined) ||
      !sameValue(write.before, write.after),
  );
  if (writes.length === 0 && options.allowUnchanged !== true) {
    return { ok: false, errors: ["This proposal changes nothing: every value is already so."] };
  }
  // A field outside the catalogue never changes: the planner only writes what it was asked to.
  const stray = writes.find((write) => entryOf(write.key) === undefined);
  if (stray !== undefined) {
    return { ok: false, errors: [`${stray.key} would change, and it isn't settable by chat.`] };
  }
  const rows = writes.flatMap((write) => rowsFor(write, world, next));
  // An orchestrator model that is or becomes inherited reads as the app's default: the write
  // holds only while that default is still the one the card showed.
  const requires: Array<SettingsRequirement> = writes.some(
    (write) =>
      write.key === "workspace.orchestratorModel" &&
      (write.before === undefined || write.after === undefined),
  )
    ? [
        {
          key: "agents.defaultModel",
          path: ["agents", "defaultModel"],
          value: world.settings.agents.defaultModel,
        },
      ]
    : [];

  return {
    ok: true,
    plan: {
      scope,
      writes,
      requires,
      rows,
      keys,
      models,
      notes,
      ...(scope === "project"
        ? { projectLocalCheckRevision: world.project?.localCheckRevision }
        : {}),
    },
  };
};

/** Rows for one write: a row per worker model it changes, or one row, never none. */
const rowsFor = (
  write: SettingsWrite,
  world: SettingsWorld,
  next: SettingsWorld,
): Array<SettingsDiffRow> => {
  const entry = entryOf(write.key)!;
  if (entry.list === true) {
    const before = (entry.read(world) as ReadonlyArray<WorkerModel> | undefined) ?? [];
    const after = (entry.read(next) as ReadonlyArray<WorkerModel> | undefined) ?? [];
    const was = before.map(identity);
    const now = after.map(identity);
    // Entries are told apart by identity; a list holding one twice is shown whole instead.
    if (new Set(was).size === was.length && new Set(now).size === now.length) {
      const rows = listRows(entry, before, after);
      // Where entries stand matters (the first one can be the fallback), so a move is shown even
      // beside other rows: kept entries keep their order and new ones go last, unless this row says.
      const expected = [
        ...was.filter((id) => now.includes(id)),
        ...now.filter((id) => !was.includes(id)),
      ];
      if (expected.join("\n") !== now.join("\n")) {
        rows.push({
          key: write.key,
          label: `${entry.label} order`,
          before: was.join(", ") || "none",
          after: now.join(", ") || "none",
        });
      }
      const fallbackBefore = fallbackText(entry, world);
      const fallbackAfter = fallbackText(entry, next);
      if (fallbackBefore !== fallbackAfter) {
        rows.push({
          key: write.key,
          label: "Worker model used when none is named",
          before: fallbackBefore,
          after: fallbackAfter,
        });
      }
      if (rows.length > 0) return rows;
    }
  } else {
    const before = storedText(entry, write.before, entry.read(world));
    const after = storedText(entry, write.after, entry.read(next));
    if (before !== after) return [{ key: write.key, label: entry.label, before, after }];
  }
  // Stored differently but read alike: still a change the user approves, so it is shown as stored.
  return [
    {
      key: write.key,
      label: entry.label,
      before: write.before === undefined ? null : JSON.stringify(write.before),
      after: write.after === undefined ? null : JSON.stringify(write.after),
    },
  ];
};

/**
 * A new workspace's charter as its card shows it: a row for each catalogue field it stores, a worker
 * model to a row, and the worker model used when none is named. `before` is `null` throughout,
 * since nothing stood there. The fields outside the catalogue that a card names itself (autonomy,
 * the worker mode) aren't here.
 */
export const charterRows = (world: SettingsWorld): Array<SettingsDiffRow> => {
  const charter = charterOf(world);
  if (charter === undefined) return [];
  const stored = charter as Record<string, unknown>;
  return SETTINGS_CATALOGUE.filter(
    (entry) =>
      entry.scope === "workspace" &&
      // The effort is shown on the orchestrator model it is stored with.
      entry.key !== "workspace.orchestratorEffort" &&
      stored[entry.key.slice("workspace.".length)] !== undefined,
  ).flatMap((entry): Array<SettingsDiffRow> => {
    const value = stored[entry.key.slice("workspace.".length)];
    if (entry.list !== true) {
      return [{ key: entry.key, label: entry.label, before: null, after: valueText(entry, value) }];
    }
    const roster = value as ReadonlyArray<WorkerModel>;
    return [
      ...roster.map((model) => ({
        key: entry.key,
        label: `${entry.label} ${identity(model)}`,
        before: null,
        after: workerText(model),
      })),
      {
        key: entry.key,
        label: "Worker model used when none is named",
        before: null,
        after: fallbackText(entry, world),
      },
    ];
  });
};

/** The model a worker of this list gets with none named, for the orchestrator `world` holds. */
const fallbackText = (entry: Entry, world: SettingsWorld): string => {
  // A new workspace's orchestrator follows the default model, or the agent discovered at start.
  const own =
    entry.scope === "app"
      ? world.settings.agents.defaultModel
      : (world.orchestrator ??
        world.workspace?.charter.orchestratorModel ??
        world.settings.agents.defaultModel);
  const list = entry.read(world) as ReadonlyArray<WorkerModel> | undefined;
  if (list === undefined || list.length === 0) {
    return own === undefined
      ? "the orchestrator's own model"
      : `${modelText(own)} (the orchestrator's own)`;
  }
  const fallback = workerFallback(list, own);
  return fallback === undefined ? "none" : identity(fallback);
};

/** A stored value as the card shows it; an absent one reads as the default it falls back to. */
const storedText = (entry: Entry, stored: unknown, effective: unknown): string => {
  if (stored !== undefined) return valueText(entry, stored);
  if (effective === undefined || effective === null) return entry.unset ?? "not set";
  return `${valueText(entry, effective)} (default)`;
};

/** The JSON of `value` with its objects' keys sorted, so two reads of one value compare equal. */
const canonical = (value: unknown): string | undefined =>
  JSON.stringify(value, (_key, each: unknown) =>
    typeof each === "object" && each !== null && !Array.isArray(each)
      ? Object.fromEntries(
          Object.entries(each).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : each,
  );

/** Whether two stored values are the same value, whatever their keys' order. */
export const sameValue = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

const storedAt = (root: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (here, step) =>
      typeof here === "object" && here !== null
        ? (here as Record<string, unknown>)[step]
        : undefined,
    root,
  );

const withAt = (
  root: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: unknown,
): Record<string, unknown> => {
  const [head, ...rest] = path;
  const next = { ...root };
  if (rest.length === 0) {
    if (value === undefined) delete next[head!];
    else next[head!] = value;
    return next;
  }
  const inner = next[head!];
  next[head!] = withAt(
    typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>) : {},
    rest,
    value,
  );
  return next;
};

/**
 * `writes` applied to `root`, only if every field still holds its `before`; `undefined` when one
 * has moved, so nothing is written. Fields the writes don't name are kept as they stand now.
 */
const applyWrites = <A>(root: A, writes: ReadonlyArray<SettingsWrite>): A | undefined => {
  if (writes.some((write) => !sameValue(storedAt(root, write.path), write.before))) {
    return undefined;
  }
  return writes.reduce<Record<string, unknown>>(
    (stored, write) => withAt(stored, write.path, write.after),
    root as Record<string, unknown>,
  ) as A;
};

/** App writes applied to the settings as they stand now, or `undefined` if one has moved. */
export const applySettingsWrites = (
  settings: Settings,
  writes: ReadonlyArray<SettingsWrite>,
): Settings | undefined => applyWrites(settings, writes);

/** Charter writes applied to the charter as it stands now, or `undefined` if one has moved. */
export const applyCharterWrites = (
  charter: OrchestratorCharter,
  writes: ReadonlyArray<SettingsWrite>,
): OrchestratorCharter | undefined => applyWrites(charter, writes);

/** The card's lead sentence: what changes, in a line. */
export const settingsProposalSummary = (card: SettingsProposalCard): string => {
  const where =
    card.scope === "workspace" && card.workspace !== undefined
      ? `the workspace “${card.workspace.name}”`
      : card.scope === "project" && card.project !== undefined
        ? `the project “${card.project.name}”${card.project.root === undefined ? "" : ` (${card.project.root})`}`
        : "Gram's app settings";
  const count = card.rows.length;
  return `Change ${count === 1 ? "1 setting" : `${count} settings`} in ${where}.`;
};

/** Apply only the approved project fields while their before values still match. */
export const applyProjectSettingsWrites = (
  project: Project,
  writes: ReadonlyArray<SettingsWrite>,
): Project | undefined => applyWrites(project, writes);
