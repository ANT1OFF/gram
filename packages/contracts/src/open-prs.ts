// The Open PRs list as the user sees it, reconciled from the poll's own PRs and the badges the
// threads carry. The sidebar and `list_open_prs` both go through `reconcileOpenPrs`, so an agent is
// never told of a list other than the one on screen.

import type { Thread } from "./domain.ts";
import { repoFromPrUrl, type GitState, type PrStatus } from "./git.ts";
import type { ThreadId } from "./ids.ts";
import { prOwner, prOwnerCandidate, type OwnPr } from "./review-requests.ts";

/** A row of the Open PRs list: the PR, and the thread that owns it when one does. */
export type OpenPrRow = OwnPr & { readonly owner?: ThreadId | undefined };

/** What `reconcileOpenPrs` reads of a thread: who it is, and its live git state. */
export interface OpenPrThread {
  readonly thread: Pick<
    Thread,
    "id" | "role" | "boundPr" | "extraPrs" | "checkout" | "currentCheckout" | "lastActivityAt"
  >;
  readonly git?: Pick<GitState, "branch" | "origin" | "pr" | "extraPrs"> | undefined;
  /** Its project's origin, standing in while no git state has been published. */
  readonly origin?: string | undefined;
}

const urlKey = (url: string) => url.toLowerCase();

/** The PR badges a thread's git state carries, its extra PRs' included. */
const badgesOf = (git: OpenPrThread["git"]): PrStatus[] => [
  ...(git?.pr === undefined ? [] : [git.pr]),
  ...(git?.extraPrs ?? []),
];

/** The review bot as a row shows it, from a badge's review state; absent when it says nothing. */
const botOf = (badge: PrStatus): OwnPr["bot"] =>
  badge.review?.latestVerdict === undefined
    ? undefined
    : { verdict: badge.review.latestVerdict, onHead: badge.review.reviewedHead };

/** A thread's badge as a row, for an open PR the search didn't return. */
export function badgeRow(badge: PrStatus): OwnPr | undefined {
  const repo = repoFromPrUrl(badge.url);
  if (repo === undefined) return undefined;
  const bot = botOf(badge);
  return {
    repo,
    number: badge.number,
    title: badge.title,
    url: badge.url,
    isDraft: badge.isDraft,
    updatedAt: badge.updatedAt ?? "",
    ...(badge.headRef === undefined ? {} : { headRef: badge.headRef }),
    ...(badge.headRefOid === undefined ? {} : { headOid: badge.headRefOid }),
    ...(badge.mergeState === undefined ? {} : { mergeState: badge.mergeState }),
    ...(badge.stale === undefined ? {} : { detailsStale: true }),
    checks: badge.checks,
    ...(badge.reviewDecision === undefined ? {} : { reviewDecision: badge.reviewDecision }),
    ...(bot === undefined ? {} : { bot }),
  };
}

/**
 * The badge saw GitHub later than `stamp`, the PR's `updatedAt` as the read it is compared with
 * saw it. Neither read says when it ran, and a quiet thread's badge can be ten minutes old
 * (`lookupEvery`), so the PR's own `updatedAt` decides: only a badge that saw a change that read
 * hadn't is newer. A tie goes to the poll, which ran on a schedule a badge's lookup needn't have
 * kept, and a badge carried over failed refreshes is never newer.
 */
const badgeNewerThan = (stamp: string, badge: PrStatus): boolean =>
  badge.stale === undefined &&
  badge.updatedAt !== undefined &&
  badge.updatedAt.localeCompare(stamp) > 0;

/** The badge knows the PR's state, title and draft flag better than the poll (`updatedAt`). */
export const badgeIsNewer = (pr: Pick<OwnPr, "updatedAt">, badge: PrStatus): boolean =>
  badgeNewerThan(pr.updatedAt, badge);

/**
 * The polled PR with what a newer badge says of it, each part against the read it came from: the
 * title and draft flag against `updatedAt`, and the checks, merge state and reviews against
 * `detailsAt`, which is older when the lookup was refused and its details carried. A badge whose
 * lookup didn't read the reviews leaves the poll's bot verdict, but on the head the poll read it
 * on only while the badge's head is still that one: a push since makes it an earlier commit's.
 */
export function withBadge(pr: OwnPr, badge: PrStatus | undefined): OwnPr {
  if (badge === undefined) return pr;
  const state = badgeIsNewer(pr, badge);
  const marks = badgeNewerThan(pr.detailsAt ?? pr.updatedAt, badge);
  if (!state && !marks) return pr;
  const stamped = {
    ...pr,
    ...(state ? { title: badge.title || pr.title, isDraft: badge.isDraft } : {}),
    updatedAt: state ? (badge.updatedAt ?? pr.updatedAt) : pr.updatedAt,
  };
  if (!marks) return stamped;
  const {
    mergeState: _mergeState,
    reviewDecision: _decision,
    bot: _bot,
    headOid: _headOid,
    detailsStale: _detailsStale,
    ...rest
  } = stamped;
  const sameHead = badge.headRefOid !== undefined && badge.headRefOid === pr.headOid;
  const bot =
    badge.reviewUnread !== true
      ? botOf(badge)
      : pr.bot === undefined
        ? undefined
        : { verdict: pr.bot.verdict, onHead: pr.bot.onHead && sameHead };
  const headOid = badge.headRefOid ?? pr.headOid;
  return {
    ...rest,
    ...(badge.updatedAt === undefined ? {} : { detailsAt: badge.updatedAt }),
    ...(headOid === undefined ? {} : { headOid }),
    checks: badge.checks,
    ...((badge.mergeState ?? pr.mergeState) === undefined
      ? {}
      : { mergeState: badge.mergeState ?? pr.mergeState }),
    ...(badge.reviewDecision === undefined ? {} : { reviewDecision: badge.reviewDecision }),
    ...(bot === undefined ? {} : { bot }),
  };
}

/**
 * Whether `badge` says more of its PR than `held` does: one carried over failed refreshes loses to
 * one that isn't, and between those the later `updatedAt` wins. A tie keeps `held`, which came
 * from the more recently active thread.
 */
const fresherBadge = (badge: PrStatus, held: PrStatus): boolean => {
  if ((badge.stale === undefined) !== (held.stale === undefined)) return badge.stale === undefined;
  return (badge.updatedAt ?? "").localeCompare(held.updatedAt ?? "") > 0;
};

/**
 * The Open PRs list: the poll's PRs, each with the thread that owns it, and the open PRs the
 * threads carry badges for that the poll didn't return, such as someone else's PR bound to a
 * thread or one opened since the last poll. A PR a newer badge says merged or closed is gone
 * already. Threads in any order: the most recently active wins a tie, both for owning a PR
 * (`prOwner`) and for speaking for it. Most recently updated first.
 */
export function reconcileOpenPrs(
  listed: ReadonlyArray<OwnPr>,
  threads: Iterable<OpenPrThread>,
): OpenPrRow[] {
  const byActivity = [...threads].toSorted(
    (a, b) => b.thread.lastActivityAt - a.thread.lastActivityAt,
  );
  const candidates = byActivity.flatMap(
    ({ thread, git, origin }) => prOwnerCandidate(thread, git, origin) ?? [],
  );
  const badges = new Map<string, PrStatus>();
  // Two threads can carry the same PR's badge, read at different times; the freshest speaks for
  // it, whoever owns it, so an old OPEN badge can't hide a later MERGED one.
  for (const { git } of byActivity) {
    for (const badge of badgesOf(git)) {
      const held = badges.get(urlKey(badge.url));
      if (held === undefined || fresherBadge(badge, held)) badges.set(urlKey(badge.url), badge);
    }
  }
  const owned = (pr: OwnPr): OpenPrRow => {
    const owner = prOwner(pr, candidates);
    return owner === undefined ? pr : { ...pr, owner };
  };
  const rows = listed.flatMap((pr) => {
    const badge = badges.get(urlKey(pr.url));
    badges.delete(urlKey(pr.url));
    if (badge !== undefined && badge.state !== "OPEN" && badgeIsNewer(pr, badge)) return [];
    return [owned(withBadge(pr, badge))];
  });
  for (const badge of badges.values()) {
    const row = badge.state === "OPEN" ? badgeRow(badge) : undefined;
    if (row !== undefined) rows.push(owned(row));
  }
  return rows.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
