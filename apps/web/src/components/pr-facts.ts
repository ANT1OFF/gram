import {
  checksOf,
  workerOwnsCiFix,
  type BoundPr,
  type CiFixWorker,
  type FeatureCardPr,
  type PrStatus,
  type WorkerPr,
} from "@gram/contracts";

import { reviewStatusOf } from "@/components/review-glyph";

import type { MergeIntentSource, PrFacts } from "./pr-marks-model";

// What each place that knows a PR knows of it, as the vocabulary's `PrFacts`: a badge with its
// binding, a ledger row with its worker, or a card's chip.

/** A binding's `merge_when_ready`, its refusal only while the head it was refused on is current. */
const intentOf = (
  bound: Pick<BoundPr, "mergeWhenReady"> | undefined,
  head: string | undefined,
): MergeIntentSource | undefined => {
  const intent = bound?.mergeWhenReady;
  if (intent === undefined) return undefined;
  return {
    hold: intent.hold,
    heldBy: intent.heldBy,
    after: intent.after,
    refused: intent.failedOn !== undefined && intent.failedOn === head,
  };
};

/** A badge, or the part of one a followed PR's row keeps. */
export type BadgeLike = Pick<PrStatus, "state" | "isDraft" | "checks" | "headMatches"> & {
  readonly [K in Exclude<keyof PrStatus, "state" | "isDraft" | "checks" | "headMatches">]?:
    | PrStatus[K]
    | undefined;
};

/**
 * A badge as facts, with what its binding adds: the merge intent and dependencies, which only the
 * binding of that very PR carries. `repo` is `owner/repo`.
 */
export function prFactsOfBadge(
  repo: string,
  number: number,
  badge: BadgeLike,
  bound?: Pick<BoundPr, "number" | "mergeWhenReady" | "dependsOn"> | undefined,
): PrFacts {
  const binding = bound?.number === number ? bound : undefined;
  return {
    repo,
    number,
    title: badge.title || undefined,
    branch: badge.headRef,
    state: badge.state,
    isDraft: badge.isDraft,
    headMatches: badge.headMatches,
    checks: badge.checks,
    requiredChecks: badge.requiredChecks,
    mergeState: badge.mergeState,
    baseRef: badge.baseRef,
    reviewDecision: badge.reviewDecision,
    reviewRequests: badge.reviewRequests,
    bot: reviewStatusOf(badge.review),
    peopleThreads: badge.review?.threads.humanUnresolved ?? 0,
    additions: badge.additions,
    deletions: badge.deletions,
    changedFiles: badge.changedFiles,
    intent: intentOf(binding, badge.headRefOid),
    dependsOn: binding?.dependsOn?.map((dependency) => ({
      repo: dependency.repo,
      number: dependency.number,
      state: dependency.seen?.state,
      mergeAfter: dependency.mergeAfter,
    })),
  };
}

/**
 * What a ledger row adds to a PR's facts: its merge intent and dependencies as the server read them,
 * and whether its worker will fix its failing CI (CI ownership), so it reads as being fixed.
 */
export function ledgerPrFacts(
  pr: WorkerPr,
  worker: CiFixWorker | undefined,
): Pick<PrFacts, "intent" | "dependsOn" | "ciFixing" | "mergeState"> {
  const intent = pr.mergeWhenReady;
  return {
    mergeState: pr.mergeState,
    intent:
      intent === undefined
        ? undefined
        : {
            hold: intent.hold,
            heldBy: intent.heldBy,
            after: intent.after,
            refused: intent.refused === true,
          },
    dependsOn: pr.dependsOn,
    ciFixing: checksOf(pr.checks) === "failing" && workerOwnsCiFix(worker, pr),
  };
}

/** A card's chip as facts: its state and required checks only. */
export const prFactsOfCard = (pr: FeatureCardPr): PrFacts => ({
  repo: pr.repo,
  number: pr.number,
  state: pr.state,
  checks: pr.checks,
});

/** What a review-request or own-PR list row knows of an open PR. */
export interface ListPrSource {
  readonly repo: string;
  readonly number: number;
  readonly title?: string | undefined;
  readonly isDraft?: boolean | undefined;
  readonly headRef?: string | undefined;
  readonly checks?: PrStatus["checks"] | undefined;
  readonly mergeState?: string | undefined;
  readonly reviewDecision?: string | undefined;
  readonly bot?: { readonly verdict: string; readonly onHead: boolean } | undefined;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
}

const listBot = (bot: ListPrSource["bot"]): PrFacts["bot"] => {
  if (bot === undefined) return undefined;
  if (!bot.onHead) {
    return {
      kind: "quiet",
      label: "Review bot: reviewed an earlier commit",
      text: "earlier review",
    };
  }
  if (bot.verdict === "approved") {
    return { kind: "approved", label: "Review bot: approved", text: "approved" };
  }
  if (bot.verdict === "changesRequested") {
    return {
      kind: "changesRequested",
      label: "Review bot: changes requested",
      text: "changes requested",
    };
  }
  return { kind: "quiet", label: "Review bot: commented", text: "commented" };
};

/** A list row's open PR as facts. */
export const prFactsOfListPr = (pr: ListPrSource): PrFacts => ({
  repo: pr.repo,
  number: pr.number,
  title: pr.title,
  branch: pr.headRef,
  state: "OPEN",
  isDraft: pr.isDraft,
  checks: pr.checks,
  mergeState: pr.mergeState,
  reviewDecision: pr.reviewDecision,
  bot: listBot(pr.bot),
  additions: pr.additions,
  deletions: pr.deletions,
});
