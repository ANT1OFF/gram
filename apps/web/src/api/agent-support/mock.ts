import type { AgentSupportApi } from "./types";

/** Invented read-only support observations for the synthetic UI, never real provider evidence. */
export const agentSupportMock = (): AgentSupportApi => ({
  agentSupport: async (model) => ({
    model,
    checkedAt: Date.now(),
    availability: { state: "available" },
    support: {
      session: { state: "supported", evidence: "Synthetic UI session fixture" },
      orchestrator: { state: "supported", evidence: "Synthetic UI orchestrator fixture" },
      worker: { state: "supported", evidence: "Synthetic UI worker fixture" },
      dream: { state: "unknown", reason: "This fixture has no qualified Dream observation." },
      browser: {
        state: "unknown",
        reason: "Preview browser support has not been checked in this fixture.",
      },
      compaction: { state: "unknown", reason: "Session commands have not been listed yet." },
      imageInput: {
        state: "unknown",
        reason: "The fixture has no model input modality observation.",
      },
    },
  }),
});
