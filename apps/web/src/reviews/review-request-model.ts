import type { ReviewRequest } from "@gram/contracts";

import { statusCached } from "./pr-list-model";

import { prFactsOfListPr } from "@/components/pr-facts";
import { botAsksChanges, reviewMarkOf } from "@/components/pr-marks-model";
import { formatRelative } from "@/lib/time";

/** One repository's review requests, or open PRs. */
export interface ReviewRequestGroup<T extends { repo: string } = ReviewRequest> {
  /** `owner/name`. */
  repo: string;
  requests: T[];
}

/**
 * Requests under their repository. Groups and rows keep the order they arrive in, most recently
 * updated first, so the repository with the latest activity leads.
 */
export function groupByRepo<T extends { repo: string }>(
  requests: readonly T[],
): ReviewRequestGroup<T>[] {
  const groups = new Map<string, ReviewRequestGroup<T>>();
  for (const request of requests) {
    const key = request.repo.toLowerCase();
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { repo: request.repo, requests: [request] });
    else group.requests.push(request);
  }
  return [...groups.values()];
}

/** How long the PR has been open, as `3d`; `undefined` when GitHub gave no usable date. */
export function reviewRequestAge(
  request: Pick<ReviewRequest, "createdAt">,
  now = Date.now(),
): string | undefined {
  const opened = Date.parse(request.createdAt ?? "");
  return Number.isNaN(opened) ? undefined : formatRelative(opened, now);
}

/**
 * The author as a row shows it. An Enterprise Managed User's login ends in `_<shortcode>`, the same
 * for everyone in the enterprise, and an ordinary login can't hold an underscore, so whatever
 * follows the last one is dropped. The hover card keeps the full login.
 */
export const displayAuthor = (login: string): string => login.replace(/_[a-z0-9]+$/i, "") || login;

/**
 * Why a review can wait: the author has something to fix first. `undefined` for a PR that is ready
 * to be looked at. Read from the row's PR facts, as its marks are: a bot's verdict on an earlier
 * commit doesn't count (`botAsksChanges`), since the fix may be in.
 */
export function reviewRequestWaitingOn(request: ReviewRequest): string | undefined {
  if (statusCached(request)) return undefined;
  const facts = prFactsOfListPr(request);
  if (facts.checks === "failing") return "Checks are failing";
  if (botAsksChanges(facts.bot)) return "The review bot requested changes";
  if (reviewMarkOf(facts)?.kind === "changes") return "A reviewer requested changes";
  return undefined;
}
