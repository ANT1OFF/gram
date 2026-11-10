import {
  DEFAULT_ORCHESTRATOR_MODEL,
  isPinned,
  isTierRef,
  localSubscriptionDefault,
  RECOMMENDED,
  RECOMMENDED_NEW_CHAT,
  RECOMMENDED_ROSTER,
  resolveTier,
  rosterModelHere,
  setupOf,
  TIERS,
  tierEffort,
  tierModelName,
  tierName,
  type AvailableModels,
  type ModelRef,
  type ModelSlot,
  type OrchestratorCharter,
  type ReasoningVariant,
  type Settings,
  type SettingsPatch,
  type Tier,
  type TierRef,
  type WorkerModel,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";

import { agentLabel } from "@/agents/agent-label";

// The recommended setup in Settings: what each tier is on this machine, what turning the mode on
// would change (the one-time sheet), and what turning it off keeps. Pure, so it is tested alone.

const effortWord = (effort: ReasoningVariant) => `${effort[0]!.toUpperCase()}${effort.slice(1)}`;

/** A tier as it stands on this machine: the model it runs on and its effort, if anything fills it. */
export interface TierRow {
  readonly tier: Tier;
  readonly name: string;
  readonly note: string;
  /** "Opus 5.5 · Medium", or undefined when nothing here fills it. */
  readonly runsOn?: string;
}

/** Each tier as it stands here, for the Details table. */
export const tierRows = (available: AvailableModels): readonly TierRow[] =>
  TIERS.map((tier) => {
    const resolved = resolveTier(RECOMMENDED, { tier }, available);
    return {
      tier,
      name: tierName(tier),
      note: RECOMMENDED.tiers[tier].note,
      ...(resolved === undefined
        ? {}
        : {
            runsOn: [
              tierModelName(resolved),
              ...(resolved.ref.variant === undefined ? [] : [effortWord(resolved.ref.variant)]),
            ].join(" · "),
          }),
    };
  });

/** "Opus 5.5 leads, GPT-6.1-Sol does scoped work, Haiku 5.5 helps": this machine, in a line. */
export const recommendedSummary = (available: AvailableModels): string | undefined => {
  const name = (tier: Tier) => {
    const resolved = resolveTier(RECOMMENDED, { tier }, available);
    return resolved === undefined ? undefined : tierModelName(resolved);
  };
  const lead = name("lead");
  const scoped = name("scoped");
  const cheap = name("cheap");
  const parts = [
    ...(lead === undefined ? [] : [`${lead} leads`]),
    ...(scoped === undefined || scoped === lead ? [] : [`${scoped} does scoped work`]),
    ...(cheap === undefined ? [] : [`${cheap} helps`]),
  ];
  if (parts.length === 0) return undefined;
  return `${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}, ${parts.at(-1)}`}.`;
};

/** A following slot as the sheet names it: "Recommended Lead · Opus 5.5 · Low". */
export const followText = (ref: TierRef, available: AvailableModels): string => {
  const resolved = resolveTier(RECOMMENDED, ref, available);
  if (resolved === undefined) return `Recommended ${tierName(ref.tier)}`;
  return [
    `Recommended ${tierName(ref.tier)}`,
    tierModelName(resolved),
    ...(resolved.ref.variant === undefined ? [] : [effortWord(resolved.ref.variant)]),
  ].join(" · ");
};

/** A pinned model as the sheet names it: "Claude Code opus · High". */
export const pinnedText = (model: ModelRef): string =>
  [
    `${agentLabel(model.agent)} ${model.model}`,
    ...(model.variant === undefined ? [] : [effortWord(model.variant)]),
  ].join(" · ");

/** Whether a pinned orchestrator is Gram's own past default (Opus at high), not the user's pick. */
const isPastOrchestratorDefault = (model: ModelRef) =>
  model.agent === DEFAULT_ORCHESTRATOR_MODEL.agent &&
  model.model === DEFAULT_ORCHESTRATOR_MODEL.model &&
  model.variant === DEFAULT_ORCHESTRATOR_MODEL.variant &&
  model.profileId === undefined;

/**
 * The tier a pinned roster entry runs the same model as here, if one does: what ticking it moves it
 * to, keeping its note and its default mark.
 */
const tierOfPinned = (entry: ModelRef, available: AvailableModels): Tier | undefined =>
  TIERS.find((tier) => {
    const resolved = resolveTier(RECOMMENDED, { tier, agent: entry.agent }, available);
    return (
      resolved !== undefined &&
      resolved.ref.model === entry.model &&
      entry.profileId === undefined &&
      resolved.ref.variant === entry.variant
    );
  });

/** One slot the turn-on sheet lists. */
export interface TurnOnRow {
  readonly key: string;
  readonly label: string;
  /** What it is now → what it would follow, or why it stays. */
  readonly change: string;
  /** Pre-ticked: a past Gram default. Unticked: the user's own pick, kept. */
  readonly ticked: boolean;
  /** Whether it can be ticked at all: a pinned entry no tier runs stays the user's. */
  readonly canFollow: boolean;
}

/** What turning the mode on would change, slot by slot, with past Gram defaults pre-ticked. */
export const turnOnRows = (
  settings: Settings,
  workspaces: readonly WorkspaceState[],
  available: AvailableModels,
): readonly TurnOnRow[] => {
  const rows: TurnOnRow[] = [];
  const saved = settings.agents.defaultModel;
  if (saved === undefined || isPinned(saved)) {
    rows.push({
      key: "default",
      label: "New threads",
      change:
        saved === undefined
          ? `Not set → ${followText(RECOMMENDED_NEW_CHAT, available)}`
          : `${pinnedText(saved)} → ${followText(RECOMMENDED_NEW_CHAT, available)}`,
      ticked: saved === undefined,
      canFollow: true,
    });
  }
  for (const { workspace, charter } of workspaces) {
    const own = charter.orchestratorModel;
    if (own === undefined || isPinned(own)) {
      const past = own === undefined || isPastOrchestratorDefault(own);
      rows.push({
        key: `orchestrator:${workspace.id}`,
        label: `${workspace.name} · orchestrator`,
        change: `${own === undefined ? "Your default model" : pinnedText(own)} → ${followText({ tier: "lead" }, available)}`,
        ticked: past,
        canFollow: true,
      });
    }
    const roster = charter.workerModels ?? [];
    if (roster.length === 0) {
      rows.push({
        key: `roster:${workspace.id}`,
        label: `${workspace.name} · workers`,
        change: "The orchestrator's own model → Recommended, one of each tier, Scoped the default",
        ticked: true,
        canFollow: true,
      });
    }
    roster.forEach((entry, index) => {
      if (!isPinned(entry)) return;
      const tier = tierOfPinned(entry, available);
      const note = entry.useFor === undefined ? "" : `: ${entry.useFor}`;
      rows.push({
        key: `entry:${workspace.id}:${index}`,
        label: `${workspace.name} · worker${note}`,
        change:
          tier === undefined
            ? `${pinnedText(entry)}: yours, kept`
            : `${pinnedText(entry)} → ${followText({ tier, agent: entry.agent }, available)}`,
        ticked: false,
        canFollow: tier !== undefined,
      });
    });
  }
  const helpers = settings.helpers;
  const ownHelpers =
    helpers?.claudeModel !== undefined ||
    helpers?.codexModel !== undefined ||
    helpers?.claudeEffort !== undefined ||
    helpers?.codexEffort !== undefined;
  rows.push({
    key: "helpers",
    label: "AI helpers",
    change: ownHelpers
      ? "Your helper model and effort: yours, kept"
      : `Automatic → ${followText({ tier: "cheap" }, available).replace(/ · \w+$/, "")} · Medium for titles, Low for the rest`,
    ticked: !ownHelpers,
    canFollow: true,
  });
  return rows;
};

/** What confirming the sheet writes: a settings patch, and each workspace whose charter changes. */
export interface TurnOnWrites {
  readonly patch: SettingsPatch;
  readonly charters: ReadonlyArray<{
    readonly id: WorkspaceId;
    readonly charter: OrchestratorCharter;
  }>;
}

/** The writes for the ticked rows (`ticked` holds their keys). */
export const turnOnWrites = (
  settings: Settings,
  workspaces: readonly WorkspaceState[],
  available: AvailableModels,
  ticked: ReadonlySet<string>,
): TurnOnWrites => {
  const agents: Record<string, unknown> = {
    recommendedSetup: { enabled: true, seen: RECOMMENDED.version },
  };
  const saved = settings.agents.defaultModel;
  if (saved === undefined && !ticked.has("default")) {
    // Kept as it was: unset meant the CLI's own default, which the mode would otherwise replace.
    const discovered = localSubscriptionDefault(available.claude, available.codex);
    if (discovered !== undefined) agents["defaultModel"] = discovered;
  } else if (saved !== undefined && isPinned(saved) && ticked.has("default")) {
    agents["defaultModel"] = RECOMMENDED_NEW_CHAT;
  }
  const patch: Record<string, unknown> = { agents };
  const helpers = settings.helpers;
  const ownHelpers =
    helpers?.claudeModel !== undefined ||
    helpers?.codexModel !== undefined ||
    helpers?.claudeEffort !== undefined ||
    helpers?.codexEffort !== undefined;
  if (ownHelpers && ticked.has("helpers")) {
    patch["helpers"] = {
      claudeModel: null,
      codexModel: null,
      claudeEffort: null,
      codexEffort: null,
    };
  }
  const charters: Array<{ id: WorkspaceId; charter: OrchestratorCharter }> = [];
  for (const { workspace, charter } of workspaces) {
    let next: OrchestratorCharter = charter;
    if (ticked.has(`orchestrator:${workspace.id}`)) {
      next = { ...next, orchestratorModel: { tier: "lead" } };
    }
    const roster = charter.workerModels ?? [];
    if (roster.length === 0 && ticked.has(`roster:${workspace.id}`)) {
      next = { ...next, workerModels: RECOMMENDED_ROSTER };
    } else if (roster.length > 0) {
      const moved = roster.map((entry, index): WorkerModel => {
        if (!isPinned(entry) || !ticked.has(`entry:${workspace.id}:${index}`)) return entry;
        const tier = tierOfPinned(entry, available);
        if (tier === undefined) return entry;
        return {
          tier,
          agent: entry.agent,
          ...(entry.useFor === undefined ? {} : { useFor: entry.useFor }),
          ...(entry.default === undefined ? {} : { default: entry.default }),
        };
      });
      if (moved.some((entry, index) => entry !== roster[index])) {
        next = { ...next, workerModels: moved };
      }
    }
    if (next !== charter) charters.push({ id: workspace.id, charter: next });
  }
  return { patch: patch as SettingsPatch, charters };
};

/** A following slot pinned to what it runs on here, or left as it is when nothing fills it. */
const pinHere = (slot: ModelSlot, available: AvailableModels): ModelSlot => {
  if (!isTierRef(slot)) return slot;
  return resolveTier(RECOMMENDED, slot as TierRef, available)?.ref ?? slot;
};

/**
 * Turning the mode off, keeping the current models: each following slot pinned to what it runs on
 * here today. An unset default, which the mode gave Lead at low, is pinned to that too.
 */
export const turnOffKeepWrites = (
  settings: Settings,
  workspaces: readonly WorkspaceState[],
  available: AvailableModels,
): TurnOnWrites => {
  const agents: Record<string, unknown> = {
    recommendedSetup: {
      enabled: false,
      ...(settings.agents.recommendedSetup?.seen === undefined
        ? {}
        : { seen: settings.agents.recommendedSetup.seen }),
    },
  };
  const slot = settings.agents.defaultModel ?? RECOMMENDED_NEW_CHAT;
  const pinned = pinHere(slot, available);
  if (pinned !== settings.agents.defaultModel && isPinned(pinned)) agents["defaultModel"] = pinned;
  const charters: Array<{ id: WorkspaceId; charter: OrchestratorCharter }> = [];
  for (const { workspace, charter } of workspaces) {
    const own = charter.orchestratorModel;
    const orchestrator = own === undefined ? undefined : pinHere(own, available);
    const roster = charter.workerModels?.map((entry): WorkerModel => {
      if (!isTierRef(entry)) return entry;
      const here = rosterModelHere(entry, available);
      if (here.missing !== undefined) return entry;
      const { tier: _tier, tierAgent: _agent, unknownTier: _unknown, ...model } = here.entry;
      // Its note stays the user's only when they wrote one; the tier's note goes with the tier.
      const { useFor: _note, ...bare } = model;
      return entry.useFor === undefined ? bare : { ...bare, useFor: entry.useFor };
    });
    const changed =
      orchestrator !== own ||
      (roster !== undefined &&
        roster.some((entry, index) => entry !== charter.workerModels![index]));
    if (!changed) continue;
    charters.push({
      id: workspace.id,
      charter: {
        ...charter,
        ...(orchestrator === undefined ? {} : { orchestratorModel: orchestrator }),
        ...(roster === undefined ? {} : { workerModels: roster }),
      },
    });
  }
  return { patch: { agents } as SettingsPatch, charters };
};

/** The setup a machine is, for the Details fold's empty state. */
export const nothingInstalled = (available: AvailableModels): boolean =>
  setupOf(available) === "none";

/** The effort a tier starts at for a harness, for tests and labels. */
export const startingEffort = (tier: Tier, agent: "claude" | "codex") =>
  tierEffort(RECOMMENDED, tier, agent);
