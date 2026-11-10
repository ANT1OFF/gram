import * as Schema from "effect/Schema";
import { AgentKind, ModelRef, type ReasoningVariant } from "./domain.ts";
import type { AgentModel } from "./models.ts";
import data from "./recommended/table.json" with { type: "json" };

/** A kind of work, from cheapest to most capable. A following slot stores one of these. */
export const Tier = Schema.Literals(["cheap", "scoped", "lead", "top"]);
export type Tier = typeof Tier.Type;
export const TIERS: ReadonlyArray<Tier> = Tier.literals;

/** Never above high: the recommendation's ceiling, in its data and in everything that follows it. */
export const FollowEffort = Schema.Literals(["none", "low", "medium", "high"]);
export type FollowEffort = typeof FollowEffort.Type;
const EFFORT_ORDER: ReadonlyArray<FollowEffort> = FollowEffort.literals;

/** An effort past the recommendation's ceiling: `xhigh` or `max`. */
export const aboveHigh = (effort: ReasoningVariant): boolean =>
  !EFFORT_ORDER.includes(effort as FollowEffort);

/**
 * A slot that follows the recommendation: resolved through the table each time it's used, on the
 * machine it runs on. `agent` keeps it on one harness, `variant` at one effort, still following.
 */
export const TierRef = Schema.Struct({
  tier: Tier,
  agent: Schema.optionalKey(AgentKind),
  variant: Schema.optionalKey(FollowEffort),
});
export type TierRef = typeof TierRef.Type;

/** A model slot: following a tier, or pinned to the model and effort the user chose. */
export const ModelSlot = Schema.Union([ModelRef, TierRef]);
export type ModelSlot = typeof ModelSlot.Type;

export const isTierRef = <T extends object>(slot: T): slot is Extract<T, { readonly tier: Tier }> =>
  "tier" in slot;

const VendorPick = Schema.Struct({
  /** In order of preference; an older CLI falls back to a later one within the tier. */
  models: Schema.NonEmptyArray(Schema.NonEmptyString),
  /** This harness's starting effort for the tier, where it differs from the tier's. */
  effort: Schema.optionalKey(FollowEffort),
});

const TierPick = Schema.Struct({
  /** What the tier is for, in a user's words: the roster's default "use for" note. */
  note: Schema.NonEmptyString,
  effort: FollowEffort,
  /** Helpers run on Cheap: each helper kind's effort, by kind name (`title`, `recap`, …). */
  helpers: Schema.optionalKey(Schema.Record(Schema.String, FollowEffort)),
  claude: VendorPick,
  codex: VendorPick,
});

/** The versioned recommendation Gram ships. Nothing is fetched: a release carries a new one. */
export const RecommendationTable = Schema.Struct({
  version: Schema.NonEmptyString,
  tiers: Schema.Struct({ cheap: TierPick, scoped: TierPick, lead: TierPick, top: TierPick }),
  /** With both harnesses signed in, which one fills each tier first. */
  both: Schema.Struct({ cheap: AgentKind, scoped: AgentKind, lead: AgentKind, top: AgentKind }),
});
export type RecommendationTable = typeof RecommendationTable.Type;

export const RECOMMENDED: RecommendationTable = Schema.decodeUnknownSync(RecommendationTable)(data);

/** What a machine can run: each harness's listed models, absent or empty when it can't. */
export interface AvailableModels {
  readonly claude?: ReadonlyArray<AgentModel> | undefined;
  readonly codex?: ReadonlyArray<AgentModel> | undefined;
}

export type Setup = "claude" | "codex" | "both" | "none";

const has = (models: ReadonlyArray<AgentModel> | undefined) =>
  models !== undefined && models.length > 0;

/** Derived from what lists models, so installing a second harness later moves tiers by itself. */
export const setupOf = (available: AvailableModels): Setup => {
  const claude = has(available.claude);
  const codex = has(available.codex);
  return claude && codex ? "both" : claude ? "claude" : codex ? "codex" : "none";
};

const other = (agent: AgentKind): AgentKind => (agent === "claude" ? "codex" : "claude");

/** The harnesses a tier tries, in order, for this setup (or only the slot's own harness). */
export const tierAgents = (
  table: RecommendationTable,
  tier: Tier,
  setup: Setup,
  agent?: AgentKind,
): ReadonlyArray<AgentKind> => {
  if (agent !== undefined) return [agent];
  if (setup === "both") return [table.both[tier], other(table.both[tier])];
  return setup === "none" ? [] : [setup];
};

const bare = (id: string) => id.replace(/\[1m\]$/i, "");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `claude-haiku-5-5` → "Haiku 5.5", the label an alias row with no resolved id carries. */
const claudeLabel = (id: string): string | undefined => {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  if (match === null) return undefined;
  return `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${match[2]}.${match[3]}`;
};

/** The listed row that runs `id`: by id or an alias's resolved id, dated snapshots included. */
export const findListed = (
  agent: AgentKind,
  models: ReadonlyArray<AgentModel>,
  id: string,
): AgentModel | undefined => {
  const runs = (value: string | undefined) =>
    value !== undefined && new RegExp(`^${escape(id)}(?:-\\d{8})?$`).test(bare(value));
  const label = agent === "claude" ? claudeLabel(id) : undefined;
  const matches = models.filter(
    (row) =>
      runs(row.id) ||
      runs(row.resolvedId) ||
      (label !== undefined &&
        row.resolvedId === undefined &&
        new RegExp(`^${escape(label)}(?:\\s|$)`).test(row.displayName)),
  );
  // "default" follows the CLI's own choice, which may move; a named row stays on this model.
  return matches.find((row) => row.id !== "default") ?? matches[0];
};

/** The effort to run at: what was asked, never above high, and only one the model lists. */
export const clampEffort = (
  model: AgentModel,
  wanted: ReasoningVariant,
): FollowEffort | undefined => {
  if (!model.supportsEffort) return undefined;
  const listed = EFFORT_ORDER.filter((effort) => model.efforts?.includes(effort) ?? false);
  if (listed.length === 0) return undefined;
  // xhigh and max aren't in the order, so they land on high.
  const asked = EFFORT_ORDER.indexOf(wanted as FollowEffort);
  const ceiling = asked === -1 ? EFFORT_ORDER.length - 1 : asked;
  const below = listed.filter((effort) => EFFORT_ORDER.indexOf(effort) <= ceiling);
  return below.at(-1) ?? listed[0];
};

export interface ResolvedTier {
  readonly tier: Tier;
  readonly agent: AgentKind;
  /** The listed row it runs on, for its label. */
  readonly listed: AgentModel;
  /** What a thread records: concrete, so a running thread never changes under itself. */
  readonly ref: ModelRef;
}

/** The tier's starting effort on `agent`, before the slot's own and the model's clamp. */
export const tierEffort = (table: RecommendationTable, tier: Tier, agent: AgentKind) =>
  table.tiers[tier][agent].effort ?? table.tiers[tier].effort;

/**
 * Resolve a following slot against what this machine lists: the first candidate, in the setup's
 * harness order, that it offers. Undefined when nothing in the tier is there. Never a gateway.
 */
export const resolveTier = (
  table: RecommendationTable,
  ref: TierRef,
  available: AvailableModels,
): ResolvedTier | undefined => {
  for (const agent of tierAgents(table, ref.tier, setupOf(available), ref.agent)) {
    const models = available[agent] ?? [];
    for (const id of table.tiers[ref.tier][agent].models) {
      const listed = findListed(agent, models, id);
      if (listed === undefined) continue;
      const effort = clampEffort(listed, ref.variant ?? tierEffort(table, ref.tier, agent));
      return {
        tier: ref.tier,
        agent,
        listed,
        ref: {
          agent,
          model: listed.id,
          ...(effort === undefined ? {} : { variant: effort }),
          speed: "standard",
        },
      };
    }
  }
  return undefined;
};

const TIER_NAMES: Record<Tier, string> = {
  cheap: "Cheap",
  scoped: "Scoped",
  lead: "Lead",
  top: "Top",
};
const AGENT_NAMES: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };

export const tierName = (tier: Tier): string => TIER_NAMES[tier];

/**
 * What changed between two tables, one line each, for What's New: the first choice and effort of
 * each tier on each harness, and which harness leads a tier when both are installed.
 */
export const tableDiff = (
  before: RecommendationTable,
  after: RecommendationTable,
): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  for (const tier of TIERS) {
    for (const agent of AgentKind.literals) {
      const was = `${before.tiers[tier][agent].models[0]} · ${tierEffort(before, tier, agent)}`;
      const now = `${after.tiers[tier][agent].models[0]} · ${tierEffort(after, tier, agent)}`;
      if (was !== now) lines.push(`${TIER_NAMES[tier]} on ${AGENT_NAMES[agent]}: ${was} → ${now}`);
    }
    if (before.both[tier] !== after.both[tier]) {
      lines.push(
        `${TIER_NAMES[tier]} with both installed: ${AGENT_NAMES[before.both[tier]]} → ${AGENT_NAMES[after.both[tier]]}`,
      );
    }
  }
  return lines;
};

/**
 * What a slot runs on, here: a pinned slot as the user set it, a following one resolved now.
 * Undefined for an unset slot, or a tier nothing on this machine fills.
 */
export const slotModel = (
  slot: ModelSlot | undefined,
  available: AvailableModels,
  table: RecommendationTable = RECOMMENDED,
): ModelRef | undefined => {
  if (slot === undefined) return undefined;
  if (!isTierRef(slot)) return slot;
  return resolveTier(table, slot, available)?.ref;
};

/**
 * A slot as its tier's first choice on its harness (or the one the setup with both installed
 * puts first), for a world that runs every model: synthetic previews and fixtures, never a machine.
 */
export const firstChoiceOf = (
  slot: ModelSlot,
  table: RecommendationTable = RECOMMENDED,
): ModelRef => {
  if (!isTierRef(slot)) return slot;
  const agent = slot.agent ?? table.both[slot.tier];
  return {
    agent,
    model: table.tiers[slot.tier][agent].models[0],
    variant: slot.variant ?? tierEffort(table, slot.tier, agent),
  };
};
