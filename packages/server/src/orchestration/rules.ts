// Threaded orchestration's decisions as pure functions: who has authority, which workers are
// delegated, where a worker stands, what the charter's one cap allows, what a digest says and
// whether it is worth a wake.
//
// Everything here is a function over plain data. No Effect services, no I/O and no clocks: a rule
// that needs the time takes `now`. The orchestration service (`service.ts`) and the orchestration
// app tools are the only callers; they gather the facts, and what follows from them is decided
// here, where it can be tested without a server.

import { dreamSupportFor, type OutwardGate, type ToolAudience } from "@gram/agents";
import {
  USER_AWAY_AFTER_MINUTES,
  USER_HOLD_IDLE_MS,
  autonomyOf,
  connectorSetOf,
  narrowAllowlist,
  FEATURE_PLAN_MAX_STAGES,
  modelRefOf,
  FEATURE_STAGE_MAX,
  FEATURE_STAGE_NOTE_MAX,
  DIGEST_WAITING_LISTED,
  FINISHED_STATES,
  featureState,
  orchestrationMode,
  DEPENDENCY_DRAG_CONFLICT_MIN,
  DEPENDENCY_DRAG_ROUNDS,
  PrWakeEvent as PrWakeEvents,
  prRefText,
  prWakeWhen,
  requiredChecksOf,
  stageHasRemainingSteps,
  workerHasOngoingWork,
  WAKE_MAX_MINUTES,
  waitIsKept,
  AgentKind,
  type Autonomy,
  type BackgroundTask,
  type ChecksRollup,
  type DigestChange,
  type DigestReport,
  type DigestVariant,
  type DigestWaiting,
  type FeatureGroup,
  type FeatureGroupLedgerEntry,
  type FeatureLedgerEntry,
  type FeatureStage,
  type ModelRef,
  type OrchestratorCharter,
  type PauseReason,
  type PermissionMode,
  type PrRef,
  type PrStatus,
  type PrWakeEvent,
  type PrWakeFired,
  type PrWatchSeen,
  type ProjectId,
  type Settings,
  type SpawnedBy,
  type ThreadId,
  type ThreadRole,
  type ThreadStatus,
  type WaitItem,
  type WaitKind,
  type WorkerReport,
  type WorkerError,
  type WorkerReportState,
  type WorkerModel,
  type WorkerState,
  type WorkspaceId,
  workerFallback,
} from "@gram/contracts";
import { createHash } from "node:crypto";
import { SENDS_PER_MINUTE, WINDOW_MS as SEND_WINDOW_MS } from "../app-tools/loop-guard.ts";
import { redactText } from "../logging/redact.ts";

// ---------------------------------------------------------------------------------------------
// Authority, delegation, audience
// ---------------------------------------------------------------------------------------------

/** The parts a thread can play in orchestration. A worker has no `Thread.role`: it is any thread with `spawnedBy`. */
export type OrchestrationRole = ThreadRole | "worker";

/**
 * Only Codex and Claude Code may take executable orchestration roles. Claude uses its outward hook and strict
 * Dream file bridge. Codex requires an isolated gateway home for outward approval enforcement;
 * its Dreams use guided native permissions rather than a file-only guarantee. Server app-tool
 * approval, thread audience, ownership and confirmed system delivery remain authoritative.
 */
export const ADMITTED: Readonly<Record<OrchestrationRole, ReadonlyArray<AgentKind>>> = {
  orchestrator: ["claude", "codex"],
  worker: ["claude", "codex"],
  dream: AgentKind.literals.filter((agent) => {
    const mode = dreamSupportFor(agent, { kind: "implementation" }).mode;
    return mode === "confined" || mode === "guided";
  }),
};

/**
 * Agent kinds whose gated session only opens on a prepared Gram-owned native or gateway home.
 * Codex alone: an allow rule in `~/.codex` runs a push unasked under any policy.
 */
const GATE_NEEDS_OWNED_HOME: ReadonlyArray<AgentKind> = ["codex"];

/**
 * Agent kinds with no Auto. Codex's `auto` is the sandboxed on-request policy, where every network
 * need is a card. It does not report the downgrade `modeAfterDowngrade` waits for.
 */
const NO_AUTO: ReadonlyArray<AgentKind> = ["codex"];

/** Both supported Dream harnesses retain their existing gate requirements. */
const DREAM_NEEDS_NO_GATE: ReadonlyArray<AgentKind> = [];

/** Whether threads of this agent kind may take the role. */
export const admittedForRole = (kind: AgentKind, role: OrchestrationRole): boolean =>
  ADMITTED[role].includes(kind);

/** What the authority rules read off a thread; a `Thread` fits. */
export interface RuleThread {
  readonly id: ThreadId;
  readonly role?: ThreadRole | undefined;
  readonly workspaceId?: WorkspaceId | undefined;
  readonly spawnedBy?: SpawnedBy | undefined;
  readonly model: { readonly agent: AgentKind };
}

/** What the authority rules read off a workspace; a `Workspace` fits. */
export interface RuleWorkspace {
  readonly id: WorkspaceId;
  readonly orchestratorThreadId?: ThreadId | undefined;
}

/**
 * Whether the thread is its workspace's orchestrator right now. Every condition holds at
 * once or there is none: the thread carries the role, the workspace is the thread's own, the
 * workspace's slot names the thread, and its agent kind is admitted. Asked on every call, so a
 * stale role outside the slot is inert.
 */
export const hasAuthority = (input: {
  readonly thread: RuleThread;
  readonly workspace: RuleWorkspace | undefined;
}): boolean => {
  const { thread, workspace } = input;
  return (
    workspace !== undefined &&
    thread.role === "orchestrator" &&
    thread.workspaceId === workspace.id &&
    workspace.orchestratorThreadId === thread.id &&
    admittedForRole(thread.model.agent, "orchestrator")
  );
};

/**
 * The delegation rule: a cross-thread action needs no approval card only when the caller
 * has authority and the target is a worker it spawned itself. Every other thread, another
 * orchestrator's workers included, stays behind the card.
 */
export const isDelegated = (input: {
  readonly caller: RuleThread;
  readonly target: RuleThread;
  readonly workspace: RuleWorkspace | undefined;
}): boolean =>
  input.target.id !== input.caller.id &&
  input.target.spawnedBy?.threadId === input.caller.id &&
  hasAuthority({ thread: input.caller, workspace: input.workspace });

/**
 * Which app tools a thread's sessions are bound with. An orchestrator's only with authority; a
 * worker's (`report`) for any spawned thread of an admitted kind, whether or not its orchestrator
 * is still there to listen.
 */
export const toolAudience = (input: {
  readonly thread: RuleThread;
  readonly workspace?: RuleWorkspace | undefined;
}): ToolAudience => {
  const { thread, workspace } = input;
  if (hasAuthority({ thread, workspace })) return "orchestrator";
  if (thread.spawnedBy !== undefined && admittedForRole(thread.model.agent, "worker"))
    return "worker";
  return "plain";
};

// ---------------------------------------------------------------------------------------------
// Autonomy
// ---------------------------------------------------------------------------------------------

/** What a level of autonomy leaves the outward gate asking about; `full` asks about nothing. */
export const gateOfAutonomy = (autonomy: Autonomy): OutwardGate | undefined =>
  autonomy === "supervised" ? "all" : autonomy === "publish" ? "irreversible" : undefined;

/**
 * The outward gate a thread's sessions open with. A plain thread has none. An orchestrator in its slot and a worker whose spawner holds its
 * workspace's slot get their workspace's level. Everything else that still carries a mark keeps the
 * strictest gate for as long as it does: a dream whatever the autonomy, since it reads transcripts
 * nobody vetted (`DREAM_NEEDS_NO_GATE` excepted), and a role outside its slot, a worker whose workspace can't be found or whose
 * spawner isn't its orchestrator, and a kind that isn't admitted, since no charter speaks for them.
 */
export const outwardGateFor = (input: {
  readonly thread: RuleThread;
  readonly workspace: RuleWorkspace | undefined;
  /** The workspace's charter; absent with the workspace. */
  readonly charter: Pick<OrchestratorCharter, "autonomy"> | undefined;
}): OutwardGate | undefined => {
  const { thread, workspace, charter } = input;
  if (thread.role === undefined && thread.spawnedBy === undefined) return undefined;
  if (thread.role === "dream") {
    return (dreamSupportFor(thread.model.agent, { kind: "implementation" }).mode === "guided" ||
      DREAM_NEEDS_NO_GATE.includes(thread.model.agent)) &&
      admittedForRole(thread.model.agent, "dream")
      ? undefined
      : "all";
  }
  if (workspace === undefined || charter === undefined) return "all";
  const level = gateOfAutonomy(autonomyOf(charter));
  if (hasAuthority({ thread, workspace })) return level;
  const ownWorker =
    thread.role === undefined &&
    thread.spawnedBy !== undefined &&
    thread.workspaceId === workspace.id &&
    workspace.orchestratorThreadId === thread.spawnedBy.threadId &&
    admittedForRole(thread.model.agent, "worker");
  return ownWorker ? level : "all";
};

/**
 * The MCP lists a thread's sessions open with (the charter's connector set). A worker gets
 * its workspace's set. An orchestrator that lists its own connectors (`orchestrated`, from
 * Settings → Workspaces) gets that list narrowed by its workspace's set: a denylist goes beside
 * it, an allowlist keeps what both lists let in (`narrowAllowlist`). One that lists none gets the
 * set as a worker does, and on Claude none of the user's servers where its session would have no
 * tool search to defer their schemas (`mcpNoneWithoutToolSearch`). Any other audience gets
 * neither.
 */
export const mcpListsFor = (input: {
  readonly audience: ToolAudience;
  /**
   * `orchestratorConnectors(settings)` for a Claude orchestrator, empty when the user lists none.
   * Absent for another kind, which has always kept its own connectors, and for every worker.
   */
  readonly orchestrated: ReadonlyArray<string> | undefined;
  readonly charter: Pick<OrchestratorCharter, "connectors"> | undefined;
}): {
  readonly mcpAllowlist?: ReadonlyArray<string>;
  readonly mcpDenylist?: ReadonlyArray<string>;
  readonly mcpNoneWithoutToolSearch?: boolean;
} => {
  const set = input.charter === undefined ? undefined : connectorSetOf(input.charter);
  const deny =
    set !== undefined && "deny" in set && set.deny.length > 0 ? { mcpDenylist: set.deny } : {};
  if (input.audience === "plain") return {};
  const own = input.audience === "orchestrator" ? input.orchestrated : undefined;
  if (own !== undefined && own.length > 0) {
    return {
      mcpAllowlist: set !== undefined && "allow" in set ? narrowAllowlist(own, set.allow) : own,
      ...deny,
    };
  }
  const lean = own === undefined ? {} : { mcpNoneWithoutToolSearch: true };
  if (set === undefined) return lean;
  return "allow" in set ? { mcpAllowlist: set.allow, ...lean } : { ...deny, ...lean };
};

/**
 * The one delegation of an *outward* action: at `full` autonomy an orchestrator with
 * authority acts on a worker it spawned itself without a card. It is `isDelegated` and the level,
 * and a pause takes it away like everything else an orchestrator does on its own. Asked for a tool
 * whose definition names this delegation (`delegatedAtFullAutonomy`), never for outward tools at
 * large, so merging by any other route, closing, deleting and every other thread stay cards.
 */
export const fullAutonomyAllows = (input: {
  readonly caller: RuleThread;
  readonly target: RuleThread;
  readonly workspace: RuleWorkspace | undefined;
  readonly charter: Pick<OrchestratorCharter, "autonomy"> | undefined;
  readonly paused?: boolean | undefined;
}): boolean =>
  input.charter !== undefined &&
  input.paused !== true &&
  autonomyOf(input.charter) === "full" &&
  isDelegated(input);

/**
 * Whether a worker's review writes on its own PR (`OWN_PR_REVIEW_TOOLS`) follow its permission
 * mode, as a plain thread's do: only for its orchestrator's own worker, at a level that leaves PR
 * work free (`publish`, `full`). A worker the charter doesn't speak for, or one at
 * `supervised`, is asked on every call. A pause doesn't count: it stops the orchestrator, not the
 * worker's own PR.
 */
export const workerOwnPrFollowsMode = (input: {
  readonly thread: RuleThread;
  readonly workspace: RuleWorkspace | undefined;
  readonly charter: Pick<OrchestratorCharter, "autonomy"> | undefined;
}): boolean =>
  input.thread.role === undefined &&
  input.thread.spawnedBy !== undefined &&
  toolAudience(input) === "worker" &&
  input.workspace !== undefined &&
  input.charter !== undefined &&
  outwardGateFor(input) !== "all";

/**
 * Whether a worker merges its own PR without a card (`merge_when_ready`, `set_auto_merge`): its PR
 * work follows its mode (`workerOwnPrFollowsMode`), the workspace's autonomy is `full`, and it
 * isn't paused. At any lower level a merge is the user's.
 */
export const workerMergesOwnAtFull = (
  input: Parameters<typeof workerOwnPrFollowsMode>[0] & { readonly paused?: boolean | undefined },
): boolean =>
  workerOwnPrFollowsMode(input) &&
  input.charter !== undefined &&
  autonomyOf(input.charter) === "full" &&
  input.paused !== true;

// ---------------------------------------------------------------------------------------------
// Permission modes
// ---------------------------------------------------------------------------------------------

/** The mode a worker is spawned in: the charter's when it names one, else what orchestration starts in. */
export const startMode = (
  settings: Settings,
  charter: Pick<OrchestratorCharter, "workerMode">,
): PermissionMode => charter.workerMode ?? orchestrationMode(settings);

/**
 * The mode an orchestrator or worker of `kind` starts in. A kind with no Auto (`NO_AUTO`) starts
 * where `modeAfterDowngrade` would have moved it, in `bypassPermissions`, in which its gate still
 * asks: a thread nobody watches that stops at every edit is no use. So does a charter's `auto`,
 * which a new workspace's names. Any other mode the charter names for workers stands, and an
 * orchestrator is given no charter to read one from.
 */
export const startModeFor = (
  kind: AgentKind,
  settings: Settings,
  charter: Pick<OrchestratorCharter, "workerMode"> = {},
): PermissionMode =>
  NO_AUTO.includes(kind) && (charter.workerMode === undefined || charter.workerMode === "auto")
    ? "bypassPermissions"
    : startMode(settings, charter);

// ---------------------------------------------------------------------------------------------
// Worker models
// ---------------------------------------------------------------------------------------------

/** A worker model as the orchestrator names it: `agent:model`. */
export const workerModelLabel = (model: Pick<ModelRef, "agent" | "model">): string =>
  `${model.agent}:${model.model}`;

export type WorkerModelMatch =
  | {
      readonly ok: true;
      readonly model: ModelRef;
      /** Set when the entry named, or the default, is unavailable and another stood in for it. */
      readonly instead?: { readonly of: string; readonly why: string } | undefined;
    }
  | { readonly ok: false; readonly why: "unknown" | "ambiguous" }
  | { readonly ok: false; readonly why: "unavailable"; readonly reasons: string };

/** Why each of a roster's entries can't be spawned on here, by index; an entry left out can. */
export type RosterUnavailable = ReadonlyMap<number, string>;

/** The entry a worker gets when the orchestrator names none, if the user marked one. */
const defaultWorkerModel = (allowed: ReadonlyArray<WorkerModel>): WorkerModel | undefined =>
  allowed.find((each) => each.default === true);

/** The entry a worker gets with nothing named: the one marked default, else the orchestrator's own, else the first. */
export const fallbackOf = (
  allowed: ReadonlyArray<WorkerModel>,
  own: Pick<ModelRef, "agent" | "model">,
): WorkerModel | undefined => workerFallback(allowed, own);

/**
 * `spawn_worker.model` against the models a charter allows. A bare id is tried first, since a
 * model id may itself hold a colon, and must then name one entry only; otherwise `agent:model`
 * names the entry of that kind. With nothing named it is the entry the user marked the default,
 * else the one matching the orchestrator's own model, else the first. An entry that is unavailable
 * here (`unavailable`) is stood in for by that same choice among the available ones, so a roster
 * naming a model that isn't set up doesn't stop spawning. The entry comes back whole, so its
 * profile and effort come with it, and without the user's note about it.
 */
export const matchWorkerModel = (
  allowed: ReadonlyArray<WorkerModel>,
  named: string | undefined,
  own: Pick<ModelRef, "agent" | "model">,
  unavailable: RosterUnavailable = new Map(),
): WorkerModelMatch => {
  let picked: WorkerModel | undefined;
  if (named === undefined) {
    picked = fallbackOf(allowed, own);
  } else {
    const wanted = named.trim();
    const bare = allowed.filter((each) => each.model === wanted);
    const found =
      bare.length > 0 ? bare : allowed.filter((each) => workerModelLabel(each) === wanted);
    if (found.length > 1) return { ok: false, why: "ambiguous" };
    picked = found[0];
  }
  if (picked === undefined) return { ok: false, why: "unknown" };
  const why = unavailable.get(allowed.indexOf(picked));
  if (why === undefined) return { ok: true, model: modelRefOf(picked) };
  const usable = allowed.filter((_, index) => !unavailable.has(index));
  const instead = fallbackOf(usable, own);
  if (instead === undefined) {
    return {
      ok: false,
      why: "unavailable",
      reasons: allowed
        .map((each, index) => `${workerModelLabel(each)}: ${unavailable.get(index)}`)
        .join("; "),
    };
  }
  return { ok: true, model: modelRefOf(instead), instead: { of: workerModelLabel(picked), why } };
};

/** A gateway profile as the roster checks read it. */
interface RosterProfile {
  readonly id: string;
  readonly keyRef: string;
  readonly default?: boolean | undefined;
  readonly models: ReadonlyArray<{ readonly id: string }>;
}

/** What a roster entry is checked against, beside the entry itself. */
export interface RosterContext {
  readonly profiles: ReadonlyArray<RosterProfile>;
  /** What the harness lists on its own login, with no gateway; `undefined` when it listed none. */
  readonly ownModels?: ReadonlyArray<string> | undefined;
  /** The user's custom model ids for the entry's agent, which every list of it offers too. */
  readonly customModels?: ReadonlyArray<string> | undefined;
  /**
   * Whether the workspace asks before anything (its autonomy isn't `full`): native Codex also
   * needs a prepared Gram-owned home, checked through the adapter.
   */
  readonly gated?: boolean | undefined;
  /** The adapter can prepare a native login home with Gram's prompt rules. */
  readonly gateReady?: boolean | undefined;
}

const isGatewayKind = (agent: AgentKind): boolean => agent === "codex";

/** Whether an entry has to run on a gateway profile here, its harness's own login being no use. */
const needsGateway = (agent: AgentKind, context: RosterContext): boolean =>
  agent === "codex" && context.gated === true && context.gateReady !== true;

/** Whether `profile` lists `id`, as `models.list` would offer it: its own models, or a custom one. */
const lists = (profile: RosterProfile, id: string, custom: ReadonlyArray<string>): boolean =>
  profile.models.some((each) => each.id === id) || custom.includes(id);

/**
 * Why a worker model can't be spawned on here, as one line ending in its fix; `undefined` when it
 * can. An entry on a gateway profile needs the profile, with a key,
 * and listing its model when the profile lists any. A Codex entry on none runs on the
 * harness's own login, so it needs the harness to list the model: a gateway model such as GPT Sol
 * isn't one of them.
 */
export const workerModelUnavailable = (
  input: { readonly model: Pick<ModelRef, "agent" | "model" | "profileId"> } & RosterContext,
): string | undefined => {
  const { model } = input;
  if (!admittedForRole(model.agent, "worker"))
    return "this harness can't run as a worker; choose Codex or Claude Code in Settings → Workspaces";
  if (model.profileId !== undefined) {
    const profile = input.profiles.find((each) => each.id === model.profileId);
    if (profile === undefined) {
      return "its gateway profile is gone; pick another for it in Settings → Workspaces";
    }
    if (profile.keyRef === "") {
      return "its gateway profile has no key; add a gateway key in Settings → Gateways";
    }
    // A profile whose models were never fetched lists none, which says nothing against the entry.
    return profile.models.length > 0 && !lists(profile, model.model, input.customModels ?? [])
      ? `its gateway profile doesn't offer ${model.model}; pick one that does in Settings → Workspaces`
      : undefined;
  }
  if (!isGatewayKind(model.agent)) return undefined;
  if (needsGateway(model.agent, input)) {
    return `local Codex cannot prepare Gram's native approval home; check codex login and the Gram data directory, or select a prepared gateway home`;
  }
  if (input.ownModels?.includes(model.model) === true) return undefined;
  if (input.ownModels === undefined) {
    return `${kindName(model.agent)} couldn't list local models; install its CLI, sign in locally, then retry models in Settings → Agents`;
  }
  return `${kindName(model.agent)} does not list ${model.model} on your local account; choose a listed model in Settings → Workspaces`;
};

/** One worker model as `list_workers` shows it: how to name it, and what the user said it is for. */
export interface RosterEntry {
  readonly model: string;
  readonly useFor?: string | undefined;
  readonly default?: true | undefined;
  /** Why it can't be spawned on here; a spawn on it gets the default instead. */
  readonly unavailable?: string | undefined;
}

/**
 * The charter's worker models as the orchestrator reads them. A note is the user's free text, so
 * it is put on one line; only the first entry marked default is called one, as only it is used.
 */
export const rosterOf = (
  allowed: ReadonlyArray<WorkerModel>,
  unavailable: RosterUnavailable = new Map(),
): ReadonlyArray<RosterEntry> => {
  const fallback = defaultWorkerModel(allowed);
  return allowed.map((each, index) => {
    const note = each.useFor?.replace(/\s+/g, " ").trim() ?? "";
    const why = unavailable.get(index);
    return {
      model: workerModelLabel(each),
      ...(note === "" ? {} : { useFor: note }),
      ...(each === fallback ? { default: true as const } : {}),
      ...(why === undefined ? {} : { unavailable: why }),
    };
  });
};

/** A roster entry as a line of prose: `codex:gpt-6-sol (default): reviews, audits`. */
export const rosterLine = (entry: RosterEntry): string =>
  `${entry.model}${entry.default === true ? " (default)" : ""}${
    entry.useFor === undefined ? "" : `: ${entry.useFor}`
  }${entry.unavailable === undefined ? "" : ` [unavailable: ${entry.unavailable}]`}`;

/** The roster as a charter line and an indented line per model, for the boot digest and a change note. */
export const rosterText = (
  lead: string,
  allowed: ReadonlyArray<WorkerModel>,
  unavailable: RosterUnavailable = new Map(),
): string =>
  [lead, ...rosterOf(allowed, unavailable).map((entry) => `  - ${rosterLine(entry)}`)].join("\n");

/** An agent kind as prose names it. */
export const kindName = (kind: AgentKind): string =>
  kind === "codex" ? "Codex" : kind === "grok" ? "Grok Build" : "Claude";

export type WorkerModelVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "not_admitted"; readonly reason: string };

/** What `gateNeeds` weighs: a model, and the gate its thread's sessions would open under. */
export interface GateNeedsInput {
  readonly model: Pick<ModelRef, "agent" | "model">;
  /** The gate the thread's sessions open with (`outwardGateFor`); `undefined` is none. */
  readonly gate: OutwardGate | undefined;
  /** `model.profileId` names a gateway profile that exists. */
  readonly hasGatewayProfile: boolean;
  readonly mode: PermissionMode;
  /** The adapter's word on whether its gate holds in `mode` (`gateHoldsInMode`). */
  readonly gateHoldsInMode: boolean;
  readonly gateReady?: boolean | undefined;
  /** Existing provider history stays in its recorded home; user-home sessions cannot be gated. */
  readonly codexHome?: "user" | "owned" | "gateway" | undefined;
}

/**
 * What a gated thread on `model` lacks, or `undefined` when it lacks nothing: the one rule behind
 * `spawn_worker`, a model change and a lowered autonomy, so none of them can leave a thread whose
 * next open its adapter refuses. A kind in `GATE_NEEDS_OWNED_HOME` needs a prepared native home
 * or a gateway profile, and every kind needs a mode its gate can ask in. Without a gate nothing is needed.
 */
export const gateNeeds = (input: GateNeedsInput): "home" | "mode" | undefined => {
  if (input.gate === undefined) return undefined;
  if (
    GATE_NEEDS_OWNED_HOME.includes(input.model.agent) &&
    (input.codexHome === "user" || (!input.hasGatewayProfile && input.gateReady !== true))
  ) {
    return "home";
  }
  return input.gateHoldsInMode ? undefined : "mode";
};

/** Why a thread of `kind` in `mode` can't run under a gate, as one sentence for the user. */
export const gateNeedsReason = (
  needs: "home" | "mode",
  kind: AgentKind,
  mode: PermissionMode,
): string =>
  needs === "home"
    ? `${kindName(kind)} cannot prepare Gram's native approval home. Check codex login and the Gram data directory, or select a prepared gateway home.`
    : `In ${mode} mode ${kindName(kind)} can't ask before a push.`;

/**
 * Whether a worker may be started on, or moved to, `model`. Its kind must be admitted, and
 * under a gate it must have what `gateNeeds` asks. At `full` autonomy there is no gate, so nothing
 * more applies.
 */
export const workerModelVerdict = (
  input: Omit<GateNeedsInput, "gate"> & { readonly autonomy: Autonomy },
): WorkerModelVerdict => {
  const { model, autonomy } = input;
  if (!admittedForRole(model.agent, "worker")) {
    return {
      ok: false,
      code: "not_admitted",
      reason: `${model.agent} threads can't be workers yet.`,
    };
  }
  const needs = gateNeeds({ ...input, gate: gateOfAutonomy(autonomy) });
  if (needs === "home") {
    return {
      ok: false,
      code: "not_admitted",
      reason: `${kindName(model.agent)} cannot prepare Gram's native approval home while this workspace asks (autonomy ${autonomy}). Check codex login and the Gram data directory, or select a prepared gateway home.`,
    };
  }
  if (needs === "mode") {
    return {
      ok: false,
      code: "not_admitted",
      reason: `The charter starts workers in ${input.mode} mode, in which a ${kindName(model.agent)} worker can't ask before a push, and this workspace's autonomy (${autonomy}) says it must. Pick another model, or ask the user to change the charter's worker mode.`,
    };
  }
  return { ok: true };
};

/**
 * The mode to move an orchestrator or worker to after its agent reported a mode change, or
 * `undefined` to leave it alone. A model with no Auto answers an `auto` open by reporting `default`,
 * and a thread nobody watches that stops at every edit is no use, so it goes to
 * `bypassPermissions`; the outward gate still asks there. Any other report is the user's own choice
 * or the charter's stricter mode, and stands.
 */
export const modeAfterDowngrade = (input: {
  readonly openedIn: PermissionMode;
  readonly reported: PermissionMode;
}): PermissionMode | undefined =>
  input.openedIn === "auto" && input.reported === "default" ? "bypassPermissions" : undefined;

// ---------------------------------------------------------------------------------------------
// Worker and feature state
// ---------------------------------------------------------------------------------------------

// `workerState`, `featureState` and their order live in the contracts, so the board's live overlay
// and the web's mock ledger use the same rule as the ledger.
export {
  WORKER_STATE_ORDER,
  featureState,
  workerState,
  workerStateBase,
  type WorkerStateInput,
} from "@gram/contracts";

// ---------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------

/** Why an orchestration tool refused, as the prefix of its error message. */
export type RefusalCode =
  | "no_authority"
  | "paused"
  | "rate"
  | "user_intervened"
  | "not_your_worker"
  | "not_admitted"
  | "outside_workspace"
  | "invalid_feature"
  | "duplicate_repo"
  | "invalid_stage"
  | "invalid_group"
  | "unknown_feature"
  | "not_allowed"
  | "wrong_kind"
  | "unknown_request"
  | "not_joinable"
  | "limit_paused"
  | "limit_unanswered"
  | "feature_paused"
  | "unknown_question"
  | "closed"
  | "forwarded";

/**
 * An `AppToolError` message with its machine-readable prefix, `code: message`, so an agent (and a
 * test) can tell refusals apart without parsing prose.
 */
export const refusal = (code: RefusalCode, message: string): string => `${code}: ${message}`;

// ---------------------------------------------------------------------------------------------
// The orchestrator → worker loop guard
// ---------------------------------------------------------------------------------------------

/** `USER_HOLD_IDLE_MS` lives in the contracts, so the worker view's hold chip says the same. */
export { USER_HOLD_IDLE_MS };

/**
 * Epoch ms at which a user's hold on a worker lapses if the worker is idle or cold by then;
 * `undefined` without a hold. Counted from the user's latest typed input, so writing again
 * restarts it.
 */
export const userHoldLapsesAt = (memo: {
  readonly userIntervened: boolean;
  readonly userInputAt?: number | undefined;
  readonly lastInputAt: number;
}): number | undefined =>
  memo.userIntervened ? (memo.userInputAt ?? memo.lastInputAt) + USER_HOLD_IDLE_MS : undefined;

/**
 * The `user_intervened` refusal: what the hold keeps from the orchestrator (`what`), and the three
 * ways it ends, so the orchestrator can tell the user how to hand the worker back.
 */
export const userHoldReason = (what: string): string =>
  `The user wrote to this worker, so it is theirs for now and ${what}. It comes back to you when it next reports, when the user hands it back ("Hand back" in its thread's header, or "Hand back to orchestrator" in the worker's menu on the board or in the sidebar), or once it has sat idle ${USER_HOLD_IDLE_MS / 60_000} minutes after their last message; a digest will say so. If you need it sooner, tell the user they can hand it back.`;

/** What `checkWorkerSend` weighs for one `send_message` from an orchestrator to its own worker. */
export interface WorkerSendCheck {
  /** Epoch ms of the orchestrator's earlier sends to this worker. */
  readonly recentSends: ReadonlyArray<number>;
  readonly now: number;
  /** The user typed in the worker after the orchestrator's last message, and it hasn't reported since. */
  readonly userIntervened: boolean;
  readonly paused: boolean;
  /** The worker's feature, when the user has paused it (`WorkspaceState.pausedFeatures`). */
  readonly pausedFeature?: string | undefined;
}

export type WorkerSendVerdict =
  | {
      readonly ok: true;
      /** The orchestrator's sends to this worker inside the window, this one included. */
      readonly recentSends: ReadonlyArray<number>;
    }
  | {
      readonly ok: false;
      readonly code: Extract<RefusalCode, "paused" | "feature_paused" | "rate" | "user_intervened">;
      /** Written for the orchestrator to act on. */
      readonly reason: string;
    };

/**
 * `checkSend` for an orchestrator writing to its own worker. The back-to-back rule is dropped: a
 * worker's first input is the orchestrator's brief, so it would refuse every follow-up until the
 * user typed there. What is left is a pause, the user's intervention, and the per-minute rate limit
 * every thread has, counted here for each worker on its own (`recentSends` are this pair's). It is a
 * loop guard and not a budget: how much an orchestrator says to a worker is otherwise its own
 * business. Hop depth isn't weighed, since these messages always
 * carry depth 1. The refusals no amount of waiting cures come first.
 */
export const checkWorkerSend = (check: WorkerSendCheck): WorkerSendVerdict => {
  if (check.paused) {
    return {
      ok: false,
      code: "paused",
      reason:
        "Orchestration is paused, so messages to workers are refused. Only the user can resume it; end your turn.",
    };
  }
  if (check.pausedFeature !== undefined) {
    return {
      ok: false,
      code: "feature_paused",
      reason: `The user paused feature ${check.pausedFeature}, so its workers get no messages. Only the user can resume it; leave it until a digest says they did.`,
    };
  }
  if (check.userIntervened) {
    return {
      ok: false,
      code: "user_intervened",
      reason: userHoldReason("you can't message it"),
    };
  }
  const recent = check.recentSends.filter((at) => check.now - at < SEND_WINDOW_MS);
  if (recent.length >= SENDS_PER_MINUTE) {
    const oldest = recent[0] ?? check.now;
    const wait = Math.max(1, Math.ceil((SEND_WINDOW_MS - (check.now - oldest)) / 1000));
    return {
      ok: false,
      code: "rate",
      reason: `send_message allows ${SENDS_PER_MINUTE} messages a minute to one worker; try again in ${wait}s, or fold what you have to say into one message.`,
    };
  }
  return { ok: true, recentSends: [...recent, check.now] };
};

// ---------------------------------------------------------------------------------------------
// The charter's cap
// ---------------------------------------------------------------------------------------------

export type BudgetVerdict =
  | { readonly ok: true }
  | {
      /** At the concurrency cap: the user may allow this one spawn with a card. */
      readonly ok: false;
      readonly code: "needs_card";
      readonly reason: string;
    };

/**
 * Whether the charter allows another worker now. Workers in parallel is the only thing a charter
 * caps: how long, how much and how often agents work is limited outside the app, by the user's own
 * spending limits, and cost is shown in the ledger without being enforced. At the cap a spawn
 * isn't refused, it asks the user, once.
 */
export const budgetVerdict = (input: {
  readonly charter: Pick<OrchestratorCharter, "maxConcurrentWorkers">;
  readonly liveWorkers: number;
}): BudgetVerdict =>
  input.liveWorkers >= input.charter.maxConcurrentWorkers
    ? {
        ok: false,
        code: "needs_card",
        reason: `${input.liveWorkers} workers are live and the charter allows ${input.charter.maxConcurrentWorkers} at once. The user is asked whether to allow one more.`,
      }
    : { ok: true };

// ---------------------------------------------------------------------------------------------
// Overlap
// ---------------------------------------------------------------------------------------------

/** Neutral defaults; workspaces can replace this list, including with an empty list. */
const DEFAULT_OVERLAP_IGNORE_PATHS: ReadonlyArray<string> = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "mix.lock",
  "Package.resolved",
];

/** A live worker's changed files, as paths relative to its repo. */
export interface WorkerFiles {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly files: ReadonlyArray<string>;
  /** What each path holds now (`changedPaths`), where that could be read. */
  readonly signatures?: Readonly<Record<string, string>> | undefined;
}

/**
 * Every pair of workers in the same project whose changed files intersect, keyed by their two ids
 * sorted and joined with a space, with the paths they share, sorted. A path both changed to the
 * same content is no conflict and isn't shared. Per project because separate repos can't conflict.
 */
export const overlapPairs = (
  workers: ReadonlyArray<WorkerFiles>,
  ignorePaths: ReadonlyArray<string> = DEFAULT_OVERLAP_IGNORE_PATHS,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const byFile = new Map<
    string,
    Array<{ readonly threadId: ThreadId; readonly signature: string | undefined }>
  >();
  for (const worker of workers) {
    for (const file of worker.files) {
      if (
        ignorePaths.some((path) =>
          path.includes("/") ? file === path : file.split("/").at(-1) === path,
        )
      )
        continue;
      const key = `${worker.projectId}\0${file}`;
      const touching = byFile.get(key) ?? [];
      touching.push({ threadId: worker.threadId, signature: worker.signatures?.[file] });
      byFile.set(key, touching);
    }
  }
  const pairs = new Map<string, Set<string>>();
  for (const [key, touching] of byFile) {
    const file = key.slice(key.indexOf("\0") + 1);
    for (const a of touching) {
      for (const b of touching) {
        if (a.threadId >= b.threadId) continue;
        if (a.signature !== undefined && a.signature === b.signature) continue;
        const pair = `${a.threadId} ${b.threadId}`;
        pairs.set(pair, (pairs.get(pair) ?? new Set()).add(file));
      }
    }
  }
  return new Map([...pairs].map(([pair, files]) => [pair, [...files].toSorted()]));
};

/**
 * For each worker, the workers in the same project it overlaps (`overlapPairs`); workers that
 * overlap nobody are absent. Ids come out sorted so two builds of the same ledger compare equal.
 */
export const overlaps = (
  workers: ReadonlyArray<WorkerFiles>,
): Readonly<Record<ThreadId, ReadonlyArray<ThreadId>>> => {
  const found = new Map<ThreadId, Set<ThreadId>>();
  for (const pair of overlapPairs(workers).keys()) {
    const [a, b] = pair.split(" ") as [ThreadId, ThreadId];
    found.set(a, (found.get(a) ?? new Set()).add(b));
    found.set(b, (found.get(b) ?? new Set()).add(a));
  }
  const out: Record<ThreadId, ReadonlyArray<ThreadId>> = {};
  for (const id of [...found.keys()].toSorted()) out[id] = [...(found.get(id) ?? [])].toSorted();
  return out;
};

/** How many shared paths an overlap names before it counts the rest. */
const OVERLAP_PATHS_NAMED = 3;

/** The first shared paths and a count of the rest, so a false alarm can be told at a glance. */
export const sharedPathsText = (paths: ReadonlyArray<string>): string =>
  paths.length <= OVERLAP_PATHS_NAMED
    ? paths.join(", ")
    : `${paths.slice(0, OVERLAP_PATHS_NAMED).join(", ")} and ${paths.length - OVERLAP_PATHS_NAMED} more`;

const claimPath = (claim: string): string =>
  claim
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/\*{1,2}$/, "")
    .replace(/\/+$/, "")
    .replace(/^\.$/, "");

const within = (inner: string, outer: string): boolean =>
  // oxlint-disable-next-line gram/no-raw-path -- scope claims are repo-relative strings, not paths
  outer === "" || inner === outer || inner.startsWith(`${outer}/`);

/**
 * Where two advisory `spawn_worker.scope` claims meet: for each pair in which one path contains the
 * other, the narrower of the two. Claims are path prefixes matched on whole segments (`src/api`
 * holds `src/api/x.ts`, not `src/apiary`); a trailing `/`, `/*` or `/**` is ignored, and an empty
 * claim or `.` is the whole repo.
 */
export const scopeOverlap = (
  claimA: ReadonlyArray<string>,
  claimB: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const shared = new Set<string>();
  for (const a of claimA.map(claimPath)) {
    for (const b of claimB.map(claimPath)) {
      if (within(a, b)) shared.add(a);
      else if (within(b, a)) shared.add(b);
    }
  }
  return [...shared].toSorted();
};

// ---------------------------------------------------------------------------------------------
// The digest as a diff
// ---------------------------------------------------------------------------------------------

/** What the last acknowledged digest knew about one worker. */
interface WorkerSnapshot {
  readonly state: WorkerState;
  /** Kept so a worker that has gone can still be named. */
  readonly feature: string;
  readonly title: string;
  /** Its latest `report.interface`. */
  readonly interface?: string | undefined;
  readonly overlapsWith: ReadonlyArray<string>;
  readonly actionKey?: string | undefined;
  readonly reportKey?: string | undefined;
  /** How many of its turns had ended with nothing queued behind them. */
  readonly turnEnds?: number | undefined;
  /** The quiet condition already delivered, so it survives snapshots taken during a turn. */
  readonly quietKey?: string | undefined;
  /** Its worktree was gone, so the digest that said so isn't repeated. */
  readonly worktreeMissing?: true | undefined;
}

/** Report timestamps do not turn unchanged worker-authored evidence into news. */
const reportEvidenceKey = (
  report: Pick<WorkerReport, "state" | "summary" | "interface" | "prUrl" | "evidence">,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        report.state,
        report.summary,
        report.interface,
        report.prUrl,
        report.evidence,
      ]),
    )
    .digest("hex");

/** Keep distinct decisions/evidence in order, suppress exact consecutive repeats across digests. */
export const newDigestReports = (
  reports: ReadonlyArray<DigestReport>,
  snapshot: DigestSnapshot,
): ReadonlyArray<DigestReport> => {
  const seen = new Map(Object.entries(snapshot).map(([id, worker]) => [id, worker.reportKey]));
  return reports.filter((report) => {
    const key = reportEvidenceKey(report);
    const repeated = seen.get(report.threadId) === key;
    seen.set(report.threadId, key);
    return !repeated;
  });
};

/** A changed wait's concrete owner and next step, from recorded facts only. */
const actionEvidenceText = (worker: FeatureLedgerEntry["workers"][number]): string => {
  const request = worker.pendingRequests[0];
  if (request !== undefined)
    return `user: answer ${request.kind}${request.requestId ? ` [request ${request.requestId}]` : ""}`;
  const prs = [
    worker.pr,
    ...(worker.morePrs ?? []),
    ...(worker.alsoIn ?? []).flatMap((repo) => [repo.pr, ...(repo.morePrs ?? [])]),
  ].filter((pr) => pr?.state === "open");
  for (const pr of prs) {
    if (pr === undefined) continue;
    const name = `${pr.repo}#${pr.number}`;
    if (pr.mergeState === "DIRTY")
      return `verified git conflict on ${name}; this worker must resolve it`;
    if (pr.mergeWhenReady?.hold !== undefined)
      return `${name}: merge held: ${workText(pr.mergeWhenReady.hold)}; preserve the hold until its owner releases it`;
    const dependencies = (pr.dependsOn ?? []).filter(
      (dependency) => dependency.mergeAfter !== false && dependency.state !== "merged",
    );
    if (dependencies.length > 0)
      return `${name}: wait for dependencies ${dependencies.map((dependency) => `${dependency.repo}#${dependency.number}${dependency.threadId ? ` [thread ${dependency.threadId}]` : ""}`).join(", ")}`;
    if (pr.checks?.startsWith("failing"))
      return `${name}: CI failing; this worker must inspect and fix the failed checks`;
    if (pr.checks?.startsWith("pending")) return `${name}: CI pending; wait for checks to settle`;
    if (pr.verdictOnHead === "changesRequested" || pr.reviewDecision === "CHANGES_REQUESTED")
      return `${name}: review requests changes; this worker must address the findings`;
    if (pr.botOnHead === "reviewing") return `${name}: review in flight; wait for its findings`;
    if (pr.reviewDecision === "REVIEW_REQUIRED")
      return `${name}: awaiting requested review${pr.reviewRequests?.length ? ` from ${pr.reviewRequests.map((reviewer) => workText(reviewer.name)).join(", ")}` : ""}`;
  }
  if (worker.runWatches?.length)
    return `workflow monitors pending: ${worker.runWatches.map((run) => `${run.repo} run ${run.runId}`).join(", ")}; keep this worker available`;
  if (worker.wakes?.length)
    return "scheduled wake pending; keep this worker available for its recorded next step";
  return "wait evidence changed; read this worker's current row before choosing the next action";
};

/** Ages and activity text are intentionally excluded: only changed actionable records count. */
const actionEvidenceKey = (worker: FeatureLedgerEntry["workers"][number]): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        prs: [
          worker.pr,
          ...(worker.morePrs ?? []),
          ...(worker.alsoIn ?? []).flatMap((repo) => [repo.pr, ...(repo.morePrs ?? [])]),
        ]
          // A PR opened and closed inside one window leaves no actionable wait.
          // Its closure still matters through worker-state or dependency transitions.
          .filter((pr) => pr !== undefined && pr.state !== "closed")
          .map((pr) =>
            pr?.state === "merged"
              ? { repo: pr.repo, number: pr.number, state: pr.state }
              : {
                  ...pr,
                  conflictedMin: undefined,
                  dependsOn: pr?.dependsOn?.map((dependency) => ({
                    ...dependency,
                    rounds: undefined,
                  })),
                },
          ),
        requests: worker.pendingRequests.map((request) => [
          request.requestId,
          request.kind,
          request.summary,
        ]),
        wakes: worker.wakes,
        runs: worker.runWatches,
        reportStands: worker.reportStands,
      }),
    )
    .digest("hex");

/** The ledger as of the last acknowledged digest, by thread id; plain JSON, so the outbox stores it as is. */
export type DigestSnapshot = Readonly<Record<string, WorkerSnapshot>>;

export interface DigestDiff {
  /** At most one per worker, in ledger order, workers that have gone last. */
  readonly changes: ReadonlyArray<DigestChange>;
  /** Feature-level transitions, for `OrchestrationDigest.notes`. */
  readonly notes: ReadonlyArray<string>;
  /** Whether this diff alone justifies a turn of the orchestrator. */
  readonly worthWaking: boolean;
  /** What to persist once the digest carrying this diff is acknowledged. */
  readonly nextSnapshot: DigestSnapshot;
}

/** States an orchestrator's own spawn and an ordinary turn start move a worker between. */
const QUIET_STATES: ReadonlySet<WorkerState> = new Set<WorkerState>(["briefed", "working"]);

/** Statuses of a worker that isn't doing anything and won't until someone writes to it. */
const AT_REST: ReadonlySet<ThreadStatus> = new Set<ThreadStatus>(["idle", "cold"]);

const WENT_QUIET = "ended its turn without reporting; read its last messages with get_thread";

const WORKTREE_GONE =
  "its worktree was deleted outside Gram and its agent stopped, with any uncommitted work lost; restore it with restore_worktree, or archive the worker";

const READY_NEXT = "Merging is the user's: tell them it is ready, and in what order to merge";
/** At `full` the merge is the orchestrator's to make, and the user's standing decisions say how. */
const READY_NEXT_FULL =
  "Merge it as your standing decisions and the order of merging allow (`set_auto_merge`, or brief its workers), and tell the user what you merged; ask only what no decision covers";
const DELIVERED_NEXT = "merging or whatever comes next is yours or the user's to decide";
/** An archived worker leaves the publisher's watch and its GitHub sweeps, and `list_workers`. */
const MERGED_NEXT =
  "archive its workers with `archive_thread` once you no longer need them; their worktrees and branches stay";

/**
 * What a feature reaching `state` as a whole is worth saying, from its workers' states. Every
 * sentence about pull requests is made from PR facts alone: a `delivered` sibling has none, so
 * beside one the note speaks of "every pull request" rather than "every worker", and a feature that
 * finished through `delivered` is told in as many words that nothing is merged. An orchestrator in
 * a live run read "every pull request is merged" over branches that were not in main.
 */
const featureNote = (
  state: WorkerState,
  workers: ReadonlyArray<WorkerState>,
  autonomy: Autonomy | undefined,
): string | undefined => {
  const readyNext = autonomy === "full" ? READY_NEXT_FULL : READY_NEXT;
  const live = workers.filter((worker) => worker !== "archived");
  const delivered = live.filter((worker) => worker === "delivered").length;
  const beside =
    delivered === 1
      ? "one worker has delivered where no pull request can be opened"
      : `${delivered} workers have delivered where no pull request can be opened`;
  switch (state) {
    case "inReview":
      return delivered === 0
        ? "every worker now has a pull request in review"
        : `every pull request is now in review, and ${beside}`;
    case "readyToMerge":
      return delivered === 0
        ? `every worker is approved on head with green checks. ${readyNext}`
        : `every pull request is approved on head with green checks, and ${beside}. ${readyNext}; the delivered work is not merged`;
    case "delivered":
      return delivered === live.length
        ? `every worker has delivered; no pull requests exist here, so nothing is merged — ${DELIVERED_NEXT}`
        : `every pull request is merged, and ${beside}; that work is not merged — ${DELIVERED_NEXT}`;
    case "merged":
      return `every pull request is merged; explicit process stages and monitors remain independent — ${MERGED_NEXT}`;
    default:
      return undefined;
  }
};

const snapshotStates = (snapshot: DigestSnapshot): ReadonlyMap<string, WorkerState> => {
  const byFeature = new Map<string, Array<WorkerState>>();
  for (const worker of Object.values(snapshot)) {
    byFeature.set(worker.feature, [...(byFeature.get(worker.feature) ?? []), worker.state]);
  }
  return new Map([...byFeature].map(([feature, states]) => [feature, featureState(states)]));
};

/**
 * What a digest says: the ledger now against the snapshot persisted at the last acknowledged
 * digest, so wake reasons decide when a digest goes and never what is in it, and a restart loses
 * nothing. A worker gets one change: a state transition, its arrival or its going (reported as
 * `archived`, with a note, since it is no longer this orchestrator's), a changed `report.interface`
 * (contract skew; a report that leaves the interface out leaves the last one standing), a new
 * overlap, or having stopped without a word. A feature reaching review, readiness, delivery or merge
 * as a whole is a note (`featureNote`).
 *
 * That last one is why a snapshot counts turn ends: a worker that ends a turn without reporting is
 * `working` before and after, and one that did so twice looks the same both times, so a state diff
 * alone would leave the orchestrator waiting on a worker that is waiting on it. `turnEnds` is each
 * worker's count now; one that has grown since the snapshot, on a worker that is at rest and filed
 * no report, is a change. Not when the turn that ended is the one that filed its last report
 * (`turnEndsAtReport`), which the orchestrator has read already, and not for a worker the user is
 * talking to, whose turns are the user's to follow.
 *
 * `worthWaking` is false when nothing changed and no report is unacknowledged, and for noise alone:
 * a worker arriving in, or moving between, `briefed` and `working` is the orchestrator's own spawn
 * or an ordinary turn start. Parking and removing an already parked worker are housekeeping,
 * without change rows; feature notes caused by parking alone ride along on the next digest.
 * Wake reasons the ledger can't show (`wakesWithoutDiff`) are the
 * service's to add. Diffing a ledger against its own `nextSnapshot` yields nothing.
 */
export const digestDiff = (input: {
  readonly snapshot: DigestSnapshot;
  readonly ledger: { readonly features: ReadonlyArray<FeatureLedgerEntry> };
  /** Reports filed since the last acknowledged digest. */
  readonly reports: ReadonlyArray<Pick<WorkerReport, "threadId">>;
  /** Workers removed while parked, including ones archived since the last delivered snapshot. */
  readonly archivedRemovals?: ReadonlyArray<ThreadId> | undefined;
  /** By thread id, how many of each worker's turns have ended with nothing queued behind them. */
  readonly turnEnds?: Readonly<Record<string, number>> | undefined;
  /**
   * By thread id, the interface each worker's reports last stated, for one whose latest report
   * left it out; the snapshot's stands in without it.
   */
  readonly interfaces?: Readonly<Record<string, string>> | undefined;
  /** By thread id, `turnEnds` as of the stop that ended the last turn the worker reported in. */
  readonly turnEndsAtReport?: Readonly<Record<string, number>> | undefined;
  /** The workspace's level, which decides whose a merge is. */
  readonly autonomy?: Autonomy | undefined;
  /** Epoch ms from the service clock, for quiet ages. */
  readonly now?: number | undefined;
  /**
   * Features the user paused: their workers' changes and reports are still listed, and ride along
   * on the next digest something else sends, but never wake the orchestrator by themselves.
   */
  readonly paused?: ReadonlySet<string> | undefined;
}): DigestDiff => {
  const { snapshot, ledger } = input;
  const reported = new Set<string>(input.reports.map((report) => report.threadId));
  const held = (feature: string) => input.paused?.has(feature) === true;
  const heldThreads = new Set<string>(
    ledger.features.flatMap((feature) =>
      held(feature.feature) ? feature.workers.map((worker) => worker.threadId) : [],
    ),
  );
  const changes: Array<DigestChange> = [];
  const notes: Array<string> = [];
  const next: Record<string, WorkerSnapshot> = {};
  let loud = false;

  for (const feature of ledger.features) {
    const quietFeature = held(feature.feature);
    for (const worker of feature.workers) {
      const before = snapshot[worker.threadId];
      // Sticky: a report that doesn't restate the interface leaves it standing.
      const contract =
        worker.lastReport?.interface ?? input.interfaces?.[worker.threadId] ?? before?.interface;
      const turnEnds = input.turnEnds?.[worker.threadId] ?? 0;
      const quietKey =
        worker.quiet === undefined ? undefined : `${worker.quiet.kind}:${worker.quiet.at}`;
      next[worker.threadId] = {
        state: worker.state,
        feature: worker.feature,
        title: worker.title,
        ...(contract === undefined ? {} : { interface: contract }),
        overlapsWith: [...worker.overlapsWith].toSorted(),
        actionKey: actionEvidenceKey(worker),
        ...(worker.lastReport === undefined
          ? {}
          : { reportKey: reportEvidenceKey(worker.lastReport) }),
        ...(turnEnds === 0 ? {} : { turnEnds }),
        ...(quietKey === undefined ? {} : { quietKey }),
        ...(worker.worktreeMissing === true ? { worktreeMissing: true as const } : {}),
      };
      // Parking is housekeeping, even when stale quiet, interface or worktree flags remain.
      if (worker.state === "archived") continue;
      const named = { threadId: worker.threadId, feature: worker.feature, title: worker.title };
      const atReport = input.turnEndsAtReport?.[worker.threadId];
      const wentQuiet =
        !worker.userIntervened &&
        !worker.reportStands &&
        !(
          AT_REST.has(worker.status) &&
          (worker.waitingOnAutomation === true || (worker.wakes?.length ?? 0) > 0)
        ) &&
        ((worker.quiet !== undefined && quietKey !== before?.quietKey) ||
          (worker.quiet === undefined &&
            turnEnds > (before?.turnEnds ?? 0) &&
            (atReport === undefined || turnEnds > atReport) &&
            AT_REST.has(worker.status) &&
            QUIET_STATES.has(worker.state) &&
            !reported.has(worker.threadId)));
      const quietNote =
        worker.quiet === undefined
          ? WENT_QUIET
          : `went quiet mid-turn: last tool ${workText(worker.quiet.lastTool ?? "none")}, ${Math.max(0, Math.floor(((input.now ?? worker.quiet.at) - worker.quiet.at) / 60_000))} min ago (${worker.quiet.kind === "toolStalled" ? "tool still running with no streamed progress" : "ended its turn without reporting"}); read its last messages with get_thread`;
      const remarks: Array<string> = wentQuiet ? [quietNote] : [];
      const newOverlaps = worker.overlapsWith.filter(
        (id) => before === undefined || !before.overlapsWith.includes(id),
      );
      if (worker.worktreeMissing === true && before?.worktreeMissing !== true)
        remarks.push(WORKTREE_GONE);
      if (newOverlaps.length > 0) {
        const files = worker.overlapFiles ?? [];
        remarks.push(
          `advisory overlap, not a verified git conflict: changes the same files as ${newOverlaps.toSorted().join(", ")}${
            files.length === 0 ? "" : ` (${sharedPathsText(files.map(workText))})`
          }`,
        );
      }
      const actionChanged =
        before?.actionKey !== undefined && before.actionKey !== actionEvidenceKey(worker);
      if (actionChanged) {
        remarks.push(actionEvidenceText(worker));
      }
      if (before === undefined) {
        changes.push({
          ...named,
          to: worker.state,
          ...(remarks.length === 0 ? {} : { note: remarks.join("; ") }),
        });
        loud ||=
          !quietFeature &&
          (wentQuiet || worker.worktreeMissing === true || !QUIET_STATES.has(worker.state));
        continue;
      }
      if (before.interface !== undefined && contract !== before.interface) {
        remarks.push(
          "its reported interface changed; workers briefed against the old one may be out of date",
        );
      }
      if (before.state === worker.state && remarks.length === 0) continue;
      changes.push({
        ...named,
        from: before.state,
        to: worker.state,
        ...(remarks.length === 0 ? {} : { note: remarks.join("; ") }),
      });
      loud ||=
        !quietFeature &&
        (wentQuiet ||
          actionChanged ||
          worker.worktreeMissing === true ||
          contract !== before.interface ||
          (before.state !== worker.state &&
            (!QUIET_STATES.has(before.state) || !QUIET_STATES.has(worker.state))));
    }
  }

  for (const [threadId, before] of Object.entries(snapshot)) {
    if (next[threadId] !== undefined) continue;
    if (before.state === "archived" || input.archivedRemovals?.includes(threadId as ThreadId))
      continue;
    changes.push({
      threadId: threadId as ThreadId,
      feature: before.feature,
      title: before.title,
      from: before.state,
      to: "archived",
      note: "no longer your worker: it was detached or closed",
    });
    loud ||= !held(before.feature);
  }

  const previousFeatures = snapshotStates(snapshot);
  for (const feature of ledger.features) {
    const states = feature.workers.map((worker) => worker.state);
    const state = featureState(states);
    const note = featureNote(state, states, input.autonomy);
    if (note !== undefined && previousFeatures.get(feature.feature) !== state) {
      // Archiving a sibling can advance the feature too; only actionable worker changes wake.
      notes.push(`Feature ${feature.feature}: ${note}.`);
    }
  }

  return {
    changes,
    notes,
    worthWaking: loud || input.reports.some((report) => !heldThreads.has(report.threadId)),
    nextSnapshot: next,
  };
};

/**
 * The workers a digest's text can leave out (`OrchestrationDigest.quiet`): finished, and with no
 * change, report or flag since the digest the orchestrator last took, so their row would say again
 * what it has already read. Only a `digest` or `away` goes to a session that has read the rows
 * before; a `boot` or `checkpoint` starts one that hasn't, and gets them all.
 */
export const quietWorkers = (input: {
  readonly variant: DigestVariant;
  readonly groups?: ReadonlyArray<FeatureGroupLedgerEntry>;
  readonly features: ReadonlyArray<FeatureLedgerEntry>;
  readonly changes: ReadonlyArray<Pick<DigestChange, "threadId">>;
  readonly reports: ReadonlyArray<Pick<WorkerReport, "threadId">>;
}): ReadonlyArray<ThreadId> => {
  if (input.variant !== "digest" && input.variant !== "away") return [];
  const news = new Set<string>([
    ...input.changes.map((change) => change.threadId),
    ...input.reports.map((report) => report.threadId),
  ]);
  return input.features
    .filter(
      (feature) =>
        !stageHasRemainingSteps(feature.stage) &&
        !(input.groups ?? []).some(
          (group) =>
            group.features.includes(feature.feature) && stageHasRemainingSteps(group.stage),
        ),
    )
    .flatMap((feature) => feature.workers)
    .filter(
      (worker) =>
        FINISHED_STATES.has(worker.state) &&
        !workerHasOngoingWork(worker) &&
        !news.has(worker.threadId) &&
        !worker.userIntervened &&
        worker.pendingRequests.length === 0 &&
        worker.overlapsWith.length === 0 &&
        // A pending wake is a reason to keep the worker, which its row has to say.
        (worker.wakes ?? []).length === 0,
    )
    .map((worker) => worker.threadId);
};

/**
 * What waits on the user across an orchestrator and its workers, for its digest: the
 * open items counted by kind with the oldest's age, named on a `boot` (a session
 * that starts fresh, a handoff's among them, remembers none of them), and the titles the user marked
 * done since `since`, the digest the orchestrator last took. `undefined` when there is nothing to
 * say. `threads` holds each thread's items, open and resolved, oldest first. A helper's suggestion
 * isn't the user's until kept, so it is neither open nor done when dismissed or lapsed; what the
 * helper resolved from the user's own words counts as done by them.
 */
export const digestWaiting = (input: {
  readonly variant: DigestVariant;
  readonly threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly items: ReadonlyArray<WaitItem>;
  }>;
  readonly now: number;
  readonly since: number | undefined;
}): DigestWaiting | undefined => {
  const open = input.threads
    .flatMap(({ threadId, items }) => items.filter(waitIsKept).map((item) => ({ threadId, item })))
    .toSorted((a, b) => a.item.createdAt - b.item.createdAt);
  const since = input.since;
  const resolved =
    since === undefined
      ? []
      : input.threads
          .flatMap(({ items }) => items)
          .filter(
            (item) =>
              item.suggested !== true &&
              (item.resolvedBy === "user" || item.resolvedBy === "helper") &&
              item.resolvedAt !== undefined &&
              item.resolvedAt >= since,
          )
          .toSorted((a, b) => a.resolvedAt! - b.resolvedAt!)
          .map((item) => item.title);
  if (open.length === 0 && resolved.length === 0) return undefined;
  const kinds = new Map<WaitKind, number>();
  for (const { item } of open) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
  const minutes = (at: number) => Math.max(0, Math.floor((input.now - at) / 60_000));
  const oldest = open[0]?.item.createdAt;
  return {
    open: open.length,
    kinds: [...kinds].map(([kind, count]) => ({ kind, count })),
    ...(oldest === undefined ? {} : { oldestMin: minutes(oldest) }),
    ...(input.variant === "boot" && open.length > 0
      ? {
          items: open.slice(0, DIGEST_WAITING_LISTED).map(({ threadId, item }) => ({
            threadId,
            id: item.id,
            kind: item.kind,
            title: item.title,
            ageMin: minutes(item.createdAt),
          })),
        }
      : {}),
    ...(resolved.length === 0 ? {} : { resolved: resolved.slice(-DIGEST_WAITING_LISTED) }),
  };
};

/** What `interfacesRead` keeps of an interface: enough to tell the same one again. */
export const interfaceHash = (contract: string): string =>
  createHash("sha256").update(contract, "utf8").digest("base64url").slice(0, 22);

/**
 * Reports with `interfaceUnchanged` set where the interface is the one this session last read
 * from that worker (`read`, by thread id, of `interfaceHash`es) or an earlier report in the same
 * digest quoted, and what has been read once the digest is taken.
 */
export const markRepeatedInterfaces = (
  reports: ReadonlyArray<DigestReport>,
  read: Readonly<Record<string, string>>,
  maxInterfaceCharacters = Infinity,
): {
  readonly reports: ReadonlyArray<DigestReport>;
  readonly read: Readonly<Record<string, string>>;
} => {
  const next: Record<string, string> = { ...read };
  const marked = reports.map((report) => {
    if (report.interface === undefined) return report;
    const hash = interfaceHash(report.interface);
    const same = next[report.threadId] === hash;
    if (report.interface.length <= maxInterfaceCharacters) next[report.threadId] = hash;
    return same ? { ...report, interfaceUnchanged: true as const } : report;
  });
  return { reports: marked, read: next };
};

/**
 * The groups as a digest carries them: each without the features whose workers are all archived,
 * which the digest's ledger leaves out, so a finished release group doesn't list its whole history
 * on every wake. A feature with no worker yet stays. `known` is every feature, archived ones too.
 */
export const digestGroups = (
  groups: ReadonlyArray<FeatureGroupLedgerEntry>,
  known: ReadonlyArray<FeatureLedgerEntry>,
  visible: ReadonlyArray<FeatureLedgerEntry>,
): ReadonlyArray<FeatureGroupLedgerEntry> => {
  const all = new Set(known.map((feature) => feature.feature));
  const shown = new Set(visible.map((feature) => feature.feature));
  return groups
    .filter((group) => group.state !== "archived")
    .map((group) => ({
      ...group,
      features: group.features.filter((slug) => shown.has(slug) || !all.has(slug)),
    }));
};

// ---------------------------------------------------------------------------------------------
// Wake reasons
// ---------------------------------------------------------------------------------------------

/** How long a worker's request waits on the user before its orchestrator hears of it. */
export const REQUEST_PENDING_WAKE_MS = 600_000;
/** How long a worker's question waits before an orchestrator that may answer it hears of it. */
export const QUESTION_WAKE_MS = 60_000;

/**
 * How long a request of `kind` waits before it is a wake reason. At `full` autonomy a question is
 * the orchestrator's to answer (`answer_worker`), so it hears within a minute, which still leaves
 * the user the first go at it; everything else is the user's alone and keeps the ten minutes.
 */
export const requestWakeMs = (kind: string, autonomy: Autonomy | undefined): number =>
  kind === "question" && autonomy === "full" ? QUESTION_WAKE_MS : REQUEST_PENDING_WAKE_MS;

/** A PR badge reduced to what a wake turns on. */
export interface PrMark {
  readonly state: "open" | "merged" | "closed";
  readonly checks: ChecksRollup;
  readonly verdictOnHead?: "approved" | "changesRequested" | undefined;
  readonly mergeState?: string | undefined;
}

/** Something the service saw happen to a worker, or to the workspace. `worker` is the thread's title. */
export type WakeEvent =
  | { readonly type: "turnEnded"; readonly worker: string; readonly queueEmpty: boolean }
  | { readonly type: "report"; readonly worker: string; readonly state: WorkerReportState }
  | { readonly type: "completed"; readonly worker: string }
  | {
      readonly type: "workerRemoved";
      readonly worker: string;
      readonly action: "closed" | "detached" | "moved";
      readonly parked: boolean;
    }
  | {
      readonly type: "requestPending";
      readonly worker: string;
      /** `approval`, `question` or `plan`. */
      readonly kind: string;
      readonly pendingMs: number;
      /** The workspace's level, which decides how soon a question is worth a wake; absent reads as not `full`. */
      readonly autonomy?: Autonomy | undefined;
    }
  | {
      readonly type: "workerError";
      readonly worker: string;
      /** How it failed (`Thread.lastError`); absent when the thread recorded nothing. */
      readonly error?: WorkerError | undefined;
    }
  | {
      readonly type: "pr";
      readonly worker: string;
      readonly previous: PrMark | undefined;
      readonly current: PrMark | undefined;
    }
  | {
      readonly type: "overlap";
      readonly worker: string;
      readonly other: string;
      /** The paths they share, sorted. */
      readonly files?: ReadonlyArray<string> | undefined;
    }
  | { readonly type: "worktreeMissing"; readonly worker: string }
  | {
      readonly type: "dependencyDrags";
      readonly worker: string;
      /** `owner/repo#N` of the PR the worker's depends on. */
      readonly dependency: string;
      /** What drags, in the ledger's words. */
      readonly why: string;
    }
  | { readonly type: "paused"; readonly reason: PauseReason };

// Titles can be an agent's own words (`set_title`), and `serializeDigest` prints reasons as they
// are, so a title is flattened to one short line that can't open a tag before it goes into one.
const flatten = (text: string): string =>
  text.replaceAll(/\s+/g, " ").trim().replaceAll("<", "‹").replaceAll(">", "›");

const label = (title: string): string => {
  const flat = flatten(title);
  return `"${flat.length <= 60 ? flat : `${flat.slice(0, 60)}…`}"`;
};

const prReason = (
  previous: PrMark | undefined,
  current: PrMark | undefined,
): string | undefined => {
  if (current === undefined) return undefined;
  if (previous === undefined || current.state !== previous.state) {
    if (current.state === "merged") return "pull request merged";
    if (current.state === "closed") return "pull request closed";
    return previous === undefined ? "pull request opened" : "pull request reopened";
  }
  if (current.state !== "open") return undefined;
  if (current.mergeState === "DIRTY" && previous.mergeState !== "DIRTY")
    return "verified git conflict with base; worker must resolve it";
  if (current.verdictOnHead !== undefined && current.verdictOnHead !== previous.verdictOnHead) {
    return current.verdictOnHead === "approved"
      ? "review approved the head commit"
      : "review requested changes on the head commit";
  }
  if (previous.checks === "pending" && current.checks !== "pending") {
    return current.checks === "failing" ? "checks failed" : "checks passed";
  }
  return undefined;
};

/**
 * The reason an observation wakes the orchestrator, as `OrchestrationDigest.reasons` words it, or
 * `undefined` when it doesn't: a turn ending with input still queued, a request pending
 * no longer than `requestWakeMs`, and a PR badge that moved in no way the orchestrator acts on. Status flips,
 * streaming, queue changes and a worker's review rounds are not events at all.
 */
export const wakeWorthy = (event: WakeEvent): string | undefined => {
  switch (event.type) {
    case "turnEnded":
      return event.queueEmpty ? `${label(event.worker)} finished a turn` : undefined;
    case "report":
      return `${label(event.worker)} reported ${event.state}`;
    case "completed":
      return `${label(event.worker)} was marked completed`;
    case "workerRemoved":
      return event.parked ? undefined : `a worker was ${event.action}`;
    case "requestPending": {
      if (event.pendingMs <= requestWakeMs(event.kind, event.autonomy)) return undefined;
      const minutes = Math.floor(event.pendingMs / 60_000);
      return event.kind === "question" && event.autonomy === "full"
        ? `${label(event.worker)} has had a question open for ${minutes} min; answer_worker can answer it`
        : `${label(event.worker)} has waited ${minutes} min on the user (${event.kind.replaceAll(/[^a-z]/gi, "")})`;
    }
    case "workerError": {
      if (event.error === undefined) return `${label(event.worker)} is in error`;
      const status =
        event.error.httpStatus === undefined ? "" : ` (HTTP ${event.error.httpStatus})`;
      // Our own sentence, but an unclassified one quotes the API's message, so it is flattened too.
      return `${label(event.worker)} is in error, ${event.error.kind}${status}: "${flatten(event.error.text)}"`;
    }
    case "pr": {
      const reason = prReason(event.previous, event.current);
      return reason === undefined ? undefined : `${label(event.worker)}: ${reason}`;
    }
    case "overlap":
      return undefined; // Advisory changed paths alone are not a coordination blocker.
    case "worktreeMissing":
      return `${label(event.worker)} lost its worktree, deleted outside Gram`;
    case "dependencyDrags":
      return `${label(event.worker)}: ${flatten(event.dependency)}, which its PR depends on, drags on (${flatten(event.why)}); stacking on its branch may beat waiting`;
    case "paused":
      return `orchestration paused (${event.reason})`;
  }
};

/** The most of one `Woken by:` entry `serializeDigest` keeps; the rest is clipped. */
export const WAKE_ENTRY_MAX = 200;

/** A wake reason as the service keeps it until a digest carries it. */
export interface PendingReason {
  /** `wakeWorthy`'s words, or the service's own. */
  readonly reason: string;
  /** `WakeEvent.worker`, for a reason about one worker. */
  readonly worker?: string | undefined;
  readonly type?: WakeEvent["type"] | undefined;
}

/**
 * `Woken by:` as the orchestrator reads it: one entry per worker, its reasons after its name in the
 * order they came (`"Mail": reported progress; finished a turn`), and no "was marked completed"
 * beside the "pull request merged" that marked it. A reason about no one stands alone.
 */
export const coalesceReasons = (pending: ReadonlyArray<PendingReason>): ReadonlyArray<string> => {
  const merged = new Set(
    pending
      .filter((each) => each.type === "pr" && each.reason.endsWith(": pull request merged"))
      .map((each) => each.worker),
  );
  const kept = pending.filter(
    (each) => !(each.type === "completed" && each.worker !== undefined && merged.has(each.worker)),
  );
  const byWorker = new Map<string, Array<string>>();
  const order: Array<{ readonly worker?: string; readonly reason?: string }> = [];
  for (const each of kept) {
    if (each.worker === undefined) {
      order.push({ reason: each.reason });
      continue;
    }
    const said = byWorker.get(each.worker);
    if (said === undefined) {
      byWorker.set(each.worker, [each.reason]);
      order.push({ worker: each.worker });
    } else said.push(each.reason);
  }
  return order.flatMap(({ worker, reason }) => {
    if (worker === undefined) return [reason!];
    const said = byWorker.get(worker)!;
    if (said.length === 1) return said;
    const name = label(worker);
    const rest = said.map((each) =>
      each.startsWith(name) ? each.slice(name.length).replace(/^:? /, "") : each,
    );
    // `Woken by:` joins entries with commas, so one worker's own are kept apart by semicolons, and
    // an entry that would run past what `serializeDigest` keeps of one goes on in a second.
    const entries: Array<string> = [];
    let entry = `${name}:`;
    for (const each of rest) {
      const longer = `${entry}${entry.endsWith(":") ? " " : "; "}${each}`;
      if (longer.length > WAKE_ENTRY_MAX && !entry.endsWith(":")) {
        entries.push(entry);
        entry = `${name}: ${each}`;
      } else entry = longer;
    }
    entries.push(entry);
    return entries;
  });
};

/**
 * Wake events whose cause a ledger diff may not show, so the service wakes on them even when
 * `digestDiff` alone says `worthWaking: false`: a request that has merely grown old and a pause
 * change no worker's state. A live worker removed before the snapshot knew it was live still
 * needs attention, even if it was spawned or unparked since that snapshot.
 */
export const wakesWithoutDiff = (event: WakeEvent): boolean =>
  event.type === "requestPending" ||
  event.type === "dependencyDrags" ||
  event.type === "paused" ||
  (event.type === "workerRemoved" && !event.parked);

// ---------------------------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------------------------

/** How many workers a housekeeping note names before it counts the rest. */
const TIDY_NAMED = 5;

const named = (labels: ReadonlyArray<string>): string =>
  labels.length <= TIDY_NAMED
    ? labels.join(", ")
    : `${labels.slice(0, TIDY_NAMED).join(", ")} and ${labels.length - TIDY_NAMED} more`;

/** Whether a stage reads as unfinished: a free label, or a plan's step short of its last. */
const stageShort = (stage: FeatureStage | undefined): stage is FeatureStage =>
  stage !== undefined && (stage.plan === undefined || stage.stage !== stage.plan.at(-1));

/**
 * What is left over on the board, as notes for a digest that goes anyway, each said once while
 * it stays true: workers of merged or delivered work that reported done and wait on nothing, a
 * merged feature or group whose stage reads as unfinished, and a group whose every worker is
 * archived. `noted` is the conditions the last acknowledged digest had seen, as keys; one that has
 * stopped holding drops out, so it is said again if it comes back. A note never wakes anyone.
 *
 * A worker of a feature that is becoming `merged` in this very digest is left unnamed, since the
 * feature's own note already says to archive its workers.
 */
export const tidyNotes = (input: {
  readonly snapshot: DigestSnapshot;
  readonly features: ReadonlyArray<FeatureLedgerEntry>;
  readonly groups: ReadonlyArray<FeatureGroupLedgerEntry>;
  readonly noted: ReadonlyArray<string>;
}): { readonly notes: ReadonlyArray<string>; readonly noted: ReadonlyArray<string> } => {
  const before = new Set(input.noted);
  const now: Array<string> = [];
  const fresh = (key: string): boolean => {
    now.push(key);
    return !before.has(key);
  };
  const notes: Array<string> = [];

  const previous = snapshotStates(input.snapshot);
  const idle = input.features.flatMap((feature) =>
    feature.workers.filter(
      (worker) =>
        (worker.state === "merged" || worker.state === "delivered") &&
        worker.lastReport?.state === "done" &&
        AT_REST.has(worker.status) &&
        worker.pendingRequests.length === 0 &&
        !workerHasOngoingWork(worker) &&
        !stageHasRemainingSteps(feature.stage) &&
        !input.groups.some(
          (group) =>
            group.features.includes(feature.feature) && stageHasRemainingSteps(group.stage),
        ),
    ),
  );
  const saidByFeature = new Set(
    input.features
      .filter((feature) => feature.state === "merged" && previous.get(feature.feature) !== "merged")
      .map((feature) => feature.feature),
  );
  const newIdle = idle.filter(
    (worker) => fresh(`archive:${worker.threadId}`) && !saidByFeature.has(worker.feature),
  );
  if (newIdle.length > 0) {
    const states = new Set(newIdle.map((worker) => worker.state));
    const how = states.size === 2 ? "merged or delivered" : [...states][0]!;
    const older = idle.length - newIdle.length;
    const more = older === 0 ? "" : " more";
    notes.push(
      `Housekeeping: ${newIdle.length === 1 ? `1${more} worker is` : `${newIdle.length}${more} workers are`} ${how}, reported done and not archived (${named(newIdle.map((worker) => label(worker.title)))})${older === 0 ? "" : `, beside the ${older} already noted`}. Archive them with \`archive_thread\` unless one still waits on something, a timer or a next pull request.`,
    );
  }

  const behind = [
    ...input.groups.map(({ group, state, stage }) => ({
      key: `stage:group:${group}`,
      what: `group ${group}`,
      state,
      stage,
    })),
    ...input.features.map(({ feature, state, stage }) => ({
      key: `stage:feature:${feature}`,
      what: `feature ${feature}`,
      state,
      stage,
    })),
  ].filter((target) => target.state === "merged" && stageHasRemainingSteps(target.stage));
  const newBehind = behind.filter(({ key }) => fresh(key));
  if (newBehind.length > 0) {
    const at = newBehind.map(({ what, stage }) => `${what} at ${label(stage!.stage)}`);
    notes.push(
      `Process remains explicitly staged after PR merge: ${at.join(", ")}. Check the recorded stage and its owner; merging a PR does not complete that process. Preserve user-set stages until the user or actual progress changes them.`,
    );
  }

  const known = new Set(input.features.map((feature) => feature.feature));
  // A stage at its plan's last step, or a free label, says where the group ended.
  const empty = input.groups.filter(
    (group) =>
      group.state === "archived" &&
      group.features.some((slug) => known.has(slug)) &&
      (group.stage === undefined || (group.stage.plan !== undefined && stageShort(group.stage))),
  );
  const newEmpty = empty.filter((group) => fresh(`empty:${group.group}`));
  if (newEmpty.length > 0) {
    notes.push(
      `Housekeeping: ${newEmpty.length} archived groups have no live features left and no final stage recorded. Query list_workers({includeArchived: true}) to review their stages, then use set_stage or set_group.`,
    );
  }

  return { notes, noted: now.toSorted() };
};

// ---------------------------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------------------------

/** How full an orchestrator's context is, in percent, when its digest says so. */
export const CONTEXT_NOTE_PCT = 90;

/**
 * The digest's context note, once per crossing of `CONTEXT_NOTE_PCT`, and whether it has been
 * given for this crossing. `noted` is what was known before; a reading below the threshold (a
 * compaction, a fresh session) clears it, and no reading leaves it as it was. The agent compacts
 * by itself, so the note asks only that memory be up to date.
 */
export const contextNote = (
  contextPct: number | undefined,
  noted: boolean,
): { readonly note: string | undefined; readonly noted: boolean } => {
  if (contextPct === undefined) return { note: undefined, noted };
  if (contextPct < CONTEXT_NOTE_PCT) return { note: undefined, noted: false };
  if (noted) return { note: undefined, noted };
  return {
    note: `Your context is ${contextPct} % full; write anything unsaved to memory.`,
    noted: true,
  };
};

/** Background work as a restart names it; `outbox.ts`'s `BackgroundWork`. */
type BackgroundWork = Pick<BackgroundTask, "kind" | "description" | "command" | "subagentType">;

/** How many pieces of stopped background work a restart names before it counts the rest. */
export const RESTART_WORK_NAMED = 5;

/**
 * An agent's words about its background work, made safe to sit in a server note: one line, no
 * markup that could pass for a tag, no backticks to break out of the quoting, secrets redacted.
 */
const workText = (text: string): string => {
  const line = redactText(text)
    .replaceAll(/\s+/g, " ")
    .trim()
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replaceAll("`", "'")
    .replaceAll("“", '"')
    .replaceAll("”", '"');
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};

const workLabel = (work: BackgroundWork): string => {
  const shown = workText(work.command ?? work.description);
  switch (work.kind) {
    case "shell":
      return `shell \`${shown}\``;
    case "subagent":
      return `${workText(work.subagentType ?? "")} subagent “${shown}”`.trimStart();
    default:
      return `${work.kind} “${shown}”`;
  }
};

const workList = (lost: ReadonlyArray<BackgroundWork>): string => {
  const shown = lost.slice(0, RESTART_WORK_NAMED).map(workLabel);
  const rest = lost.length - shown.length;
  return `${shown.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}`;
};

/** What the last restart cost one worker, for `restartNote`. */
export interface RestartCost {
  readonly title: string;
  readonly threadId: ThreadId;
  /** Its turn was open when the process died. */
  readonly cutOff: boolean;
  readonly lost: ReadonlyArray<BackgroundWork>;
  /** Gram asked it to continue (`restartContinuation`). */
  readonly continued: boolean;
}

/**
 * The away digest's one note on what the last restart cost the workspace's workers (T3's
 * `RestartBackgroundNote`): every worker cut off mid-turn, which its ledger state still reads as
 * `working` though nothing runs, and the background work that stopped with the process. One note
 * names them all, so no worker drops off the end of the notes. `undefined` when it cost nothing.
 */
export const restartNote = (costs: ReadonlyArray<RestartCost>): string | undefined => {
  const who = (cost: RestartCost) => `“${workText(cost.title)}” [thread ${cost.threadId}]`;
  const cut = costs.filter((cost) => cost.cutOff);
  const stopped = costs.filter((cost) => cost.lost.length > 0);
  if (cut.length === 0 && stopped.length === 0) return undefined;
  const parts: Array<string> = [];
  if (cut.length > 0) {
    const listed = cut.map(
      (cost) =>
        `${who(cost)} (${cost.continued ? "asked to continue where it left off" : "idle until messaged"})`,
    );
    parts.push(
      `A restart cut ${cut.length === 1 ? "this worker" : `these ${cut.length} workers`} off mid-turn, so ${cut.length === 1 ? "it isn't" : "none is"} working now whatever the ledger says: ${listed.join(", ")}.`,
    );
  }
  if (stopped.length > 0) {
    parts.push(
      `${cut.length > 0 ? "It also stopped" : "A restart stopped"} background work, as the agents described it: ${stopped.map((cost) => `${who(cost)}: ${workList(cost.lost)}`).join("; ")}. Message a worker that was waiting on it.`,
    );
  }
  return parts.join(" ");
};

/** What a worker the restart cut off is sent to pick up again, when the user has that on. */
export const restartContinuation = (lost: ReadonlyArray<BackgroundWork>): string =>
  `Gram restarted while your turn was running, and that cut it off. Continue where you left off, after checking what state your work was left in. The PR monitors you turned on are still on, and tell you of anything that settled while it was down.${
    lost.length === 0
      ? ""
      : ` The restart also stopped your background work (${workList(lost)}); start again what you still need.`
  }`;

// ---------------------------------------------------------------------------------------------
// Scheduled wakes
// ---------------------------------------------------------------------------------------------

/** An ISO 8601 date and time that says its zone: `Z` or an offset. */
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * When a `schedule_wake` is due, from exactly one of `at` (an ISO 8601 time with its zone) and
 * `inMinutes`, or why it can't be set: a time that has passed, one more than `WAKE_MAX_MINUTES`
 * ahead, or a string that isn't a time.
 */
export const wakeDueAt = (
  input: { readonly at?: string | undefined; readonly inMinutes?: number | undefined },
  now: number,
): { readonly ok: true; readonly at: number } | { readonly ok: false; readonly reason: string } => {
  if ((input.at === undefined) === (input.inMinutes === undefined)) {
    return { ok: false, reason: "Pass exactly one of `at` and `inMinutes`." };
  }
  // `Date.parse` reads a time without a zone as the server's local one, which the caller never said.
  const zoned = input.at === undefined || ZONED_TIME.test(input.at.trim());
  const at =
    input.inMinutes !== undefined
      ? now + input.inMinutes * 60_000
      : zoned
        ? Date.parse(input.at ?? "")
        : Number.NaN;
  if (!Number.isFinite(at)) {
    return {
      ok: false,
      reason: `\`at\` must be an ISO 8601 time with its zone, such as 2026-10-01T14:30:00Z; got "${input.at}".`,
    };
  }
  if (at <= now)
    return { ok: false, reason: "That time has passed; a wake must be in the future." };
  if (at - now > WAKE_MAX_MINUTES * 60_000) {
    return {
      ok: false,
      reason: `A wake can be set at most ${WAKE_MAX_MINUTES / 1440} days ahead.`,
    };
  }
  return { ok: true, at };
};

/**
 * `wakeDueAt` for a wake that may wait on a PR: with `onPr`, its time is the fallback, and without
 * one it falls back after the furthest a wake may be set, so none waits forever.
 */
export const prWakeDueAt = (
  input: {
    readonly at?: string | undefined;
    readonly inMinutes?: number | undefined;
    readonly onPr?: PrRef | undefined;
  },
  now: number,
): ReturnType<typeof wakeDueAt> =>
  input.onPr !== undefined && input.at === undefined && input.inMinutes === undefined
    ? { ok: true, at: now + WAKE_MAX_MINUTES * 60_000 }
    : wakeDueAt(input, now);

/** What a worker is sent when a wake it set falls due. */
export const wakeDueText = (wake: { readonly note: string; readonly setAt: number }): string =>
  `The wake you set with schedule_wake at ${new Date(wake.setAt).toISOString().slice(0, 16)}Z is due. Your note: ${wake.note}`;

/** What an orchestrator's digest notes when a wake it set falls due, or fired on its PR's event. */
export const orchestratorWakeNote = (wake: {
  readonly note: string;
  readonly setAt: number;
  readonly onPr?: PrRef | undefined;
  readonly on?: ReadonlyArray<PrWakeEvent> | undefined;
  readonly fired?: PrWakeFired | undefined;
}) => {
  const set = `A wake you set with schedule_wake at ${minuteOf(wake.setAt)}Z`;
  const note = `Your note: ${wake.note.replaceAll(/\s+/g, " ").trim()}`;
  if (wake.onPr === undefined) return `${set} is due. ${note}`;
  const pr = prRefText(wake.onPr);
  if (wake.fired === undefined) return `${set} on ${pr} is due: ${timedOutWords(wake)}. ${note}`;
  const head = wake.fired.head === undefined ? "" : ` (head ${wake.fired.head})`;
  return `${set} fired: ${pr} ${firedWords(wake.fired)}${head}. ${note}`;
};

// ---------------------------------------------------------------------------------------------
// Wakes on another PR's events, and declared dependencies
// ---------------------------------------------------------------------------------------------

/** `HH:MM` of an epoch ms in UTC, with its date: `2026-10-09T14:30`. */
const minuteOf = (at: number): string => new Date(at).toISOString().slice(0, 16);

export type { PrWakeFired };

/**
 * What a watch reads of a badge. A badge that didn't read the reviews says nothing of the verdict,
 * so `reviewed` is left off and `verdict` with it.
 */
export const prWatchSeenOf = (badge: PrStatus): PrWatchSeen => {
  const verdict = badge.review?.verdictOnHead;
  return {
    state: badge.state === "MERGED" ? "merged" : badge.state === "CLOSED" ? "closed" : "open",
    ...(badge.headRefOid === undefined ? {} : { head: badge.headRefOid }),
    checks: requiredChecksOf(badge),
    ...(badge.reviewUnread === true
      ? {}
      : { reviewed: true as const, ...(verdict === undefined ? {} : { verdict }) }),
  };
};

/**
 * What a watch keeps once it has seen `badge` after `seen`: the badge's facts. One that didn't read
 * the reviews keeps the verdict `seen` had of the same head; of a head that moved since, it keeps
 * that none had been seen, since any verdict on it is newer than the watch.
 */
export const nextPrWatchSeen = (seen: PrWatchSeen | undefined, badge: PrStatus): PrWatchSeen => {
  const now = prWatchSeenOf(badge);
  if (now.reviewed === true || seen === undefined) return now;
  if (seen.head !== now.head) return { ...now, reviewed: true };
  if (seen.reviewed !== true) return now;
  return {
    ...now,
    reviewed: true,
    ...(seen.verdict === undefined ? {} : { verdict: seen.verdict }),
  };
};

/**
 * The first of `on` (in `PrWakeEvent`'s order) that `badge` shows has happened since `seen`, or
 * `undefined`. Without `seen` the badge is the baseline, except that a PR already merged or closed
 * fires a wake waiting on that at once. A stale badge (carried over failed lookups) says nothing.
 */
export const prWakeEventOf = (
  seen: PrWatchSeen | undefined,
  badge: PrStatus,
  on: ReadonlyArray<PrWakeEvent>,
): PrWakeFired | undefined => {
  if (badge.stale !== undefined) return undefined;
  const now = prWatchSeenOf(badge);
  const fired = (event: PrWakeEvent): PrWakeFired => ({
    event,
    ...(now.head === undefined ? {} : { head: now.head }),
    ...(now.checks === undefined ? {} : { checks: now.checks }),
    ...(now.verdict === undefined ? {} : { verdict: now.verdict }),
  });
  const moved = seen?.head !== undefined && now.head !== undefined && now.head !== seen.head;
  const happened: Record<PrWakeEvent, boolean> = {
    merged: now.state === "merged" && seen?.state !== "merged",
    closed: now.state === "closed" && seen?.state !== "closed",
    headChanged: seen !== undefined && moved,
    checksSettled:
      seen !== undefined &&
      now.state === "open" &&
      (now.checks === "passing" || now.checks === "failing") &&
      (seen.checks === "pending" || moved),
    // A verdict on a head newer than the look before is new; on the same head, only a look that
    // read the reviews then can say it changed.
    verdict:
      seen !== undefined &&
      now.reviewed === true &&
      now.verdict !== undefined &&
      (moved || (seen.reviewed === true && now.verdict !== seen.verdict)),
  };
  const event = PrWakeEvents.literals.find((each) => on.includes(each) && happened[each]);
  return event === undefined ? undefined : fired(event);
};

/** "merged", "got a new push": a fired event as the notice says it. */
const firedWords = (fired: PrWakeFired): string => {
  switch (fired.event) {
    case "merged":
      return "merged";
    case "closed":
      return "was closed without merging";
    case "headChanged":
      return "got a new push";
    case "checksSettled":
      return `had its checks settle: ${fired.checks ?? "settled"}`;
    case "verdict":
      return fired.verdict === "changesRequested"
        ? "got the review bot's verdict: changes requested"
        : "got the review bot's verdict: approved";
  }
};

/** The fenced block a PR event's notice carries, for the agent to read the facts from. */
const prEventBlock = (pr: PrRef, fired: PrWakeFired): string =>
  [
    "```pr-event",
    `pr: ${prRefText(pr)}`,
    `event: ${fired.event}`,
    ...(fired.head === undefined ? [] : [`head: ${fired.head}`]),
    ...(fired.checks === undefined ? [] : [`checks: ${fired.checks}`]),
    ...(fired.verdict === undefined ? [] : [`verdict: ${fired.verdict}`]),
    "```",
  ].join("\n");

const timedOutWords = (wake: {
  readonly onPr?: PrRef | undefined;
  readonly on?: ReadonlyArray<PrWakeEvent> | undefined;
}): string =>
  wake.onPr === undefined
    ? "due"
    : `nothing it waited for happened by then (${prWakeWhen(wake.onPr, wake.on ?? [])})`;

/**
 * What a thread is sent when a wake it set on another PR fires: the event, with its head in a
 * fenced block, or, from its time alone, that none of its events happened.
 */
export const prWakeText = (
  wake: {
    readonly note: string;
    readonly setAt: number;
    readonly onPr: PrRef;
    readonly on?: ReadonlyArray<PrWakeEvent> | undefined;
  },
  fired: PrWakeFired | undefined,
): string => {
  const set = `The wake you set with schedule_wake at ${minuteOf(wake.setAt)}Z on ${prRefText(wake.onPr)}`;
  if (fired === undefined) {
    return `${set} is due: ${timedOutWords(wake)}. Your note: ${wake.note}`;
  }
  return `${set} fired: it ${firedWords(fired)}.\n${prEventBlock(wake.onPr, fired)}\nYour note: ${wake.note}`;
};

/**
 * Why a dependency drags on, in words, or `undefined` while it doesn't: the dependent PR has
 * conflicted with its base for `DEPENDENCY_DRAG_CONFLICT_MIN` minutes, or the dependency is past
 * `DEPENDENCY_DRAG_ROUNDS` review rounds.
 */
export const dependencyDragWhy = (
  conflictedMin: number | undefined,
  rounds: number | undefined,
): string | undefined => {
  const why = [
    ...(conflictedMin !== undefined && conflictedMin >= DEPENDENCY_DRAG_CONFLICT_MIN
      ? [`conflicted with its base for ${conflictedMin} min`]
      : []),
    ...(rounds !== undefined && rounds > DEPENDENCY_DRAG_ROUNDS
      ? [`the dependency is at review round ${rounds}`]
      : []),
  ];
  return why.length === 0 ? undefined : why.join("; ");
};

/** The events a declared dependency wakes its dependent's thread on. */
export const DEPENDENCY_EVENTS: ReadonlyArray<PrWakeEvent> = ["merged", "closed", "headChanged"];

/** What a thread is sent when a PR its own depends on (`depends_on`) merges, closes or moves. */
export const dependencyWakeText = (
  dependent: PrRef,
  dependency: PrRef,
  fired: PrWakeFired,
): string => {
  const advice =
    fired.event === "merged"
      ? `Bring #${dependent.number} up to date with its base (rebase, or retarget it to the base if it was stacked on #${dependency.number}'s branch) and carry on; merge_when_ready no longer waits for it.`
      : fired.event === "closed"
        ? `It won't merge as it is: decide whether #${dependent.number} still needs it, and drop it with depends_on remove: true if not.`
        : `If #${dependent.number} is stacked on its branch, rebase onto the new head.`;
  return `${prRefText(dependency)}, which your ${prRefText(dependent)} depends on, ${firedWords(fired)}.\n${prEventBlock(dependency, fired)}\n${advice}`;
};

// ---------------------------------------------------------------------------------------------
// Features and their branches
// ---------------------------------------------------------------------------------------------

/** The longest feature slug `spawn_worker` takes. */
const FEATURE_SLUG_MAX = 48;

/**
 * `spawn_worker`'s `feature` argument as a slug of `[a-z0-9-]`, 1 to 48 characters, or `undefined`
 * when nothing usable is left or it is too long. Lower-cased, every other run of characters becomes
 * one `-`, and a leading `feat/` is dropped, since agents often pass the branch they have in mind.
 */
export const featureSlug = (raw: string): string | undefined => {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/^feat\//, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug === "" || slug.length > FEATURE_SLUG_MAX ? undefined : slug;
};

/** The most words of the user's first line a task's feature is named from. */
const TASK_FEATURE_WORDS = 5;

/**
 * The feature a worker the user started from their own words (New task, straight to a worker)
 * joins: the first line's first few words as a slug, cut at a word to leave room for a number, and
 * numbered past the features `taken` already, so it is a feature of its own on a branch of its own.
 * `task` when the words make no slug.
 */
export const taskFeature = (text: string, taken: ReadonlySet<string>): string => {
  const line = text.split("\n").find((each) => each.trim() !== "") ?? "";
  const words = line
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
  let base = "";
  for (const word of words.slice(0, TASK_FEATURE_WORDS)) {
    const next = base === "" ? word : `${base}-${word}`;
    if (next.length > FEATURE_SLUG_MAX - 3) break;
    base = next;
  }
  if (base === "") base = words[0]?.slice(0, FEATURE_SLUG_MAX - 3) || "task";
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
};

/**
 * A feature's branch, the same name in every repo it touches: `feat/<slug>`, or
 * `undefined` for a feature `featureSlug` refuses. A slug is within what `@gram/git`'s
 * `isValidGitRefCharset` lets into git argv (ASCII alphanumerics and `-`, no leading `-`), so that
 * package isn't imported here for a check that can't fail.
 */
export const featureBranch = (feature: string): string | undefined => {
  const slug = featureSlug(feature);
  return slug === undefined ? undefined : `feat/${slug}`;
};

// ---------------------------------------------------------------------------------------------
// Joining a workspace
// ---------------------------------------------------------------------------------------------

/** What `joinRefusal` reads of the thread that would join. */
export interface JoiningThread {
  readonly id: ThreadId;
  readonly role?: ThreadRole | undefined;
  readonly workspaceId?: WorkspaceId | undefined;
  readonly spawnedBy?: SpawnedBy | undefined;
  readonly model: Pick<ModelRef, "agent">;
  readonly checkout: { readonly kind: "main" | "worktree" };
}

/**
 * Why `thread` can't become a worker of `holder`, the orchestrator holding `workspaceId`'s slot,
 * or `undefined` when it can. An orchestrator or a dream never joins, a worker already its
 * own needn't, an agent kind not admitted as a worker can't, and a thread outside any repo, or in a
 * repo's main checkout, has no worktree of its own to be a worker in: the main checkout is where the
 * orchestrator's own edits are measured. `relocating` names the worktree it moves into.
 */
export const joinRefusal = (input: {
  readonly thread: JoiningThread;
  readonly holder: ThreadId;
  readonly workspaceId: WorkspaceId;
  readonly inRepo: boolean;
  readonly relocating: boolean;
}): string | undefined => {
  const { thread } = input;
  if (thread.role === "orchestrator" || thread.id === input.holder) {
    return "An orchestrator can't be added to a workspace or moved between them: it is its workspace's for as long as it lives. Close it and open one where it's wanted.";
  }
  if (thread.role === "dream")
    return "A memory dream belongs to its workspace and can't join another.";
  if (thread.spawnedBy?.threadId === input.holder && thread.workspaceId === input.workspaceId) {
    return "It is already a worker of this workspace.";
  }
  if (!admittedForRole(thread.model.agent, "worker")) {
    return `It runs on ${thread.model.agent}, which isn't admitted as a worker.`;
  }
  if (input.relocating) return undefined;
  if (!input.inRepo) return "It isn't in a git repository, so it can't be a worker.";
  if (thread.checkout.kind !== "worktree") {
    return "It works in the repo's main checkout. A worker works in a worktree of its own: move it into one first (move_to_worktree), or name the worktree it works in.";
  }
  return undefined;
};

/** The default branches a feature is never named after. */
const BASE_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

/**
 * The feature a thread joining a workspace goes under: the one asked for, as a slug; else the
 * feature of a worker already on its branch, so a sibling's change stays one feature; else its
 * branch without the conventional prefix (`fix/reopen-tabs` → `reopen-tabs`), numbered past a
 * feature of that name on another branch; else, on a base branch or none, its title as a new task's
 * feature is named. `undefined` only for an asked-for name `featureSlug` refuses.
 */
export const joinedFeature = (input: {
  readonly requested?: string | undefined;
  readonly branch?: string | undefined;
  readonly title: string;
  /** The workspace's workers now, each by feature and branch. */
  readonly workers: ReadonlyArray<{
    readonly feature: string;
    readonly branch?: string | undefined;
  }>;
}): string | undefined => {
  if (input.requested !== undefined) return featureSlug(input.requested);
  const taken = new Set(input.workers.map((worker) => worker.feature));
  const branch = input.branch?.trim();
  if (branch !== undefined && branch !== "" && !BASE_BRANCHES.has(branch)) {
    const sibling = input.workers.find((worker) => worker.branch === branch);
    if (sibling !== undefined) return sibling.feature;
    const base = featureSlug(branch.replace(/^[a-z]+\//i, "").slice(0, FEATURE_SLUG_MAX - 3));
    if (base !== undefined) {
      let slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
      return slug;
    }
  }
  return taskFeature(input.title, taken);
};

// ---------------------------------------------------------------------------------------------
// Stages and groups
// ---------------------------------------------------------------------------------------------

export type StageVerdict =
  | { readonly ok: true; readonly stage: FeatureStage }
  | { readonly ok: false; readonly code: "invalid_stage"; readonly reason: string };

const stageRefused = (reason: string): StageVerdict => ({
  ok: false,
  code: "invalid_stage",
  reason,
});

/**
 * The stage to store for a `set_stage` call or the user's click, or why not. Names are trimmed,
 * 1 to `FEATURE_STAGE_MAX` characters; a plan is de-duplicated and holds at most
 * `FEATURE_PLAN_MAX_STAGES` of them, and `stage` must be one of it. Without a `plan` the target
 * keeps the plan it has and `stage` must be one of that, so advancing is a one-field call; an empty
 * `plan` drops the plan and leaves a free label. A note longer than `FEATURE_STAGE_NOTE_MAX` is
 * refused rather than cut, so what is stored is what was said.
 */
export const stageUpdate = (input: {
  readonly current: FeatureStage | undefined;
  readonly stage: string;
  readonly plan?: ReadonlyArray<string> | undefined;
  readonly note?: string | undefined;
  readonly setBy: FeatureStage["setBy"];
  readonly now: number;
}): StageVerdict => {
  const stage = input.stage.trim();
  const given =
    input.plan === undefined ? undefined : [...new Set(input.plan.map((s) => s.trim()))];
  const names = [stage, ...(given ?? [])];
  if (names.some((name) => name === "")) return stageRefused("A stage needs a name.");
  const long = names.find((name) => name.length > FEATURE_STAGE_MAX);
  if (long !== undefined) {
    return stageRefused(
      `"${long.slice(0, FEATURE_STAGE_MAX)}…" is too long; a stage's name is at most ${FEATURE_STAGE_MAX} characters.`,
    );
  }
  if (given !== undefined && given.length > FEATURE_PLAN_MAX_STAGES) {
    return stageRefused(
      `A plan has at most ${FEATURE_PLAN_MAX_STAGES} stages; this one has ${given.length}. Keep it to the steps worth showing.`,
    );
  }
  const plan = given === undefined ? input.current?.plan : given.length === 0 ? undefined : given;
  if (plan !== undefined && !plan.includes(stage)) {
    return stageRefused(
      given === undefined
        ? `"${stage}" isn't in this plan (${plan.join(" → ")}). Name one of those, or pass a new plan.`
        : `"${stage}" isn't one of the plan you passed (${plan.join(" → ")}).`,
    );
  }
  const note = input.note?.trim();
  if (note !== undefined && note.length > FEATURE_STAGE_NOTE_MAX) {
    return stageRefused(
      `A stage's note is at most ${FEATURE_STAGE_NOTE_MAX} characters; this one has ${note.length}. Shorten it, or put the detail in memory.`,
    );
  }
  return {
    ok: true,
    stage: {
      ...(plan === undefined ? {} : { plan }),
      stage,
      ...(note === undefined || note === "" ? {} : { note }),
      setBy: input.setBy,
      setAt: input.now,
    },
  };
};

/**
 * The workspace's groups with `feature` in `group`, or in none when `group` is `undefined`. A
 * feature is in one group at most, so it leaves the one it was in; a group left with no features
 * and no stage is dropped, and one that keeps a stage stays, since somebody's word is on it.
 * Returns the record it was given when nothing moves.
 */
export const regroup = (
  groups: Readonly<Record<string, FeatureGroup>>,
  feature: string,
  group: string | undefined,
): Readonly<Record<string, FeatureGroup>> => {
  if (
    Object.entries(groups).every(
      ([name, each]) => each.features.includes(feature) === (name === group),
    ) &&
    (group === undefined || groups[group] !== undefined)
  ) {
    return groups;
  }
  const next: Record<string, FeatureGroup> = {};
  for (const [name, each] of Object.entries(groups)) {
    const features = each.features.filter((slug) => slug !== feature);
    if (name === group) next[name] = { ...each, features: [...features, feature] };
    else if (features.length > 0 || each.stage !== undefined) next[name] = { ...each, features };
  }
  if (group !== undefined && next[group] === undefined) next[group] = { features: [feature] };
  return next;
};

/** The slug of the group a feature is in, if any. */
export const groupOf = (
  groups: Readonly<Record<string, FeatureGroup>> | undefined,
  feature: string,
): string | undefined =>
  Object.entries(groups ?? {}).find(([, each]) => each.features.includes(feature))?.[0];

/**
 * Whole minutes the user has been away from Gram at `now`, for a digest to say, given when the app
 * last stopped being in use; `undefined` while they are at it or away less than
 * `USER_AWAY_AFTER_MINUTES`.
 */
export const userAwayMinutes = (
  inactiveSince: number | undefined,
  now: number,
): number | undefined => {
  if (inactiveSince === undefined) return undefined;
  const minutes = Math.floor((now - inactiveSince) / 60_000);
  return minutes >= USER_AWAY_AFTER_MINUTES ? minutes : undefined;
};
