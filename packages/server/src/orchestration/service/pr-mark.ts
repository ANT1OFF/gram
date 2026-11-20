// A pull request's badge as the ledger marks it: its state, its required checks, the review's
// verdict on its head and how it merges.

import { type PrStatus, requiredChecksOf } from "@gram/contracts";
import type { PrMark } from "../rules.ts";

export const prMarkOf = (badge: PrStatus | undefined): PrMark | undefined => {
  if (badge === undefined) return undefined;
  const verdict = badge.review?.verdictOnHead;
  return {
    state: badge.state === "MERGED" ? "merged" : badge.state === "CLOSED" ? "closed" : "open",
    checks: requiredChecksOf(badge),
    ...(verdict === undefined ? {} : { verdictOnHead: verdict }),
    ...(badge.mergeState === undefined ? {} : { mergeState: badge.mergeState }),
  };
};
