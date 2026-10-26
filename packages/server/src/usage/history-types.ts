import type { TokenUsage, UsageProvider } from "@gram/contracts";
import type { CodexUsageBasis } from "@gram/agents/codex";
export interface HistoryRecord {
  provider: UsageProvider;
  session: string;
  id: string;
  nativeIds: string[];
  model: string | null;
  modelConflict?: boolean;
  /** First observed actual model, retained when missing context makes the group Unknown. */
  modelWitness?: string;
  at: number;
  tokens: TokenUsage;
  partial: boolean;
  /** A complete parsed source; corruption/caps prevent replacement of a Gram snapshot. */
  complete: boolean;
  trusted: boolean;
  parent: string | null;
  basis?: CodexUsageBasis;
  /** Opaque server-generated physical-source identity; never projected to the RPC. */
  fileIdentity?: string;
  /** Modern per-response records retain their actual native turn for canonical grouping. */
  turn?: string;
  turnComplete?: boolean;
  expectedTurnTokens?: TokenUsage;
  /** Private reconciliation evidence: known cache minima do not certify a full split. */
  cacheIncomplete?: boolean;
}

export const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const identity = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 256 &&
  ![...value].some((character) => character.charCodeAt(0) < 32)
    ? value
    : undefined;
export const modelOf = (value: unknown): string | null =>
  value === "<synthetic>" ? null : (identity(value) ?? null);
export const timeOf = (value: unknown): number | undefined => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return undefined;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : undefined;
};
export interface HistoryReducer {
  readonly records: Map<string, HistoryRecord>;
  invalid: number;
  ambiguous: number;
  consume(value: unknown): void;
  window(from: number, to: number): void;
  readonly nativeTurnIds: Set<string>;
  owner: string | undefined;
  nativeOverflow: boolean;
  identityComplete: boolean;
  breakContext(): void;
  /** Selected replay/identity state retained beyond the returned record projections. */
  retainedBytes(): number;
}
