import type { AgentFailureKind } from "@gram/contracts";

const KIND_LABEL: Record<AgentFailureKind, string> = {
  rateLimit: "Rate limited",
  auth: "Not signed in",
  modelUnavailable: "Model unavailable",
  gatewayRefused: "Gateway refused",
  costGuard: "Spending limit",
  network: "Connection failed",
  unknown: "Turn failed",
};

/** How a failed turn failed, in a few words: an error card's title, a stopped worker's lead. */
export const failureLabel = (kind: AgentFailureKind): string =>
  (KIND_LABEL as Partial<Record<string, string>>)[kind] ?? "Turn failed";
