import { dreamSupportFor } from "@gram/agents/dream-support";
import type { FeatureSupport } from "@gram/contracts/agent-support";
import type { ModelRef } from "@gram/contracts";

export interface DreamSupportObservation {
  readonly dream: FeatureSupport;
  readonly dreamFiles: FeatureSupport;
  readonly dreamGuided: FeatureSupport;
  readonly mode?: "confined" | "guided";
  readonly reason?: string;
}

/** Translate the transport's installed evidence; never infer installation from implementation. */
export const installedDreamSupport = (
  model: ModelRef,
  cliVersion: string | undefined,
): DreamSupportObservation => {
  const decision = dreamSupportFor(model.agent, { kind: "installed", cliVersion });
  if (decision.mode === "unknown") {
    const support: FeatureSupport = { state: "unknown", reason: decision.reason };
    const implementation = dreamSupportFor(model.agent, { kind: "implementation" });
    return {
      dream: support,
      dreamGuided: support,
      dreamFiles:
        implementation.mode === "guided"
          ? {
              state: "unsupported",
              evidence: "The current transport's implementation Dream mode",
              reason: `The current Dream transport provides guided normal permissions rather than enforced file-only access. ${implementation.reason}`,
            }
          : support,
    };
  }
  if (decision.mode === "unsupported") {
    const support: FeatureSupport = {
      state: "unsupported",
      reason: decision.reason,
      evidence: "The selected transport's Dream decision",
    };
    return { dream: support, dreamFiles: support, dreamGuided: support };
  }
  const supported: FeatureSupport = { state: "supported", evidence: decision.reason };
  const otherMode: FeatureSupport = {
    state: "unsupported",
    evidence: "The selected transport's installed Dream mode",
    reason:
      decision.mode === "guided"
        ? `This Dream uses normal permissions; enforced file-only access is not provided. ${decision.reason}`
        : `This Dream uses the confined file bridge rather than normal native permissions. ${decision.reason}`,
  };
  return {
    dream: supported,
    dreamFiles: decision.mode === "confined" ? supported : otherMode,
    dreamGuided: decision.mode === "guided" ? supported : otherMode,
    mode: decision.mode,
    reason: decision.reason,
  };
};
