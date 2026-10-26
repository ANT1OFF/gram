import * as Schema from "effect/Schema";
import { AgentKind, ReasoningVariant, SpeedMode, type ModelRef } from "./domain.ts";

/** A model the composer's model picker offers for an agent (and gateway profile). */
export const AgentModel = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  description: Schema.optionalKey(Schema.String),
  supportsEffort: Schema.Boolean,
  /** Explicitly advertised input modalities; absent is unknown, not text-only or entitled. */
  inputModalities: Schema.optionalKey(Schema.Array(Schema.Literals(["text", "image"]))),
  /** CLI-advertised processing modes; no account entitlement is inferred. */
  speeds: Schema.optionalKey(Schema.Array(SpeedMode)),
  /** The selectable reasoning efforts; present when `supportsEffort`. */
  efforts: Schema.optionalKey(Schema.Array(ReasoningVariant)),
  /**
   * The gateway lists no efforts for it, so `efforts` are the ones a gateway at worst ignores,
   * offered without knowing which it takes.
   */
  effortsUnlisted: Schema.optionalKey(Schema.Literal(true)),
  isDefault: Schema.optionalKey(Schema.Boolean),
  /**
   * The model id an alias row runs (`opus` → `claude-opus-5-5`), so a thread recorded on that id
   * still counts as offered.
   */
  resolvedId: Schema.optionalKey(Schema.String),
  /** Why it may not work here, for the picker to say beside it: the agent doesn't know it. */
  warning: Schema.optionalKey(Schema.String),
});
export type AgentModel = typeof AgentModel.Type;

export const ModelList = Schema.Struct({ models: Schema.Array(AgentModel) });
export type ModelList = typeof ModelList.Type;

/** An unset choice follows a discovered local CLI default, never a saved gateway or guessed id. */
export const localSubscriptionDefault = (
  claude: ReadonlyArray<AgentModel> | undefined,
  codex: ReadonlyArray<AgentModel> | undefined,
): ModelRef | undefined => {
  for (const [agent, models] of [
    ["claude", claude],
    ["codex", codex],
  ] as const) {
    const model = models?.find((row) => row.isDefault) ?? models?.[0];
    if (model !== undefined) return { agent, model: model.id, speed: "standard" };
  }
  return undefined;
};

/**
 * A model id found in the user's own agent configuration, offered in Settings as a custom model to
 * add. A hint, not a discovery: no agent advertises an early-access model, so the only trace of one
 * is where the user already used it.
 */
export const ModelSuggestion = Schema.Struct({
  agent: AgentKind,
  id: Schema.NonEmptyString,
  /** Where it was found, for the button's tooltip, e.g. `~/.claude/settings.json`. */
  source: Schema.String,
});
export type ModelSuggestion = typeof ModelSuggestion.Type;

export const ModelSuggestions = Schema.Struct({ suggestions: Schema.Array(ModelSuggestion) });
export type ModelSuggestions = typeof ModelSuggestions.Type;

const bare = (value: string) => value.replace(/\[1m\]$/i, "");

/** Match an alias's resolved id without inventing support from a provider/model name. */
export const modelSpeeds = (
  models: ReadonlyArray<AgentModel> | undefined,
  id: string,
): ReadonlyArray<SpeedMode> => {
  return (
    models?.find(
      (row) => row.id === id || (row.resolvedId !== undefined && bare(row.resolvedId) === bare(id)),
    )?.speeds ?? []
  );
};

/** Fast must be explicitly advertised. The CLI still owns availability and billing checks. */
export const fastSelectionProblem = (
  model: ModelRef,
  models: ReadonlyArray<AgentModel>,
): string | undefined =>
  model.speed === "fast" && !modelSpeeds(models, model.model).includes("fast")
    ? `Fast mode is not advertised for ${model.model} by this CLI. Select Standard or a supported model.`
    : undefined;
