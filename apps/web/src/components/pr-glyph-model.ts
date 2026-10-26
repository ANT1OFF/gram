import type { ChecksRollup } from "@gram/contracts";
import type { LucideIcon } from "lucide-react";

import {
  botAsksChanges,
  CHECKS_DISPLAY,
  checksMarkOf,
  MERGE_DISPLAY,
  mergeMarksOf,
  PR_STATE_DISPLAY,
  prStateMarkOf,
  REVIEW_DISPLAY,
  reviewMarkOf,
  type MergeMarkKind,
  type PrFacts,
} from "./pr-marks-model";

// One glyph per pull request, for places with room for one mark: the sidebar's thread rows and its
// review-request and open-PR lists, the overview's chips, the PR strip's rows and the badge. It
// folds the PR vocabulary's marks (`pr-marks-model.ts`) into the one that matters most, so it can't
// disagree with them. Its colour says how the PR stands; the words are its card's and its name's.

export type PrGlyphKind =
  | "failing"
  | "changes"
  | "conflicts"
  | "pending"
  | "open"
  | "ready"
  | "draft"
  | "merged"
  | "closed"
  | "unknown";

/**
 * What a glyph is drawn from: a PR's facts (`pr-facts.ts`), as a badge, a list row or a card has
 * them.
 */
export type PrGlyphSource = Pick<
  PrFacts,
  | "state"
  | "isDraft"
  | "headMatches"
  | "checks"
  | "requiredChecks"
  | "mergeState"
  | "baseRef"
  | "reviewDecision"
  | "intent"
  | "dependsOn"
> & {
  /** The review bot's mark; one that asks for changes (`botAsksChanges`) is a change request. */
  readonly bot?: { readonly kind: string } | undefined;
};

export interface PrGlyphState {
  kind: PrGlyphKind;
  /** A word or two, capitalised, for the card: "Ready", "Checks failing". */
  word: string;
}

/** The checks that gate the merge, as `requiredChecksOf` reads them; absent until looked up. */
const gatingChecks = (pr: PrGlyphSource): ChecksRollup | undefined =>
  pr.checks === undefined ? undefined : (pr.requiredChecks ?? pr.checks);

const CHANGES_WORD = reviewMarkOf({ reviewDecision: "CHANGES_REQUESTED" })!.word;

/** The merge marks that leave the glyph open but say what its merge waits on, worst first. */
const MERGE_WAITS: ReadonlySet<MergeMarkKind> = new Set([
  "refused",
  "held",
  "waiting",
  "behind",
  "blocked",
  "armed",
]);

/**
 * How the PR stands, from its marks: its state (`prLifecycleOf`), then among open ones, worst first,
 * failing gating checks, a change request from people or the review bot, conflicts with its base,
 * running checks, a review still required, then what its merge waits on (`mergeMarksOf`). A draft
 * stays a draft whatever its checks say. The words are the marks' own.
 */
export function prGlyphOf(pr: PrGlyphSource | undefined): PrGlyphState {
  if (pr === undefined) return { kind: "unknown", word: "Status unknown" };
  const state = prStateMarkOf(pr);
  if (state.kind !== "open") return { kind: state.kind, word: state.word };
  const checks = gatingChecks(pr);
  if (checks === "failing") return { kind: "failing", word: checksMarkOf(checks).word };
  const review = reviewMarkOf(pr);
  if (review?.kind === "changes" || botAsksChanges(pr.bot)) {
    return { kind: "changes", word: CHANGES_WORD };
  }
  const merge = mergeMarksOf(pr);
  const conflicts = merge.find((mark) => mark.kind === "conflicts");
  if (conflicts !== undefined) return { kind: "conflicts", word: conflicts.word };
  if (checks === "pending") return { kind: "pending", word: checksMarkOf(checks).word };
  if (pr.reviewDecision === "REVIEW_REQUIRED" && review !== undefined) {
    return { kind: "open", word: review.word };
  }
  const waits = merge.find((mark) => MERGE_WAITS.has(mark.kind));
  if (waits !== undefined) return { kind: "open", word: waits.word };
  if (checks === undefined) return { kind: "open", word: state.word };
  return { kind: "ready", word: "Ready" };
}

export interface PrGlyphDisplay {
  icon: LucideIcon;
  tone: string;
}

/**
 * The PR vocabulary's marks (`pr-marks-model.ts`): its state's while nothing is wrong, green open,
 * grey draft, purple merged, red closed. Trouble shows as its own mark instead: failing checks,
 * people's change request, conflicts with its base.
 */
export const PR_GLYPH_DISPLAY: Record<PrGlyphKind, PrGlyphDisplay> = {
  failing: CHECKS_DISPLAY.failing,
  changes: REVIEW_DISPLAY.changes,
  conflicts: MERGE_DISPLAY.conflicts,
  // Checks that gate the merge still running: the checks' own running mark.
  pending: CHECKS_DISPLAY.pending,
  open: PR_STATE_DISPLAY.open,
  ready: PR_STATE_DISPLAY.open,
  draft: PR_STATE_DISPLAY.draft,
  merged: PR_STATE_DISPLAY.merged,
  closed: PR_STATE_DISPLAY.closed,
  unknown: { icon: PR_STATE_DISPLAY.open.icon, tone: "text-muted-foreground" },
};

/** Which PR a row with several shows: the one most in need of the user. */
const PRIORITY: readonly PrGlyphKind[] = [
  "failing",
  "changes",
  "conflicts",
  "pending",
  "open",
  "ready",
  "unknown",
  "draft",
  "merged",
  "closed",
];

export const worstPrGlyph = <T extends { glyph: PrGlyphState }>(prs: readonly T[]): T | undefined =>
  prs.reduce<T | undefined>(
    (worst, pr) =>
      worst === undefined || PRIORITY.indexOf(pr.glyph.kind) < PRIORITY.indexOf(worst.glyph.kind)
        ? pr
        : worst,
    undefined,
  );

const lower = (text: string) => `${text[0]!.toLowerCase()}${text.slice(1)}`;

/**
 * The glyph in words, capitalised: "Ready, checks passing". The gating checks are named in the
 * checks mark's words, unless the state already says them or no longer depends on them, or there
 * are none. `fixing`: its worker will fix the failing checks, which the words then say.
 */
export function prGlyphWords(
  pr: PrGlyphSource | undefined,
  { fixing = false }: { fixing?: boolean } = {},
): string {
  const glyph = prGlyphOf(pr);
  const checks = pr === undefined ? undefined : gatingChecks(pr);
  const settled = glyph.kind === "merged" || glyph.kind === "closed";
  if (checks === undefined || checks === "none" || settled) return glyph.word;
  const mark = checksMarkOf(checks, { fixing, required: pr?.requiredChecks !== undefined });
  const words = mark.kind === "fixing" ? mark.detail : mark.word;
  if (glyph.word.startsWith("Checks")) return mark.kind === "fixing" ? words : glyph.word;
  return `${glyph.word}, ${lower(words)}`;
}

/** The glyph's accessible name for one PR: "PR #120 ready, checks passing". */
export const prGlyphLabel = (
  number: number,
  pr: PrGlyphSource | undefined,
  options?: { fixing?: boolean },
): string => `PR #${number} ${lower(prGlyphWords(pr, options))}`;
