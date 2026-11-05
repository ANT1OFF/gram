import { actionsJobSelection, repoFromPrUrl, type PrDetail } from "@gram/contracts";

import {
  botAsksChanges,
  reviewMarkOf,
  type BotMarkKind,
  type MergeMarkKind,
} from "@/components/pr-marks-model";

// What stands between an open PR and its merge, as the PR panel knows it, worst first, and the one
// next step for the worst. The order is the PR vocabulary's (`worstPrMark`): failing checks, then
// conflicts, then changes people asked for, then the review bot's, then a review still missing.

export type MergeBlockerKind = "checks" | "conflicts" | "changes" | "bot" | "review" | "required";

/** The next step for a blocker, which the panel's summary offers as its one primary button. */
export type BlockerAction =
  /** Open the failing check's job evidence, under Checks. */
  | { readonly kind: "inspectCheck"; readonly label: string; readonly check: string }
  /** A failing check on another provider: open its page there. */
  | { readonly kind: "openCheck"; readonly label: string; readonly url: string }
  /** Show the review that asked for changes: its comment under Conversation, else the Review tab. */
  | {
      readonly kind: "readChanges";
      readonly label: string;
      readonly where: "conversation" | "review";
    }
  /** The review bot's blockers, on the Review tab. */
  | { readonly kind: "openReview"; readonly label: string }
  /** Ask the thread's agent to merge the base in and resolve the conflicts. */
  | { readonly kind: "fixConflicts"; readonly label: string }
  /** Nobody has been asked to review yet: open the Request review form. */
  | { readonly kind: "requestReview"; readonly label: string };

export interface MergeBlocker {
  readonly kind: MergeBlockerKind;
  /** A few words for the "Blocked: …" line: "1 failing check". */
  readonly word: string;
  /** Its own line in the summary, naming what the word counts: "test (windows) failing". */
  readonly detail: string;
  readonly action?: BlockerAction | undefined;
}

/** What the blockers are read from: the PR's detail, the fields a test leaves out optional. */
export type BlockerSource = Pick<PrDetail, "reviewDecision" | "checkRuns"> &
  Partial<
    Pick<
      PrDetail,
      | "author"
      | "baseRefName"
      | "conversation"
      | "headRefOid"
      | "latestReviews"
      | "reviewRequests"
      | "url"
    >
  >;

/** The review bot's status on the PR's badge, as `reviewStatusOf` reads it. */
export interface BotSource {
  readonly kind: BotMarkKind;
  readonly label: string;
  readonly text: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type CheckRun = PrDetail["checkRuns"][number];

const isFailing = (run: CheckRun) =>
  run.status === "failing" && run.conclusion?.toUpperCase() !== "CANCELLED";

/** "a failing", "a and b failing", "a and 2 more failing". */
const failingText = (names: readonly string[]): string => {
  const [first = "", second] = names;
  if (names.length === 1) return `${first} failing`;
  if (names.length === 2) return `${first} and ${second} failing`;
  return `${first} and ${names.length - 1} more failing`;
};

/** Whether the panel's Checks section can show the check's job evidence (`CiCheckDetail`). */
const inspectable = (run: CheckRun, detail: BlockerSource): boolean => {
  const repo = detail.url === undefined ? undefined : repoFromPrUrl(detail.url);
  return (
    repo !== undefined &&
    actionsJobSelection(run.link, repo) !== undefined &&
    /^[a-f0-9]{40}$/i.test(detail.headRefOid ?? "")
  );
};

const checkAction = (run: CheckRun, detail: BlockerSource): BlockerAction | undefined => {
  if (inspectable(run, detail)) {
    return { kind: "inspectCheck", label: `Inspect ${run.name} job`, check: run.name };
  }
  if (/^https?:\/\//.test(run.link)) {
    return { kind: "openCheck", label: `Open ${run.name}`, url: run.link };
  }
  return undefined;
};

/**
 * Everything the panel knows stands in the way of merging an open, non-draft PR, worst first; empty
 * when nothing does. `merge` is where GitHub says the merge stands (the badge's merge mark), `bot`
 * the review bot's status on the PR.
 */
export function mergeBlockersOf(
  detail: BlockerSource,
  merge: MergeMarkKind | undefined,
  bot?: BotSource | undefined,
): readonly MergeBlocker[] {
  const blockers: MergeBlocker[] = [];

  // Required checks first: they are the ones GitHub holds the merge for.
  const failing = detail.checkRuns
    .filter(isFailing)
    .toSorted((a, b) => Number(a.required === false) - Number(b.required === false));
  const worst = failing[0];
  if (worst !== undefined) {
    blockers.push({
      kind: "checks",
      word: plural(failing.length, "failing check"),
      detail: failingText(failing.map((run) => run.name)),
      action: checkAction(worst, detail),
    });
  }

  if (merge === "conflicts") {
    blockers.push({
      kind: "conflicts",
      word: "conflicts",
      detail: `Conflicts with ${detail.baseRefName ?? "its base"}`,
      action: { kind: "fixConflicts", label: "Ask agent to fix conflicts" },
    });
  }

  if (detail.reviewDecision === "CHANGES_REQUESTED") {
    const by = (detail.latestReviews ?? [])
      .filter((review) => review.state === "CHANGES_REQUESTED" && review.author !== detail.author)
      .map((review) => review.author);
    const inConversation = (detail.conversation ?? []).some(
      (comment) => comment.kind === "review" && comment.state === "CHANGES_REQUESTED",
    );
    blockers.push({
      kind: "changes",
      word: "changes requested",
      detail:
        reviewMarkOf({ reviewDecision: detail.reviewDecision, changesRequestedBy: by })?.detail ??
        "Changes requested",
      action: {
        kind: "readChanges",
        label: "Read requested changes",
        where: inConversation ? "conversation" : "review",
      },
    });
  }

  if (bot !== undefined && botAsksChanges(bot)) {
    blockers.push({
      kind: "bot",
      word: `review bot: ${bot.text}`,
      detail: bot.label.split("\n")[0] ?? bot.label,
      action: { kind: "openReview", label: "Read review findings" },
    });
  }

  // GitHub blocks for a reason the panel can't see beyond the above: name a missing review if that's it.
  if (blockers.length === 0 && merge === "blocked") {
    if (detail.reviewDecision === "REVIEW_REQUIRED") {
      const requested = detail.reviewRequests ?? [];
      blockers.push({
        kind: "review",
        word: "review required",
        detail:
          reviewMarkOf({ reviewDecision: "REVIEW_REQUIRED", reviewRequests: requested })?.detail ??
          "Waiting on an approving review",
        action:
          requested.length === 0 ? { kind: "requestReview", label: "Request review…" } : undefined,
      });
    } else {
      blockers.push({
        kind: "required",
        word: "required reviews or checks are missing",
        detail: "GitHub requires reviews or checks this PR doesn't have yet",
      });
    }
  }
  return blockers;
}

/** The blockers in one line, "Blocked: 1 failing check, changes requested"; `undefined` for none. */
export const blockedLineOf = (blockers: readonly MergeBlocker[]): string | undefined =>
  blockers.length === 0 ? undefined : `Blocked: ${blockers.map((b) => b.word).join(", ")}`;

/** The one next step: the worst blocker's, or the next one's when the worst has none to offer. */
export const primaryBlockerAction = (
  blockers: readonly MergeBlocker[],
): BlockerAction | undefined => blockers.find((blocker) => blocker.action)?.action;

/** What the agent is asked when the user hands it a PR's conflicts. */
export const fixConflictsMessage = (number: number, base: string): string =>
  [
    `PR #${number} has merge conflicts with ${base}.`,
    `Fetch origin, merge origin/${base} into this branch and resolve the conflicts, keeping both sides' intent.`,
    "Run the checks that cover the files you touched, then push.",
  ].join(" ");
