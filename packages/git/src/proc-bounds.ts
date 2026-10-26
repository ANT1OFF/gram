import type { Tier } from "./proc.ts";

/**
 * Wall-clock bounds. `local`: generous for a cold cache or huge status, tight enough that a wedged
 * git can't freeze git state. `network`: a fetch that the local bound would kill mid-transfer.
 * `slow`: `worktree add`/`remove`, where a kill strands a half-made tree.
 */
export const TIER_MILLIS: Readonly<Record<Tier, number>> = {
  local: 25_000,
  network: 60_000,
  slow: 300_000,
};
