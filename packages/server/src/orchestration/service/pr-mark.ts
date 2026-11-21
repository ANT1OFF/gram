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
