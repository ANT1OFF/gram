import {
  resurfaces,
  type BoundPr,
  type GitState,
  type HiddenPr,
  type PrCheckRun,
  type PrStatus,
} from "@gram/contracts";

import { prFactsOfBadge } from "@/components/pr-facts";
import { prUrlOf, type PrFacts } from "@/components/pr-marks-model";
import {
  ifTarget,
  prTargetOf,
  samePrIdentity,
  targetBadge,
  type PrIdentity,
} from "@/panels/pr-identity";

export type CheckBucketKind = "failed" | "running" | "passed" | "skipped";

export interface CheckBucket {
  kind: CheckBucketKind;
  label: string;
  count: number;
}

const BUCKET_LABEL: Record<CheckBucketKind, string> = {
  failed: "Failed",
  running: "Running",
  passed: "Passed",
  skipped: "Skipped",
};

const BUCKET_ORDER: readonly CheckBucketKind[] = ["failed", "running", "passed", "skipped"];

const bucketOf = (run: PrCheckRun): CheckBucketKind => {
  switch (run.status) {
    case "failing":
      return "failed";
    case "pending":
      return "running";
    case "passing":
      return "passed";
    // Cancelled, skipped and neutral conclusions all count as not having run to a verdict.
    case "neutral":
      return "skipped";
  }
};

/** The PR's checks counted per outcome, worst first; outcomes nothing landed in are left out. */
export function checkBuckets(runs: readonly PrCheckRun[]): readonly CheckBucket[] {
  const counts = new Map<CheckBucketKind, number>();
  for (const run of runs) counts.set(bucketOf(run), (counts.get(bucketOf(run)) ?? 0) + 1);
  return BUCKET_ORDER.flatMap((kind) => {
    const count = counts.get(kind);
    return count === undefined ? [] : [{ kind, label: BUCKET_LABEL[kind], count }];
  });
}

/** What the row knows from the badge: its state, checks, review and merge. */
export type PrRowStatus = Pick<PrStatus, "state" | "isDraft" | "checks" | "headMatches"> & {
  readonly requiredChecks?: PrStatus["requiredChecks"] | undefined;
  readonly mergeState?: string | undefined;
  readonly review?: PrStatus["review"] | undefined;
  readonly reviewDecision?: string | undefined;
  readonly headRefOid?: string | undefined;
};

/**
 * What a row's repository and branch are, apart from its PR. A thread's PRs needn't come from the
 * checkout it runs in, so each row says for itself whether the folder and terminal apply to it.
 */
export interface PrRowPlace {
  /** `owner/repo`. */
  fullRepo: string | undefined;
  /** The repository's short name, without its owner. */
  repo: string | undefined;
  /** The repository's page, on whichever host the PR's URL names. */
  repoUrl: string | undefined;
  branch: string | undefined;
  /** The thread's checkout is a clone of this repository. */
  localRepo: boolean;
  /** This branch is the one checked out where the thread runs. */
  localBranch: boolean;
}

/** What the card over a row's number says; absent fields are left out of it. */
export interface PrRowCard {
  title: string | undefined;
  author: string | undefined;
  /** Epoch ms of GitHub's `updatedAt`. */
  updatedAt: number | undefined;
  additions: number | undefined;
  deletions: number | undefined;
  changedFiles: number | undefined;
}

/** What one row above the composer shows, all of it from the binding and the badge. */
export interface PrRow extends PrRowPlace, PrRowCard {
  number: number;
  url: string | undefined;
  status: PrRowStatus | undefined;
  /** The badge as the PR vocabulary's facts, with the binding's merge intent, for its glyph. */
  facts: PrFacts | undefined;
  bound: boolean;
}

const shortRepo = (repo: string | undefined): string | undefined => repo?.split("/").at(-1);

const REPO_URL = /^https?:\/\/[^/]+\/[\w.-]+\/[\w.-]+(?=\/pull\/\d+)/i;

const placeOf = (
  fullRepo: string | undefined,
  branch: string | undefined,
  url: string | undefined,
  git: GitState | undefined,
): PrRowPlace => {
  const localRepo =
    fullRepo !== undefined &&
    git?.origin !== undefined &&
    fullRepo.toLowerCase() === git.origin.toLowerCase();
  return {
    fullRepo,
    repo: shortRepo(fullRepo),
    repoUrl:
      (url === undefined ? undefined : REPO_URL.exec(url)?.[0]) ??
      (fullRepo === undefined ? undefined : `https://github.com/${fullRepo}`),
    branch,
    localRepo,
    localBranch: localRepo && branch !== undefined && branch === git?.branch,
  };
};

const stampOf = (iso: string | undefined): number | undefined => {
  const at = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isNaN(at) ? undefined : at;
};

/**
 * The thread's PR row: the bound PR when there is one, else the branch's. `pr-identity` decides what
 * counts as that PR, and the badge says the rest: it rides every sweep, so the row costs GitHub
 * nothing of its own. Until a bound PR's first badge lands the row is its number and repository.
 */
export function prRowOf(
  boundPr: BoundPr | undefined,
  git: GitState | undefined,
): PrRow | undefined {
  const target = prTargetOf(git, boundPr);
  if (target === undefined) return undefined;
  const { number } = target;
  const repo = target.repo ?? git?.origin;
  const badge = targetBadge(git, boundPr);
  // `git.branch` is the PR's branch only when the badge came from this checkout's branch lookup,
  // not when the server swapped in a PR bound from another repository.
  const ownBranch =
    badge !== undefined &&
    (boundPr === undefined ||
      git?.origin === undefined ||
      samePrIdentity({ repo: git.origin, number }, target))
      ? git?.branch
      : undefined;
  const url = badge?.url;
  return {
    number,
    ...placeOf(repo, badge?.headRef ?? ownBranch, url, git),
    url,
    status: badge,
    facts: badge === undefined ? undefined : prFactsOfBadge(repo ?? "", number, badge, boundPr),
    title: badge?.title || undefined,
    author: badge?.author || undefined,
    updatedAt: stampOf(badge?.updatedAt),
    additions: badge?.additions,
    deletions: badge?.deletions,
    changedFiles: badge?.changedFiles,
    bound: boundPr !== undefined,
  };
}

/** A PR the thread follows beside its own: what the badge knows, and nothing the detail would add. */
export interface ExtraPrRow extends PrRowPlace, PrRowCard {
  /** `owner/repo`, as the unfollow and watch calls need it. */
  fullRepo: string;
  number: number;
  url: string;
  status: PrRowStatus | undefined;
  /** The badge as the PR vocabulary's facts, with the binding's merge intent, for its glyph. */
  facts: PrFacts | undefined;
  /** The agent is told when this PR's checks settle. */
  monitor: boolean;
}

/**
 * One row per followed PR, in the order they were bound. Its badge is the one `pr-identity` calls the
 * same PR, and is absent until the server's first lookup lands.
 */
export function extraRowsOf(
  extraPrs: readonly BoundPr[] | undefined,
  git: GitState | undefined,
): readonly ExtraPrRow[] {
  return (extraPrs ?? []).map((extra) => {
    const badge = git?.extraPrs?.find((pr) => ifTarget(extra, pr) !== undefined);
    const url = prUrlOf({ ...extra, url: badge?.url });
    // A followed PR is never this checkout's branch, so merged and closed always show.
    const status = badge === undefined ? undefined : { ...badge, headMatches: true };
    return {
      ...placeOf(extra.repo, badge?.headRef, url, git),
      fullRepo: extra.repo,
      number: extra.number,
      url,
      title: badge?.title || undefined,
      author: badge?.author,
      updatedAt: stampOf(badge?.updatedAt),
      additions: badge?.additions,
      deletions: badge?.deletions,
      changedFiles: badge?.changedFiles,
      status,
      facts:
        status === undefined ? undefined : prFactsOfBadge(extra.repo, extra.number, status, extra),

      monitor: extra.monitor,
    };
  });
}

/** One row of the strip: the thread's own PR, or one it follows. */
export type StripItem = (
  | { readonly kind: "own"; readonly row: PrRow }
  | { readonly kind: "extra"; readonly row: ExtraPrRow }
) & {
  /** The user hid it, and something new about it needs them. */
  readonly resurfaced: boolean;
};

export interface StripLayout {
  /** The rows to draw, the thread's own first when it is among them. */
  readonly visible: readonly StripItem[];
  /** Rows the user hid that nothing has brought back. */
  readonly hidden: number;
}

const hiddenEntryFor = (
  row: PrRow | ExtraPrRow,
  hiddenPrs: readonly HiddenPr[] | undefined,
): HiddenPr | undefined => {
  const identity: PrIdentity = { repo: row.fullRepo, number: row.number };
  if (identity.repo === undefined) return undefined;
  return hiddenPrs?.find((hidden) => samePrIdentity(hidden, identity));
};

/** Which of the thread's rows the strip draws, and how many it keeps hidden. */
export function stripLayout(
  row: PrRow | undefined,
  extras: readonly ExtraPrRow[],
  hiddenPrs: readonly HiddenPr[] | undefined,
): StripLayout {
  const items: StripItem[] = [];
  let hidden = 0;
  const add = (item: StripItem["row"], place: (resurfaced: boolean) => StripItem) => {
    const entry = hiddenEntryFor(item, hiddenPrs);
    if (entry === undefined) items.push(place(false));
    else if (resurfaces(entry, item.status)) items.push(place(true));
    else hidden += 1;
  };
  if (row !== undefined) add(row, (resurfaced) => ({ kind: "own", row, resurfaced }));
  for (const extra of extras) {
    add(extra, (resurfaced) => ({ kind: "extra", row: extra, resurfaced }));
  }
  return { visible: items, hidden };
}

/**
 * Whether the strip draws the thread's own PR, whose number, state and review the header's PR
 * chips would then say a second time.
 */
export const ownPrOnStrip = (
  boundPr: BoundPr | undefined,
  git: GitState | undefined,
  hiddenPrs: readonly HiddenPr[] | undefined,
): boolean => stripLayout(prRowOf(boundPr, git), [], hiddenPrs).visible.length > 0;

/**
 * The rows a folded strip still shows: the first, and any hidden row that came back because it
 * needs the user, which a fold mustn't swallow again.
 */
export const foldedRows = (visible: readonly StripItem[]): readonly StripItem[] =>
  visible.filter((item, index) => index === 0 || item.resurfaced);
