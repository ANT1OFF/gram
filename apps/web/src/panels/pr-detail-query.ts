import type { BoundPr, PrDetailResult, ThreadId } from "@gram/contracts";

import type { Api } from "@/api/types";

import { ifTarget, prTargetOf, type GitPrSource, type PrIdentity } from "./pr-identity";

/** `owner/repo#number`, lower-cased: one PR as a string, for a query key or a stamp to lead with. */
export const prKey = (target: PrIdentity): string =>
  `${target.repo?.toLowerCase() ?? ""}#${target.number}`;

/**
 * What changes a PR's detail: which PR the thread targets, then that PR's badge update time and
 * checks. `null` without a target, so nothing is fetched. The target leads the stamp because the
 * badge alone can stay the same across a bind, rebind or unbind.
 */
export const prDetailStamp = (
  git: GitPrSource | undefined,
  boundPr: BoundPr | undefined,
): string | null => {
  const target = prTargetOf(git, boundPr);
  if (!target) return null;
  const badge = ifTarget(target, git?.pr, git?.origin);
  return `${prKey(target)}:${badge?.updatedAt ?? ""}:${badge?.checks ?? ""}`;
};

/** The PR panel's detail query, shared with the openers' prewarm so both use one cache entry. */
export const prDetailQuery = (api: Api, threadId: ThreadId, stamp: string | null) => ({
  queryKey: ["git.prDetail", threadId, stamp] as const,
  queryFn: () => api.prDetail(threadId),
  retry: false as const,
});

/**
 * `placeholderData` that keeps the last detail on screen only while it is still the target's. The
 * server acts on the thread's current binding, so after a bind, rebind or unbind the previous PR's
 * Merge and Close would hit a PR the panel isn't showing.
 */
export const keepSamePr =
  (target: PrIdentity | undefined, origin?: string | undefined) =>
  (previous: PrDetailResult | undefined): PrDetailResult | undefined =>
    ifTarget(target, previous?.detail, origin) === undefined ? undefined : previous;
