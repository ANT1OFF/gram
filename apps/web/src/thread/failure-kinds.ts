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

/**
 * How a failed turn failed, in a few words: an error card's title, a stopped worker's lead. A rate
 * limit that won't clear by retrying is the subscription's usage limit, spent, and says so: "Rate
 * limited" is kept for the provider throttling requests (HTTP 429), which a retry may get past.
 */
export const failureLabel = (kind: AgentFailureKind, retryable?: boolean): string =>
  kind === "rateLimit" && retryable === false
    ? USAGE_LIMIT
    : ((KIND_LABEL as Partial<Record<string, string>>)[kind] ?? "Turn failed");

/** A spent usage limit's title. */
export const USAGE_LIMIT = "Usage limit reached";
