import * as Schema from "effect/Schema";
import { ModelRef } from "./domain.ts";
import type { AgentModel } from "./models.ts";

/** `dream` is the supported workflow; `dreamFiles` is specifically enforced file-only access. */
export const HarnessFeature = Schema.Literals([
  "session",
  "orchestrator",
  "worker",
  "dream",
  "dreamFiles",
  "dreamGuided",
  "browser",
  "compaction",
  "imageInput",
]);
export type HarnessFeature = typeof HarnessFeature.Type;

/** Evidence describes the adapter/protocol/config observation, not account entitlement. */
export const FeatureSupport = Schema.Union([
  Schema.Struct({ state: Schema.Literal("supported"), evidence: Schema.String }),
  Schema.Struct({
    state: Schema.Literal("unsupported"),
    reason: Schema.String,
    evidence: Schema.String,
  }),
  Schema.Struct({ state: Schema.Literal("unknown"), reason: Schema.String }),
]);
export type FeatureSupport = typeof FeatureSupport.Type;

/** A read-only observation for the selected account/profile; credentials never cross profiles. */
export const HarnessAvailability = Schema.Union([
  Schema.Struct({ state: Schema.Literal("available") }),
  Schema.Struct({
    state: Schema.Literals(["unknown", "missing", "signedOut", "temporarilyUnavailable"]),
    reason: Schema.String,
  }),
]);
export type HarnessAvailability = typeof HarnessAvailability.Type;

export const HarnessSupport = Schema.Struct({
  session: Schema.optionalKey(FeatureSupport),
  orchestrator: Schema.optionalKey(FeatureSupport),
  worker: Schema.optionalKey(FeatureSupport),
  dream: Schema.optionalKey(FeatureSupport),
  dreamFiles: Schema.optionalKey(FeatureSupport),
  dreamGuided: Schema.optionalKey(FeatureSupport),
  browser: Schema.optionalKey(FeatureSupport),
  compaction: Schema.optionalKey(FeatureSupport),
  imageInput: Schema.optionalKey(FeatureSupport),
});
export type HarnessSupport = typeof HarnessSupport.Type;

/** Content-free read-only evidence for exactly the selected agent/account/profile. */
export const SelectedHarnessSupport = Schema.Struct({
  model: ModelRef,
  support: HarnessSupport,
  availability: HarnessAvailability,
  checkedAt: Schema.Number,
  version: Schema.optionalKey(Schema.String),
  dreamMode: Schema.optionalKey(Schema.Literals(["confined", "guided"])),
  dreamReason: Schema.optionalKey(Schema.String),
});
export type SelectedHarnessSupport = typeof SelectedHarnessSupport.Type;

/** Only explicit discovered modalities qualify image input; aliases retain their observation. */
const bareModelId = (id: string) => id.replace(/\[1m\]$/i, "");
export const imageInputSupport = (
  models: ReadonlyArray<AgentModel> | undefined,
  modelId: string,
): FeatureSupport => {
  const row = models?.find(
    (model) =>
      model.id === modelId ||
      (model.resolvedId !== undefined && bareModelId(model.resolvedId) === bareModelId(modelId)),
  );
  if (row?.inputModalities === undefined)
    return {
      state: "unknown",
      reason:
        "The selected model has not advertised image input. Access is checked by the CLI when used.",
    };
  return row.inputModalities.includes("image")
    ? {
        state: "supported",
        evidence:
          "The selected model's discovery lists image input; this does not establish account entitlement.",
      }
    : {
        state: "unsupported",
        reason:
          "The selected model advertises no image input. Choose an image-capable model or remove the image attachment.",
        evidence: "The selected model's explicit input modalities",
      };
};

/** Keep both observations even when one supplies the primary reason beside Start. */
export interface FeaturePreflight {
  readonly support: FeatureSupport;
  readonly availability: HarnessAvailability;
  readonly state:
    | "ready"
    | "unknown"
    | "unsupported"
    | "missing"
    | "signedOut"
    | "temporarilyUnavailable";
  readonly blocked: boolean;
  readonly reason?: string;
  readonly action?: "setup" | "retry" | "chooseAgent";
}

/**
 * No discovery or provider call. A boundary-sensitive feature such as Dream requires verified
 * support; ordinary tasks may proceed with unknown support. Known unavailability always blocks.
 * "ready" describes these observations only: the CLI still checks model entitlement at use.
 */
export const featurePreflight = (input: {
  readonly feature: HarnessFeature;
  readonly support: HarnessSupport | undefined;
  readonly availability: HarnessAvailability;
  readonly requireVerified?: boolean;
}): FeaturePreflight => {
  const support = input.support?.[input.feature] ?? {
    state: "unknown",
    reason: "This harness has not reported support for this feature.",
  };
  const observations = { support, availability: input.availability };
  if (support.state === "unsupported")
    return {
      ...observations,
      state: "unsupported",
      blocked: true,
      reason: support.reason,
      action: "chooseAgent",
    };
  const availability = input.availability;
  if (availability.state !== "available" && availability.state !== "unknown")
    return {
      ...observations,
      state: availability.state,
      blocked: true,
      reason: availability.reason,
      action: availability.state === "temporarilyUnavailable" ? "retry" : "setup",
    };
  if (support.state === "unknown")
    return {
      ...observations,
      state: "unknown",
      blocked: input.requireVerified === true,
      reason: support.reason,
      action: "retry",
    };
  if (availability.state === "unknown")
    return {
      ...observations,
      state: "unknown",
      blocked: false,
      reason: availability.reason,
      action: "retry",
    };
  return { ...observations, state: "ready", blocked: false };
};
