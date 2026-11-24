import type { PrStatus } from "@gram/contracts";

/** An open PR's badge, #12 on acme/shop with checks pending, with `overrides` laid over it. */
export const prBadge = (overrides: Partial<PrStatus> = {}): PrStatus => ({
  number: 12,
  state: "OPEN",
  url: "https://github.com/acme/shop/pull/12",
  title: "t",
  isDraft: false,
  checks: "pending",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: "a".repeat(40),
  mergeState: "BLOCKED",
  ...overrides,
});
