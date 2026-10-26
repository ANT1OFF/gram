import type { PrReviewState } from "@gram/contracts";
import { BOT_DISPLAY } from "@/components/pr-marks-model";
import { cn } from "@/lib/utils";
import { Swap } from "@/motion";

export type ReviewGlyphKind =
  | "inFlight"
  | "blockers"
  | "approved"
  | "changesRequested"
  | "findings"
  | "reviewerThreads";

export interface ReviewGlyphState {
  kind: ReviewGlyphKind;
  label: string;
  count?: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The bot's part of the glyph, before people's threads are added. */
function botGlyphOf(review: PrReviewState): ReviewGlyphState | undefined {
  const { blockers, unresolved } = review.threads;
  if (review.roundInFlight) return { kind: "inFlight", label: "Review bot: round in progress" };
  if (blockers > 0) {
    return {
      kind: "blockers",
      label: `Review bot: ${plural(blockers, "blocker")}`,
      count: blockers,
    };
  }
  if (review.verdictOnHead === "approved") {
    return {
      kind: "approved",
      label:
        unresolved > 0
          ? `Review bot: approved, ${plural(unresolved, "open finding")}`
          : "Review bot: approved",
    };
  }
  if (review.verdictOnHead === "changesRequested") {
    return { kind: "changesRequested", label: "Review bot: changes requested" };
  }
  if (unresolved > 0) {
    return {
      kind: "findings",
      label: `Review bot: ${plural(unresolved, "open finding")}`,
      count: unresolved,
    };
  }
  return undefined;
}

/**
 * The review glyph for a PR; `undefined` when nothing needs saying. Precedence: a running round (its
 * result is about to replace everything else), then open blockers, then the verdict on head (approved
 * stays green despite open suggestions; changes requested with only untagged findings is still red),
 * then any unresolved bot finding (amber, since tags are optional), then people's open threads.
 * People's threads always get their own line in the label.
 */
export function reviewGlyphOf(review: PrReviewState | undefined): ReviewGlyphState | undefined {
  if (!review) return undefined;
  const human = review.threads.humanUnresolved ?? 0;
  const humanLabel = `Reviewers: ${plural(human, "open thread")}`;
  const bot = botGlyphOf(review);
  if (bot) return human > 0 ? { ...bot, label: `${bot.label}\n${humanLabel}` } : bot;
  if (human > 0) return { kind: "reviewerThreads", label: humanLabel, count: human };
  return undefined;
}

/** `quiet` is a bot that has been on the PR and has nothing open, which only a chip has room to say. */
type ReviewStatusKind = ReviewGlyphKind | "quiet";

export interface ReviewStatus {
  kind: ReviewStatusKind;
  label: string;
  /** A word or two for beside the icon. */
  text: string;
}

const textOf = ({ kind, count = 0 }: ReviewGlyphState): string => {
  switch (kind) {
    case "inFlight":
      return "reviewing";
    case "blockers":
      return plural(count, "blocker");
    case "approved":
      return "approved";
    case "changesRequested":
      return "changes requested";
    case "findings":
      return plural(count, "finding");
    case "reviewerThreads":
      return plural(count, "thread");
  }
};

/**
 * The glyph's state in words, for a place with room for them. Unlike the glyph it also speaks for a
 * bot with nothing open, so a repository that has one always shows where its review stands; a PR no
 * configured bot has touched stays `undefined`, people's open threads on it or not.
 */
export function reviewStatusOf(review: PrReviewState | undefined): ReviewStatus | undefined {
  if (!review || review.bots.length === 0) return undefined;
  const glyph = reviewGlyphOf(review);
  if (glyph) return { kind: glyph.kind, label: glyph.label, text: textOf(glyph) };
  return review.reviewedHead
    ? { kind: "quiet", label: "Review bot: nothing open on the head commit", text: "no findings" }
    : {
        kind: "quiet",
        label: "Review bot: hasn't reviewed the head commit",
        text: "awaiting review",
      };
}

/** The PR vocabulary's bot marks. */
const DISPLAY = BOT_DISPLAY;

/** A small bot glyph beside a PR badge; renders nothing without a bot review. */
export function ReviewGlyph({
  review,
  className,
}: {
  review: PrReviewState | undefined;
  className?: string;
}) {
  const state = reviewGlyphOf(review);
  if (!state) return null;
  const display = DISPLAY[state.kind];
  return (
    <span
      role="img"
      aria-label={state.label}
      title={state.label}
      data-testid="review-glyph"
      data-state={state.kind}
      className={cn("inline-flex shrink-0 items-center gap-0.5", display.tone, className)}
    >
      <Swap swapKey={state.kind}>
        <display.icon aria-hidden className="size-3" />
      </Swap>
      {state.count !== undefined && <span className="tabular-nums">{state.count}</span>}
    </span>
  );
}

/** A review status as icon and words, the contents of a chip. */
export function ReviewStatusLabel({
  status,
  textClassName,
}: {
  status: ReviewStatus;
  /** On the words only, e.g. to drop them where the chip gets narrow. */
  textClassName?: string;
}) {
  const display = DISPLAY[status.kind];
  return (
    <>
      <display.icon aria-hidden className={cn("size-3.5 shrink-0", display.tone)} />
      <span className={textClassName}>{status.text}</span>
    </>
  );
}
