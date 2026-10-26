import type { BoundPr, PrChecksResult, ThreadId } from "@gram/contracts";
import type { Query } from "@tanstack/react-query";

import type { Api } from "@/api/types";
import { prDetailStamp, prKey } from "@/panels/pr-detail-query";
import { prTargetOf, type GitPrSource } from "@/panels/pr-identity";

type PrChecksKey = readonly ["git.prChecks", ThreadId, string | null, string | null];

/**
 * The row's checks query: `git.prChecks`, a single small GraphQL request, rather than the PR
 * panel's `git.prDetail`, which is `gh pr view` and `gh pr diff` for a menu that reads neither. It
 * refetches on what the detail does, the PR's badge update time and its checks rollup. The key names
 * the PR apart from that stamp so `keepSamePrChecks` can tell a refetch from another PR.
 */
export const prChecksQuery = (
  api: Api,
  threadId: ThreadId,
  git: GitPrSource | undefined,
  boundPr: BoundPr | undefined,
) => {
  const target = prTargetOf(git, boundPr);
  const queryKey: PrChecksKey = [
    "git.prChecks",
    threadId,
    target === undefined ? null : prKey(target),
    prDetailStamp(git, boundPr),
  ];
  return { queryKey, queryFn: () => api.prChecks(threadId), retry: false as const };
};

/**
 * `placeholderData` that keeps the last checks in the menu while the same PR's are fetched again,
 * and never another PR's: after a bind, rebind or unbind the menu is empty until its own land.
 */
export const keepSamePrChecks =
  (queryKey: PrChecksKey) =>
  (
    previous: PrChecksResult | undefined,
    previousQuery: Pick<Query, "queryKey"> | undefined,
  ): PrChecksResult | undefined => {
    const before = previousQuery?.queryKey;
    return queryKey[2] !== null && before?.[1] === queryKey[1] && before[2] === queryKey[2]
      ? previous
      : undefined;
  };
