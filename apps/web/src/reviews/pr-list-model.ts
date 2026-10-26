import type { OwnPr, ReviewRequest } from "@gram/contracts";

export type PrInformation = Pick<
  OwnPr,
  | "repo"
  | "number"
  | "title"
  | "updatedAt"
  | "createdAt"
  | "author"
  | "isBot"
  | "labelsCount"
  | "labels"
  | "additions"
  | "deletions"
  | "informationAt"
  | "informationStale"
  | "detailsAt"
  | "detailsStale"
  | "headRef"
  | "mergeState"
  | "checks"
  | "reviewDecision"
  | "bot"
> & { readonly isDraft?: boolean };
export type PrSort = "recent" | "oldest" | "size";
export type PrFilter = "all" | "draft" | "ready" | "failing" | "pending" | "unknown" | "none";
export interface PrListOptions {
  search: string;
  sort: PrSort;
  filter: PrFilter;
}
export const DEFAULT_PR_OPTIONS: PrListOptions = { search: "", sort: "recent", filter: "all" };

export const informationCached = (pr: PrInformation): boolean =>
  pr.informationStale === true ||
  (pr.informationAt !== undefined && pr.informationAt < pr.updatedAt);
export const statusCached = (
  pr: Pick<ReviewRequest, "detailsAt" | "detailsStale" | "updatedAt">,
): boolean =>
  pr.detailsStale === true || (pr.detailsAt !== undefined && pr.detailsAt < pr.updatedAt);
export const changeSize = (pr: PrInformation): number | undefined =>
  pr.additions === undefined || pr.deletions === undefined || informationCached(pr)
    ? undefined
    : pr.additions + pr.deletions;
const activity = (pr: PrInformation): number | undefined => {
  const date = Date.parse(pr.updatedAt);
  return Number.isNaN(date) ? undefined : date;
};

/** Local presentation only; membership and notification policy stay with the server. Stable ties preserve incoming order. */
export function selectPrs<T extends PrInformation>(prs: readonly T[], options: PrListOptions): T[] {
  const terms = options.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return prs
    .filter((pr) => {
      const haystack = [pr.title, pr.repo, `#${pr.number}`, pr.author ?? "", ...(pr.labels ?? [])]
        .join(" ")
        .toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return false;
      switch (options.filter) {
        case "draft":
          return pr.isDraft === true;
        case "ready":
          return pr.isDraft === false;
        case "failing":
          return !statusCached(pr) && pr.checks === "failing";
        case "pending":
          return !statusCached(pr) && pr.checks === "pending";
        case "none":
          return !statusCached(pr) && pr.checks === "none";
        case "unknown":
          return statusCached(pr) || pr.checks === undefined;
        default:
          return true;
      }
    })
    .toSorted((a, b) => {
      const left = options.sort === "size" ? changeSize(a) : activity(a);
      const right = options.sort === "size" ? changeSize(b) : activity(b);
      if (left === undefined) return right === undefined ? 0 : 1;
      if (right === undefined) return -1;
      return options.sort === "oldest" ? left - right : right - left;
    });
}
