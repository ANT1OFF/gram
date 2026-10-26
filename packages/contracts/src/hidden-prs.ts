// When a PR the user hid from the strip (`Thread.hiddenPrs`) asks to be seen again. The web app
// reads it to draw the strip; the server reads it to narrow each entry as badges are published, so
// something that cleared and came back counts as new even while no window shows the thread.
import { samePr, type HiddenPr } from "./domain.ts";
import { requiredChecksOf, type PrStatus } from "./git.ts";

/** The badge fields attention is read from. */
export type PrAttentionSource = Pick<PrStatus, "state" | "checks"> & {
  readonly requiredChecks?: PrStatus["requiredChecks"] | undefined;
  readonly headRefOid?: string | undefined;
  readonly mergeState?: string | undefined;
  readonly reviewDecision?: string | undefined;
  readonly review?: PrStatus["review"] | undefined;
};

/**
 * What on an open PR needs the user, as keys that change when it is new again: required checks
 * failing on this head, the bot's change request from this round, a change request standing on this head,
 * conflicts. A badge fetched by number carries no bot review unless a review monitor is on it, so
 * the head is what tells its rounds apart.
 */
export function prAttentionOf(status: PrAttentionSource | undefined): readonly string[] {
  if (status?.state !== "OPEN") return [];
  const head = status.headRefOid ?? "";
  return [
    ...(requiredChecksOf(status) === "failing" ? [`ci:${head}`] : []),
    ...(status.review?.verdictOnHead === "changesRequested"
      ? [`bot:${status.review.latestReviewId ?? head}`]
      : []),
    ...(status.reviewDecision === "CHANGES_REQUESTED" ? [`changes:${head}`] : []),
    ...(status.mergeState === "DIRTY" ? ["conflicts"] : []),
  ];
}

/** The entry that hides a PR as it stands: what needs the user now won't bring it back. */
export function hiddenEntryOf(
  pr: Pick<HiddenPr, "repo" | "number">,
  status: PrAttentionSource | undefined,
): HiddenPr {
  const seen = prAttentionOf(status);
  return {
    repo: pr.repo,
    number: pr.number,
    ...(status === undefined ? {} : { state: status.state }),
    ...(seen.length === 0 ? {} : { seen }),
  };
}

/**
 * A hidden PR asks to be seen again: something needs the user that didn't when it was last
 * narrowed, or it is open again after being closed or merged. Merging is never a reason.
 */
export function resurfaces(hidden: HiddenPr, status: PrAttentionSource | undefined): boolean {
  if (status === undefined) return false;
  if (status.state === "OPEN" && hidden.state !== undefined && hidden.state !== "OPEN") return true;
  const seen = hidden.seen ?? [];
  return prAttentionOf(status).some((key) => !seen.includes(key));
}

const PR_URL = /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i;

const sameEntry = (a: HiddenPr, b: HiddenPr) =>
  a.state === b.state &&
  (a.seen ?? []).length === (b.seen ?? []).length &&
  (a.seen ?? []).every((key) => b.seen?.includes(key));

/**
 * `hidden` with each entry that still stays hidden brought up to its PR's badge, so a key that clears
 * (checks passing again, conflicts resolved) is forgotten and its return brings the row back.
 * Entries asking to be seen are left alone, as are PRs with no badge. `undefined` when nothing moved.
 */
export function narrowHiddenPrs(
  hidden: readonly HiddenPr[],
  badges: readonly PrStatus[],
): readonly HiddenPr[] | undefined {
  let changed = false;
  const next = hidden.map((entry) => {
    const badge = badges.find((pr) => {
      const match = PR_URL.exec(pr.url);
      return match !== null && samePr(entry, { repo: match[1]!, number: Number(match[2]) });
    });
    if (badge === undefined || resurfaces(entry, badge)) return entry;
    const fresh = hiddenEntryOf(entry, badge);
    // A badge that didn't read the reviews can't say the bot's change request cleared.
    const kept =
      badge.reviewUnread === true
        ? (entry.seen ?? []).filter((key) => key.startsWith("bot:") && !fresh.seen?.includes(key))
        : [];
    const narrowed =
      kept.length === 0 ? fresh : { ...fresh, seen: [...(fresh.seen ?? []), ...kept] };
    if (sameEntry(entry, narrowed)) return entry;
    changed = true;
    return narrowed;
  });
  return changed ? next : undefined;
}
